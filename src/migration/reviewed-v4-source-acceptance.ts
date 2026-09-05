import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { canonicalJson } from "../domain/canonical-json.js";
import {
  inspectReviewedV4ExecutionSource,
  verifyReviewedV4Source,
  type ReviewedV4RemoteTrust,
  type ReviewedV4SourceIdentity,
} from "../flow/reviewed-v4-source.js";
import { canonicalStateDatabaseIdentity } from "../store/state-database-fence.js";
import { StateFileDurability } from "../store/state-file-durability.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import { observeLegacyDatabase } from "./state-v4-manifest.js";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ADOPTION_PATH = "migration-v4/source-acceptance/reviewed-source-adoption-v2.json";

const sourceIdentitySchema = z.object({
  commitOid: z.string().regex(SHA1),
  treeOid: z.string().regex(SHA1),
  manifestSha256: z.string().regex(SHA256),
  lastProgressEventSha256: z.string().regex(SHA256),
}).strict();
const reviewArtifactSchema = z.object({
  schemaVersion: z.literal("review-receipt/v2"),
  agent: z.literal("codex"),
  role: z.enum(["auditor", "critic"]),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceIdentity: sourceIdentitySchema.omit({ lastProgressEventSha256: true }),
  reviewVerdict: z.object({
    schemaVersion: z.literal("review-verdict/v1"),
    verdict: z.literal("PASS"),
    findings: z.array(z.object({
      risk_level: z.literal("info"),
      message: z.string(),
    }).strict()),
  }).strict(),
}).strict();
const reviewEnvelopeSchema = z.object({
  artifact: reviewArtifactSchema,
  artifactSha256: z.string().regex(SHA256),
}).strict();
const promotionDraftSchema = z.object({
  schemaVersion: z.literal("reviewed-v4-promotion/v2"),
  promotionId: z.string().min(1),
  keyId: z.string().regex(SHA256),
  operationId: z.literal("stg04-production-close"),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  plan: z.object({
    planId: z.string().min(1),
    planLockSha256: z.string().regex(SHA256),
  }).strict(),
  source: sourceIdentitySchema,
  remote: z.object({
    canonicalUrl: z.string().min(1),
    refName: z.string().min(1),
    advertisedCommitOid: z.string().regex(SHA1),
  }).strict(),
  execution: z.object({
    mode: z.literal("tsx-source"),
    entrypoint: z.literal("scripts/agent-collab-launcher.mjs"),
    entrypointBlobOid: z.string().regex(SHA1),
    entrypointSha256: z.string().regex(SHA256),
    sourceRoot: z.literal("src"),
    distAllowed: z.literal(false),
  }).strict(),
  reviews: z.tuple([reviewEnvelopeSchema, reviewEnvelopeSchema]),
}).strict();
const promotionSchema = promotionDraftSchema.extend({
  promotionSha256: z.string().regex(SHA256),
  signatureBase64: z.string().regex(BASE64),
}).strict();
const identitySchema = z.object({
  path: z.string().min(1).refine(isAbsolute),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
}).strict();
const databaseIdentitySchema = identitySchema.extend({
  userVersion: z.number().int(),
  bytesSha256: z.string().regex(SHA256),
  manifestSha256: z.string().regex(SHA256),
}).strict();
const targetSchema = z.object({
  root: identitySchema,
  state: databaseIdentitySchema,
  history: databaseIdentitySchema,
}).strict();
const adoptionDraftSchema = z.object({
  schemaVersion: z.literal("reviewed-v4-source-adoption/v2"),
  operationId: z.literal("stg04-production-close"),
  promotionSha256: z.string().regex(SHA256),
  promotion: promotionSchema,
  target: targetSchema,
  remoteObservation: z.object({
    canonicalUrl: z.string().min(1),
    refName: z.string().min(1),
    advertisedCommitOid: z.string().regex(SHA1),
    observedAt: z.string().min(1),
  }).strict(),
  adoptedAt: z.string().min(1),
}).strict();
const adoptionSchema = adoptionDraftSchema.extend({
  adoptionSha256: z.string().regex(SHA256),
}).strict();

type Promotion = z.infer<typeof promotionSchema>;
type Adoption = z.infer<typeof adoptionSchema>;

export interface ReviewedV4PromotionEvidence {
  readonly document: Readonly<Record<string, unknown>>;
  readonly promotionSha256: string;
  readonly sourceIdentity: ReviewedV4SourceIdentity;
  readonly planIdentity: { readonly planId: string; readonly planLockSha256: string };
  readonly remote: ReviewedV4RemoteTrust;
}

