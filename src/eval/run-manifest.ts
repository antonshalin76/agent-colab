import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const providerSchema = z.enum(["grok", "codex"]);
const effortSchema = z.enum(["medium", "high", "xhigh"]);
const jsonObjectSchema = z.record(z.string(), z.json());

const policyValueSchema = z.record(z.string().min(1), providerSchema);
const hashedPolicySchema = z.object({
  value: policyValueSchema,
  hash: sha256Schema,
}).strict();

const contentProfileSchema = z.object({
  payload: jsonObjectSchema,
  hash: sha256Schema,
}).strict();

const limitsSchema = z.object({
  wallTimeoutMs: z.number().int().positive(),
  outputLimitBytes: z.number().int().positive(),
  diffLimitBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  maxProcesses: z.number().int().positive(),
  maxAttempts: z.literal(1),
}).strict();

const parityBindingSchema = z.object({
  corpusImageHash: sha256Schema,
  suiteImageHash: sha256Schema,
  caseImageHash: sha256Schema,
  promptHash: sha256Schema,
  taskImageHash: sha256Schema,
  oracleImageHash: sha256Schema,
  sourceRevision: gitObjectSchema,
  sourceTreeHash: gitObjectSchema,
  seedPatchHash: sha256Schema,
  seededImageHash: sha256Schema,
  baselinePolicyHash: sha256Schema,
  effort: effortSchema,
  limitsHash: sha256Schema,
  skillBundleHash: sha256Schema,
  functionalToolProfileHash: sha256Schema,
  environmentContractHash: sha256Schema,
  machineToolchainProfileHash: sha256Schema,
  evaluatorImplementationHash: sha256Schema,
  harnessVersion: z.string().min(1),
}).strict();

const providerIdentitySchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  cliVersion: z.string().min(1),
}).strict();

const providerArmSchema = z.object({
  armId: z.enum(["armA", "armB"]),
  provider: providerSchema,
  policy: hashedPolicySchema,
  identity: z.object({
    requested: providerIdentitySchema,
    reported: providerIdentitySchema.extend({
      provenance: z.enum(["provider_reported", "cli_reported", "command_pinned"]),
    }).strict(),
  }).strict(),
  nativeInstructionHash: sha256Schema,
  nativeToolProfile: contentProfileSchema,
  parityBinding: parityBindingSchema,
}).strict();

const skillFileSchema = z.object({
  path: z.string().min(1).refine((path) =>
    !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "skill file path must be normalized and relative"),
  sha256: sha256Schema,
}).strict();

const runManifestBodySchema = z.object({
  version: z.literal("agent-collab-eval-run-manifest-v1"),
  harnessVersion: z.string().min(1),
  cell: z.object({
    blockId: sha256Schema,
    suiteId: z.string().min(1),
    caseId: z.string().min(1),
    stage: z.string().min(1),
    repetition: z.number().int().nonnegative(),
    effort: effortSchema,
    launchOrder: z.tuple([providerSchema, providerSchema]),
  }).strict(),
  artifacts: z.object({
    corpusImageHash: sha256Schema,
    suiteImageHash: sha256Schema,
    case: z.object({
      promptHash: sha256Schema,
      taskImageHash: sha256Schema,
      oracleImageHash: sha256Schema,
      caseImageHash: sha256Schema,
    }).strict(),
    source: z.object({
      revision: gitObjectSchema,
      treeHash: gitObjectSchema,
      seedPatchHash: sha256Schema,
      seededImageHash: sha256Schema,
    }).strict(),
  }).strict(),
  baselinePolicy: hashedPolicySchema,
  skillBundle: z.object({
    files: z.array(skillFileSchema).min(1),
    hash: sha256Schema,
  }).strict(),
  functionalToolProfile: contentProfileSchema,
  environmentContract: contentProfileSchema,
  machineToolchainProfile: contentProfileSchema,
  limits: limitsSchema,
  evaluator: z.object({
    version: z.string().min(1),
    implementationHash: sha256Schema,
  }).strict(),
  arms: z.tuple([providerArmSchema, providerArmSchema]),
}).strict();