export interface VerifiedReviewedV4Promotion {
  readonly promotionSha256: string;
  readonly sourceIdentity: ReviewedV4SourceIdentity;
}

interface VerifiedPromotionData {
  readonly promotion: Promotion;
  readonly trust: ReviewedV4PromotionTrust;
}

const verifiedPromotions = new WeakMap<object, VerifiedPromotionData>();

const promotionEvidence = (promotion: Promotion): ReviewedV4PromotionEvidence => Object.freeze({
  document: Object.freeze(structuredClone(promotion)) as Readonly<Record<string, unknown>>,
  promotionSha256: promotion.promotionSha256,
  sourceIdentity: Object.freeze({ ...promotion.source }),
  planIdentity: Object.freeze({ ...promotion.plan }),
  remote: Object.freeze({ url: promotion.remote.canonicalUrl, ref: promotion.remote.refName }),
});

export interface SignedReviewedV4PromotionInput {
  readonly promotionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly plan: { readonly planId: string; readonly planLockSha256: string };
  readonly source: ReviewedV4SourceIdentity;
  readonly remote: ReviewedV4RemoteTrust & { readonly advertisedCommitOid: string };
  readonly execution: z.infer<typeof promotionDraftSchema>["execution"];
  readonly reviewArtifacts: readonly [unknown, unknown];
  readonly privateKeyPem: string | Buffer;
}

export interface ReviewedV4PromotionTrust {
  readonly publicKeyPem: string | Buffer;
  readonly repositoryRoot: string;
  readonly remote: ReviewedV4RemoteTrust;
}

export interface ReviewedV4SourceAcceptanceResult {
  readonly status: "accepted";
  readonly created: boolean;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly promotionSha256: string;
  readonly sourceIdentity: ReviewedV4SourceIdentity;
  readonly planIdentity: { readonly planId: string; readonly planLockSha256: string };
  readonly target: z.infer<typeof targetSchema>;
  readonly remote: ReviewedV4RemoteTrust;
}

export function verifyReviewedV4PromotionSource(input: {
  readonly externalPromotionPath: string;
  readonly trust: ReviewedV4PromotionTrust;
}): VerifiedReviewedV4Promotion {
  const promotionBytes = readDirectRegularFile(input.externalPromotionPath, "external reviewed v4 promotion");
  const trust = Object.freeze({
    publicKeyPem: Buffer.isBuffer(input.trust.publicKeyPem)
      ? Buffer.from(input.trust.publicKeyPem)
      : input.trust.publicKeyPem,
    repositoryRoot: input.trust.repositoryRoot,
    remote: Object.freeze({ ...input.trust.remote }),
  });
  const promotion = validatePromotion(promotionBytes, trust);
  const source = inspectReviewedV4ExecutionSource({
    repositoryRoot: trust.repositoryRoot,
    expected: promotion.source,
    remote: trust.remote,
  });
  verifyReviewedV4Source(source, promotion.source);
  const capability = Object.freeze({
    promotionSha256: promotion.promotionSha256,
    sourceIdentity: Object.freeze({ ...promotion.source }),
  });
  verifiedPromotions.set(capability, Object.freeze({ promotion, trust }));
  return capability;
}

export function consumeVerifiedReviewedV4Promotion(
  capability: VerifiedReviewedV4Promotion,
): ReviewedV4PromotionEvidence {
  const data = verifiedPromotions.get(capability as object);
  if (data === undefined) throw new Error("reviewed v4 promotion capability is not authentic");
  assertVerifiedPromotionSourceCurrent(data);
  return promotionEvidence(data.promotion);
}