export const EvalRunManifestSchema = runManifestBodySchema.extend({
  manifestHash: sha256Schema,
}).strict();

export type EvalRunManifestBody = z.infer<typeof runManifestBodySchema>;
export type EvalRunManifest = z.infer<typeof EvalRunManifestSchema>;
export type EvalRunManifestArm = z.infer<typeof providerArmSchema>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON accepts only JSON values");
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalObject<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function computeFrozenSkillBundleHash(
  files: readonly { readonly path: string; readonly sha256: string }[],
): string {
  const parsed = z.array(skillFileSchema).min(1).parse(files);
  const ordered = [...parsed].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(ordered.map((file) => file.path)).size !== ordered.length) {
    throw new Error("skill bundle file paths must be unique");
  }
  const digest = createHash("sha256");
  for (const file of ordered) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

const parityFields = [
  "corpusImageHash",
  "suiteImageHash",
  "caseImageHash",
  "promptHash",
  "taskImageHash",
  "oracleImageHash",
  "sourceRevision",
  "sourceTreeHash",
  "seedPatchHash",
  "seededImageHash",
  "baselinePolicyHash",
  "effort",
  "limitsHash",
  "skillBundleHash",
  "functionalToolProfileHash",
  "environmentContractHash",
  "machineToolchainProfileHash",
  "evaluatorImplementationHash",
  "harnessVersion",
] as const satisfies readonly (keyof z.infer<typeof parityBindingSchema>)[];

export interface RunManifestParityReceipt {
  readonly version: "agent-collab-eval-manifest-parity-v1";
  readonly matched: boolean;
  readonly launchAllowed: boolean;
  readonly classification: "harness_confounded" | null;
  readonly mismatches: readonly string[];
  readonly bindingHash: string;
  readonly receiptHash: string;
}

export function compareRunManifestArmParity(input: unknown): RunManifestParityReceipt {
  const arms = z.tuple([providerArmSchema, providerArmSchema]).parse(input);
  const mismatches = parityFields.filter((field) =>
    arms[0].parityBinding[field] !== arms[1].parityBinding[field]);
  const matched = mismatches.length === 0;
  const body = {
    version: "agent-collab-eval-manifest-parity-v1" as const,
    matched,
    launchAllowed: matched,
    classification: matched ? null : "harness_confounded" as const,
    mismatches,
    bindingHash: hashCanonicalJson(arms.map((arm) => arm.parityBinding)),
  };
  return deepFreeze({ ...body, receiptHash: hashCanonicalJson(body) });
}

function normalizeBody(body: EvalRunManifestBody): EvalRunManifestBody {
  const normalizePolicy = (input: EvalRunManifestBody["baselinePolicy"]) => ({
    value: canonicalObject(input.value),
    hash: input.hash,
  });
  const normalizeProfile = (input: EvalRunManifestBody["functionalToolProfile"]) => ({
    payload: canonicalObject(input.payload as Record<string, JsonValue>),
    hash: input.hash,
  });
  const arms = [...body.arms]
    .sort((left, right) => left.armId.localeCompare(right.armId))
    .map((arm) => ({
      ...arm,
      policy: normalizePolicy(arm.policy),
      nativeToolProfile: normalizeProfile(arm.nativeToolProfile),
    })) as [EvalRunManifestArm, EvalRunManifestArm];
  return {
    ...body,
    baselinePolicy: normalizePolicy(body.baselinePolicy),
    skillBundle: {
      files: [...body.skillBundle.files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      hash: body.skillBundle.hash,
    },
    functionalToolProfile: normalizeProfile(body.functionalToolProfile),
    environmentContract: normalizeProfile(body.environmentContract),
    machineToolchainProfile: normalizeProfile(body.machineToolchainProfile),
    arms,
  };
}

function requireHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} hash mismatch`);
}

function expectedParityBinding(body: EvalRunManifestBody): EvalRunManifestArm["parityBinding"] {
  return {
    corpusImageHash: body.artifacts.corpusImageHash,
    suiteImageHash: body.artifacts.suiteImageHash,
    caseImageHash: body.artifacts.case.caseImageHash,
    promptHash: body.artifacts.case.promptHash,
    taskImageHash: body.artifacts.case.taskImageHash,
    oracleImageHash: body.artifacts.case.oracleImageHash,
    sourceRevision: body.artifacts.source.revision,
    sourceTreeHash: body.artifacts.source.treeHash,
    seedPatchHash: body.artifacts.source.seedPatchHash,
    seededImageHash: body.artifacts.source.seededImageHash,
    baselinePolicyHash: body.baselinePolicy.hash,
    effort: body.cell.effort,
    limitsHash: hashCanonicalJson(body.limits),
    skillBundleHash: body.skillBundle.hash,
    functionalToolProfileHash: body.functionalToolProfile.hash,
    environmentContractHash: body.environmentContract.hash,
    machineToolchainProfileHash: body.machineToolchainProfile.hash,
    evaluatorImplementationHash: body.evaluator.implementationHash,
    harnessVersion: body.harnessVersion,
  };
}

function validateBody(body: EvalRunManifestBody): void {
  const stage = body.cell.stage;
  if (!Object.hasOwn(body.baselinePolicy.value, stage)) {
    throw new Error("cell stage is absent from baseline policy");
  }
  for (const arm of body.arms) {
    if (!Object.hasOwn(arm.policy.value, stage)) {
      throw new Error(`${arm.armId} cell stage is absent from arm policy`);
    }
  }
  if (body.arms[0].armId !== "armA" || body.arms[1].armId !== "armB") {
    throw new Error("manifest arms must be armA then armB");
  }
  const armProviders = body.arms.map((arm) => arm.provider);
  if (new Set(armProviders).size !== 2) throw new Error("arm providers must be distinct");
  if (new Set(body.cell.launchOrder).size !== 2 ||
      body.cell.launchOrder.some((provider) => !armProviders.includes(provider))) {
    throw new Error("launch order must contain both arm providers exactly once");
  }

  const expectedCaseImage = hashCanonicalJson({
    promptHash: body.artifacts.case.promptHash,
    taskImageHash: body.artifacts.case.taskImageHash,
    oracleImageHash: body.artifacts.case.oracleImageHash,
  });
  requireHash(body.artifacts.case.caseImageHash, expectedCaseImage, "case image");
  requireHash(body.baselinePolicy.hash, hashCanonicalJson(body.baselinePolicy.value), "baseline policy");
  requireHash(
    body.skillBundle.hash,
    computeFrozenSkillBundleHash(body.skillBundle.files),
    "skill bundle",
  );
  requireHash(
    body.functionalToolProfile.hash,
    hashCanonicalJson(body.functionalToolProfile.payload),
    "functional tool profile",
  );
  requireHash(
    body.environmentContract.hash,
    hashCanonicalJson(body.environmentContract.payload),
    "environment contract",
  );
  requireHash(
    body.machineToolchainProfile.hash,
    hashCanonicalJson(body.machineToolchainProfile.payload),
    "machine toolchain profile",
  );
  for (const arm of body.arms) {
    requireHash(arm.policy.hash, hashCanonicalJson(arm.policy.value), `${arm.armId} policy`);
    requireHash(
      arm.nativeToolProfile.hash,
      hashCanonicalJson(arm.nativeToolProfile.payload),
      `${arm.armId} native tool profile`,
    );
  }

  const parity = compareRunManifestArmParity(body.arms);
  if (!parity.matched) {
    throw new Error(`harness confounded: ${parity.mismatches.join(",")}`);
  }
  const expected = expectedParityBinding(body);
  for (const arm of body.arms) {
    for (const field of parityFields) {
      if (arm.parityBinding[field] !== expected[field]) {
        throw new Error(`${arm.armId} ${field} artifact binding mismatch`);
      }
    }
  }
}

export function createEvalRunManifest(input: unknown): EvalRunManifest {
  const parsed = runManifestBodySchema.parse(input);
  const body = normalizeBody(parsed);
  validateBody(body);
  return deepFreeze(EvalRunManifestSchema.parse({
    ...body,
    manifestHash: hashCanonicalJson(body),
  }));
}

export const RunManifestArtifactBindingsSchema = z.object({
  manifestHash: sha256Schema,
  blockId: sha256Schema,
  corpusImageHash: sha256Schema,
  suiteImageHash: sha256Schema,
  caseImageHash: sha256Schema,
  promptHash: sha256Schema,
  taskImageHash: sha256Schema,
  oracleImageHash: sha256Schema,
  sourceRevision: gitObjectSchema,
  sourceTreeHash: gitObjectSchema,
  seedPatchHash: sha256Schema,
  seededImageHash: sha256Schema,
  baselinePolicyHash: sha256Schema,
  skillBundleHash: sha256Schema,
  functionalToolProfileHash: sha256Schema,
  environmentContractHash: sha256Schema,
  machineToolchainProfileHash: sha256Schema,
  limitsHash: sha256Schema,
  evaluatorImplementationHash: sha256Schema,
  providerArmsHash: sha256Schema,
  harnessVersion: z.string().min(1),
}).strict();

export type RunManifestArtifactBindings = z.infer<typeof RunManifestArtifactBindingsSchema>;

export function createRunManifestArtifactBindings(
  manifestInput: EvalRunManifest,
): RunManifestArtifactBindings {
  const manifest = EvalRunManifestSchema.parse(manifestInput);
  return deepFreeze({
    manifestHash: manifest.manifestHash,
    blockId: manifest.cell.blockId,
    corpusImageHash: manifest.artifacts.corpusImageHash,
    suiteImageHash: manifest.artifacts.suiteImageHash,
    caseImageHash: manifest.artifacts.case.caseImageHash,
    promptHash: manifest.artifacts.case.promptHash,
    taskImageHash: manifest.artifacts.case.taskImageHash,
    oracleImageHash: manifest.artifacts.case.oracleImageHash,
    sourceRevision: manifest.artifacts.source.revision,
    sourceTreeHash: manifest.artifacts.source.treeHash,
    seedPatchHash: manifest.artifacts.source.seedPatchHash,
    seededImageHash: manifest.artifacts.source.seededImageHash,
    baselinePolicyHash: manifest.baselinePolicy.hash,
    skillBundleHash: manifest.skillBundle.hash,
    functionalToolProfileHash: manifest.functionalToolProfile.hash,
    environmentContractHash: manifest.environmentContract.hash,
    machineToolchainProfileHash: manifest.machineToolchainProfile.hash,
    limitsHash: hashCanonicalJson(manifest.limits),
    evaluatorImplementationHash: manifest.evaluator.implementationHash,
    providerArmsHash: hashCanonicalJson(manifest.arms.map((arm) => ({
      armId: arm.armId,
      provider: arm.provider,
      policy: arm.policy,
      identity: arm.identity,
      nativeInstructionHash: arm.nativeInstructionHash,
      nativeToolProfile: arm.nativeToolProfile,
    }))),
    harnessVersion: manifest.harnessVersion,
  });
}

export function validatePersistedEvalRunManifest(
  persisted: unknown,
  recapturedBindings: unknown,
): EvalRunManifest {
  const parsed = EvalRunManifestSchema.parse(persisted);
  const { manifestHash, ...untrustedBody } = parsed;
  const body = normalizeBody(runManifestBodySchema.parse(untrustedBody));
  if (!isDeepStrictEqual(untrustedBody, body)) {
    throw new Error("persisted manifest is not in canonical form");
  }
  validateBody(body);
  requireHash(manifestHash, hashCanonicalJson(body), "manifest");
  const manifest = deepFreeze(EvalRunManifestSchema.parse({ ...body, manifestHash }));
  const expected = createRunManifestArtifactBindings(manifest);
  const actual = RunManifestArtifactBindingsSchema.parse(recapturedBindings);
  for (const field of Object.keys(expected) as (keyof RunManifestArtifactBindings)[]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${field} resume binding mismatch`);
    }
  }
  return manifest;
}