export function verifyEmbeddedReviewedV4Promotion(input: {
  readonly document: unknown;
  readonly trust: ReviewedV4PromotionTrust;
  readonly observedAt: number;
  readonly requireCurrentSource?: boolean;
}): ReviewedV4PromotionEvidence {
  const bytes = Buffer.from(`${canonicalJson(input.document)}\n`);
  const promotion = validatePromotion(bytes, input.trust, input.observedAt);
  if (input.requireCurrentSource !== false) {
    const source = inspectReviewedV4ExecutionSource({
      repositoryRoot: input.trust.repositoryRoot,
      expected: promotion.source,
      remote: input.trust.remote,
    });
    verifyReviewedV4Source(source, promotion.source);
  }
  return promotionEvidence(promotion);
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function createSignedReviewedV4Promotion(input: SignedReviewedV4PromotionInput): Buffer {
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt < issuedAt) {
    throw new Error("reviewed v4 promotion lifetime is invalid");
  }
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(input.privateKeyPem); }
  catch (error) { throw new Error("reviewed v4 promotion private key is invalid", { cause: error }); }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("reviewed v4 promotion private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const keyId = sha256(publicKey.export({ type: "spki", format: "der" }));
  const reviews = input.reviewArtifacts.map((raw) => {
    const artifact = reviewArtifactSchema.parse(raw);
    return { artifact, artifactSha256: sha256(canonicalJson(artifact)) };
  }) as [z.infer<typeof reviewEnvelopeSchema>, z.infer<typeof reviewEnvelopeSchema>];
  const draft = promotionDraftSchema.parse({
    schemaVersion: "reviewed-v4-promotion/v2",
    promotionId: input.promotionId,
    keyId,
    operationId: "stg04-production-close",
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    plan: input.plan,
    source: input.source,
    remote: {
      canonicalUrl: input.remote.url,
      refName: input.remote.ref,
      advertisedCommitOid: input.remote.advertisedCommitOid,
    },
    execution: input.execution,
    reviews,
  });
  const promotionSha256 = sha256(canonicalJson(draft));
  const signatureBase64 = sign(
    null,
    Buffer.from(canonicalJson({ ...draft, promotionSha256 })),
    privateKey,
  ).toString("base64");
  const promotion = promotionSchema.parse({ ...draft, promotionSha256, signatureBase64 });
  return Buffer.from(`${canonicalJson(promotion)}\n`);
}

function readDirectRegularFile(path: string, label: string): Buffer {
  const absolute = resolve(path);
  if (!isAbsolute(path) || absolute !== path || realpathSync(path) !== path) {
    throw new Error(`${label} path must be absolute, canonical and no-follow`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(path);
    if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
        descriptorStat.nlink !== 1 || pathStat.nlink !== 1 ||
        descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      throw new Error(`${label} must be a regular no-follow file with link count one`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseCanonical<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is malformed`, { cause: error }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || !bytes.equals(Buffer.from(`${canonicalJson(raw)}\n`))) {
    throw new Error(`${label} is invalid or noncanonical`);
  }
  return parsed.data;
}

function trustedKey(trust: ReviewedV4PromotionTrust): { readonly key: KeyObject; readonly keyId: string } {
  let key: KeyObject;
  try { key = createPublicKey(trust.publicKeyPem); }
  catch (error) { throw new Error("reviewed v4 promotion public key is invalid", { cause: error }); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("reviewed v4 promotion public key must be Ed25519");
  const der = key.export({ type: "spki", format: "der" });
  return { key, keyId: sha256(der) };
}

function validatePromotion(bytes: Buffer, trust: ReviewedV4PromotionTrust, observedAt?: number): Promotion {
  const promotion = parseCanonical(bytes, promotionSchema, "reviewed v4 promotion");
  const { promotionSha256, signatureBase64, ...draft } = promotion;
  const signed = canonicalJson({ ...draft, promotionSha256 });
  const key = trustedKey(trust);
  if (promotionSha256 !== sha256(canonicalJson(draft)) || promotion.keyId !== key.keyId ||
      !verifySignature(null, Buffer.from(signed), key.key, Buffer.from(signatureBase64, "base64"))) {
    throw new Error("reviewed v4 promotion signature or digest is invalid");
  }
  const issuedAt = Date.parse(promotion.issuedAt);
  const expiresAt = Date.parse(promotion.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt < issuedAt ||
      (observedAt !== undefined && (observedAt < issuedAt || observedAt > expiresAt))) {
    throw new Error("reviewed v4 promotion lifetime is invalid or expired");
  }
  if (promotion.remote.canonicalUrl !== trust.remote.url || promotion.remote.refName !== trust.remote.ref ||
      promotion.remote.advertisedCommitOid !== promotion.source.commitOid) {
    throw new Error("reviewed v4 promotion is outside the configured remote trust");
  }
  const roles = promotion.reviews.map(({ artifact }) => artifact.role).sort();
  const runIds = new Set(promotion.reviews.map(({ artifact }) => artifact.runId));
  const attemptIds = new Set(promotion.reviews.map(({ artifact }) => artifact.attemptId));
  const sessionIds = new Set(promotion.reviews.map(({ artifact }) => artifact.sessionId));
  if (roles[0] !== "auditor" || roles[1] !== "critic" || runIds.size !== 2 ||
      attemptIds.size !== 2 || sessionIds.size !== 2) {
    throw new Error("reviewed v4 promotion requires distinct Codex auditor and critic evidence");
  }
  for (const review of promotion.reviews) {
    if (review.artifactSha256 !== sha256(canonicalJson(review.artifact)) ||
        canonicalJson(review.artifact.sourceIdentity) !== canonicalJson({
          commitOid: promotion.source.commitOid,
          treeOid: promotion.source.treeOid,
          manifestSha256: promotion.source.manifestSha256,
        })) {
      throw new Error("reviewed v4 promotion review evidence is outside the source binding");
    }
  }
  return promotion;
}

function verifiedPromotionData(capability: VerifiedReviewedV4Promotion): VerifiedPromotionData {
  const data = verifiedPromotions.get(capability as object);
  if (data === undefined) throw new Error("reviewed v4 promotion capability is not authentic");
  return data;
}

function assertVerifiedPromotionSourceCurrent(data: VerifiedPromotionData): void {
  const source = inspectReviewedV4ExecutionSource({
    repositoryRoot: data.trust.repositoryRoot,
    expected: data.promotion.source,
    remote: data.trust.remote,
  });
  verifyReviewedV4Source(source, data.promotion.source);
}

function targetIdentity(stateRoot: string) {
  const layout = openExistingStateLayout(stateRoot);
  const state = canonicalStateDatabaseIdentity(layout.database);
  const history = canonicalStateDatabaseIdentity(layout.historyDatabase);
  const root = statSync(layout.root);
  const stateObservation = observeLegacyDatabase(state.path, "state");
  const historyObservation = observeLegacyDatabase(history.path, "history");
  return {
    root: { path: layout.root, dev: root.dev, ino: root.ino },
    state: { path: state.path, ...state.databaseIdentity, userVersion: stateObservation.userVersion,
      bytesSha256: stateObservation.bytesSha256, manifestSha256: stateObservation.manifestSha256 },
    history: { path: history.path, ...history.databaseIdentity, userVersion: historyObservation.userVersion,
      bytesSha256: historyObservation.bytesSha256, manifestSha256: historyObservation.manifestSha256 },
  };
}

function assertTargetCurrent(target: z.infer<typeof targetSchema>, stateRoot: string): void {
  const current = targetIdentity(stateRoot);
  if (current.root.path !== target.root.path || current.root.dev !== target.root.dev || current.root.ino !== target.root.ino ||
      current.state.path !== target.state.path || current.state.dev !== target.state.dev || current.state.ino !== target.state.ino ||
      current.history.path !== target.history.path || current.history.dev !== target.history.dev ||
      current.history.ino !== target.history.ino || current.history.userVersion !== target.history.userVersion ||
      current.history.bytesSha256 !== target.history.bytesSha256 ||
      current.history.manifestSha256 !== target.history.manifestSha256 ||
      (current.state.userVersion === target.state.userVersion &&
        (current.state.bytesSha256 !== target.state.bytesSha256 || current.state.manifestSha256 !== target.state.manifestSha256)) ||
      (current.state.userVersion !== target.state.userVersion && current.state.userVersion !== 4)) {
    throw new Error("reviewed v4 source adoption target root or database identity changed");
  }
}

function validateAdoption(bytes: Buffer, trust: ReviewedV4PromotionTrust, stateRoot: string): Adoption {
  const adoption = parseCanonical(bytes, adoptionSchema, "reviewed v4 source adoption");
  const { adoptionSha256, ...draft } = adoption;
  if (adoptionSha256 !== sha256(canonicalJson(draft)) ||
      adoption.promotionSha256 !== adoption.promotion.promotionSha256) {
    throw new Error("reviewed v4 source adoption digest is invalid");
  }
  const adoptedAt = Date.parse(adoption.adoptedAt);
  if (!Number.isFinite(adoptedAt)) throw new Error("reviewed v4 source adoption timestamp is invalid");
  if (adoption.remoteObservation.canonicalUrl !== adoption.promotion.remote.canonicalUrl ||
      adoption.remoteObservation.refName !== adoption.promotion.remote.refName ||
      adoption.remoteObservation.advertisedCommitOid !== adoption.promotion.source.commitOid ||
      adoption.remoteObservation.observedAt !== adoption.adoptedAt) {
    throw new Error("reviewed v4 source adoption remote observation is outside the promoted source binding");
  }
  validatePromotion(Buffer.from(`${canonicalJson(adoption.promotion)}\n`), trust, adoptedAt);
  assertTargetCurrent(adoption.target, stateRoot);
  return adoption;
}

function result(adoption: Adoption, receiptPath: string, created: boolean): ReviewedV4SourceAcceptanceResult {
  return Object.freeze({
    status: "accepted" as const,
    created,
    receiptPath,
    receiptSha256: adoption.adoptionSha256,
    promotionSha256: adoption.promotionSha256,
    sourceIdentity: adoption.promotion.source,
    planIdentity: adoption.promotion.plan,
    target: adoption.target,
    remote: { url: adoption.promotion.remote.canonicalUrl, ref: adoption.promotion.remote.refName },
  });
}

export function adoptVerifiedReviewedV4SourceAcceptance(input: {
  readonly stateRoot: string;
  readonly verifiedPromotion: VerifiedReviewedV4Promotion;
  readonly beforeTargetIdentity?: () => void;
}): ReviewedV4SourceAcceptanceResult {
  const data = verifiedPromotionData(input.verifiedPromotion);
  const { promotion, trust } = data;
  const durability = new StateFileDurability({ stateRoot: input.stateRoot });
  try {
    return durability.withExclusiveLock({ lockBasename: "reviewed-v4-source-acceptance.lock" }, () => {
      const receiptPath = resolve(input.stateRoot, ADOPTION_PATH);
      if (existsSync(receiptPath)) {
        const pinned = durability.openPinned(ADOPTION_PATH);
        try {
          const adoption = validateAdoption(pinned.read(), trust, input.stateRoot);
          if (adoption.promotionSha256 !== promotion.promotionSha256 ||
              canonicalJson(adoption.promotion) !== canonicalJson(promotion)) {
            throw new Error("immutable reviewed v4 source adoption conflicts with the verified promotion");
          }
          assertVerifiedPromotionSourceCurrent(data);
          pinned.assertCurrent();
          return result(adoption, pinned.absolutePath, false);
        } finally { pinned.close(); }
      }

      const timestamp = new Date().toISOString();
      const adoptionTime = Date.parse(timestamp);
      if (!Number.isFinite(adoptionTime) || adoptionTime > Date.now()) {
        throw new Error("reviewed v4 source adoption timestamp is outside the current promotion lifetime");
      }
      validatePromotion(Buffer.from(`${canonicalJson(promotion)}\n`), trust, adoptionTime);
      input.beforeTargetIdentity?.();
      assertVerifiedPromotionSourceCurrent(data);
      const target = targetIdentity(input.stateRoot);
      if (target.state.userVersion !== 3 || target.history.userVersion !== 2) {
        throw new Error("reviewed v4 source adoption requires the exact pre-v4 database pair");
      }
      const draft = {
        schemaVersion: "reviewed-v4-source-adoption/v2" as const,
        operationId: promotion.operationId,
        promotionSha256: promotion.promotionSha256,
        promotion,
        target,
        remoteObservation: {
          canonicalUrl: promotion.remote.canonicalUrl,
          refName: promotion.remote.refName,
          advertisedCommitOid: promotion.source.commitOid,
          observedAt: timestamp,
        },
        adoptedAt: timestamp,
      };
      const adoption = adoptionSchema.parse({ ...draft, adoptionSha256: sha256(canonicalJson(draft)) });
      const bytes = Buffer.from(`${canonicalJson(adoption)}\n`);
      const published = durability.publishImmutable({ relativePath: ADOPTION_PATH, bytes });
      try {
        if (!published.file.read().equals(bytes)) {
          throw new Error("immutable reviewed v4 source adoption conflicts with the exact target binding");
        }
        return result(adoption, published.file.absolutePath, published.created);
      } finally { published.file.close(); }
    });
  } finally {
    durability.close();
  }
}

export function adoptReviewedV4SourceAcceptance(input: {
  readonly stateRoot: string;
  readonly externalPromotionPath: string;
  readonly trust: ReviewedV4PromotionTrust;
}): ReviewedV4SourceAcceptanceResult {
  return adoptVerifiedReviewedV4SourceAcceptance({
    stateRoot: input.stateRoot,
    verifiedPromotion: verifyReviewedV4PromotionSource(input),
  });
}

export function requireReviewedV4SourceAcceptance(input: {
  readonly stateRoot: string;
  readonly adoptionSha256: string;
  readonly trust: ReviewedV4PromotionTrust;
}): ReviewedV4SourceAcceptanceResult {
  const durability = new StateFileDurability({ stateRoot: input.stateRoot });
  try {
    const pinned = durability.openPinned(ADOPTION_PATH);
    try {
      const adoption = validateAdoption(pinned.read(), input.trust, input.stateRoot);
      if (adoption.adoptionSha256 !== input.adoptionSha256) {
        throw new Error("reviewed v4 source adoption does not match the production launch binding");
      }
      pinned.assertCurrent();
      return result(adoption, pinned.absolutePath, false);
    } finally { pinned.close(); }
  } catch (error) {
    throw new Error("required reviewed v4 source adoption is absent, invalid, or tampered", { cause: error });
  } finally {
    durability.close();
  }
}

export const consumeReviewedV4SourceAcceptance = requireReviewedV4SourceAcceptance;
