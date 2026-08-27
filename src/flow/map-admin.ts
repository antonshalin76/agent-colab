import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  MapLearningCandidateSchema,
  MapLearningAdministration,
  type MapLearningRuntimeAuthority,
  type LearningConsumer,
  type MapLearningCandidate,
  type MapLearningProjection,
  type MapLearningRecord,
} from "./map-learning.js";
import {
  FlowEvidenceLedger,
  type LearningEvidencePurpose,
} from "./evidence-ledger.js";
import {
  validateMapProfile,
  type MapProfileExpectation,
  type MapProfileReceipt,
} from "./map-profile.js";

const PROFILE_LOCK_PATH = "docs/evidence-gated-flow-v1/map-profile-lock.json";
const MAP_MANIFEST_PATH = ".map/mapify.lock.json";
const LEARNING_RECORDS_PATH = ".map/agent-collab-admin/learning/records";
const MAX_PROFILE_LOCK_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TASK_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 1024 * 1024;
const MAX_CANDIDATE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAP_CONTROL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface MapLearningEvidenceInput {
  id: string;
  purpose: LearningEvidencePurpose;
  artifactHash: string;
  finding: unknown;
}

export interface MapLearningEvidenceClaim {
  evidenceId: string;
  requestKey: string;
  status: "running" | "retryable" | "completed" | "failed" | "abandoned";
  ownerToken: string;
  attempt: number;
  claimedAt: number;
  leaseExpiresAt: number;
  completedAt: number | null;
  failureText: string | null;
  recoveryReason: string | null;
  recoveredAt: number | null;
}

export interface MapLearningEvidenceReconciliation {
  expectedRequestKey: string;
  expectedStatus: "running" | "failed";
  expectedOwnerToken: string;
  action: "retry" | "abandon";
  reason: string;
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const OutsideScopeSchema = z.object({
  ".agents/skills/map-learn/SKILL.md": Sha256Schema,
  ".codex/hooks/agent-collab-map-gate.py": Sha256Schema,
}).strict();
const UpdateToolSchema = z.object({
  kind: z.literal("uv"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  executablePath: z.string().startsWith("/"),
  executableSha256: Sha256Schema,
}).strict();
const SandboxToolSchema = z.object({
  kind: z.literal("bubblewrap"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  executablePath: z.string().startsWith("/"),
  executableSha256: Sha256Schema,
}).strict();
const RuntimeToolSchema = z.object({
  kind: z.literal("mapify-cli"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  toolRoot: z.string().startsWith("/"),
  executablePath: z.string().startsWith("/"),
  executableSha256: Sha256Schema,
  toolTreeSha256: Sha256Schema,
  pythonRealPath: z.string().startsWith("/"),
  pythonSha256: Sha256Schema,
}).strict();
const ProfileLockSchema = z.object({
  schemaVersion: z.literal("map-profile-lock/v1"),
  version: z.string().min(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sourceArchiveSha256: Sha256Schema,
  provider: z.literal("codex"),
  updateTool: UpdateToolSchema,
  sandboxTool: SandboxToolSchema,
  runtimeTool: RuntimeToolSchema,
  mapManifestSha256: Sha256Schema,
  mapConfigSha256: Sha256Schema,
  managedFileSha256: z.record(z.string().min(1), Sha256Schema),
  outsideScopeSha256: OutsideScopeSchema,
}).strict();

type MapProfileLock = z.infer<typeof ProfileLockSchema>;

export interface VerifiedMapProfile extends MapProfileReceipt {
  mapManifestSha256: string;
  mapConfigSha256: string;
  profileLockSha256: string;
  updateTool: z.infer<typeof UpdateToolSchema>;
  sandboxTool: z.infer<typeof SandboxToolSchema>;
  runtimeTool: z.infer<typeof RuntimeToolSchema>;
}

export interface MapLearningBytesInput {
  taskPacketBytes: Uint8Array;
  handoffBytes: Uint8Array;
  candidateBytes: Uint8Array;
}

export interface MapLearningCloseReceipt {
  profile: VerifiedMapProfile;
  record: MapLearningRecord;
}

export interface MapLearningProjectionReceipt {
  profile: VerifiedMapProfile;
  projection: MapLearningProjection;
}

export interface MapLearningLaunchBinding {
  schemaVersion: "map-learning-launch-binding/v1";
  consumer: LearningConsumer;
  projectionBase64: string;
  digest: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintMapRuntimeToolTree(root: string): string {
  if (!isAbsolute(root) || !existsSync(root) || !lstatSync(root).isDirectory() ||
      lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("MAP runtime tool root must be a canonical absolute directory");
  }
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      const metadata = lstatSync(path);
      hash.update(`${relativePath}:${metadata.mode & 0o777}:`);
      if (metadata.isDirectory()) {
        hash.update("directory\n");
        visit(path);
      } else if (metadata.isSymbolicLink()) {
        hash.update(`symlink:${readlinkSync(path)}\n`);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(path);
        hash.update(`file:${bytes.length}:`);
        hash.update(bytes);
        hash.update("\n");
      } else {
        throw new Error(`unsupported file in MAP runtime tool tree: ${relativePath}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

export interface MapRuntimeToolTreeExpectation {
  executableSha256: string;
  toolTreeSha256: string;
  pythonRealPath: string;
  pythonSha256: string;
}

export function assertMapRuntimeToolTreeIdentity(
  root: string,
  expectation: MapRuntimeToolTreeExpectation,
): void {
  const executablePath = join(root, "bin/mapify");
  const executableMetadata = lstatSync(executablePath);
  const pythonRealPath = realpathSync(join(root, "bin/python"));
  const pythonMetadata = lstatSync(pythonRealPath);
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink() ||
      realpathSync(executablePath) !== executablePath ||
      (executableMetadata.mode & 0o111) === 0 ||
      sha256(readFileSync(executablePath)) !== expectation.executableSha256 ||
      pythonRealPath !== expectation.pythonRealPath ||
      !pythonMetadata.isFile() || pythonMetadata.isSymbolicLink() ||
      realpathSync(pythonRealPath) !== pythonRealPath ||
      (pythonMetadata.mode & 0o111) === 0 ||
      sha256(readFileSync(pythonRealPath)) !== expectation.pythonSha256 ||
      fingerprintMapRuntimeToolTree(root) !== expectation.toolTreeSha256) {
    throw new Error("MAP runtime tool tree does not match the checked-in executable identity");
  }
}

function canonicalProjectRoot(rootInput: string): string {
  if (rootInput.length === 0 || rootInput.trim() !== rootInput) {
    throw new Error("MAP administration project root must be a non-empty exact path");
  }
  const absolute = resolve(rootInput);
  let cursor = parse(absolute).root;
  for (const component of relative(cursor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) throw new Error(`MAP administration project root is missing: ${absolute}`);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`MAP administration project root crosses a symbolic link: ${cursor}`);
    }
  }
  if (!lstatSync(absolute).isDirectory()) {
    throw new Error(`MAP administration project root is not a directory: ${absolute}`);
  }
  if (realpathSync(absolute) !== absolute) {
    throw new Error(`MAP administration project root is not canonical: ${absolute}`);
  }
  return absolute;
}

function requireSafeRelativePath(candidate: string): void {
  if (
    candidate.length === 0
    || candidate.includes("\\")
    || candidate.includes("\0")
    || isAbsolute(candidate)
    || /^[A-Za-z]:/u.test(candidate)
    || posix.normalize(candidate) !== candidate
    || candidate.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`MAP administration path is not a canonical relative path: ${candidate}`);
  }
}

function containedTarget(root: string, relativePath: string): string {
  requireSafeRelativePath(relativePath);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`MAP administration path escapes the project root: ${relativePath}`);
  }
  return target;
}

function readContainedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const target = containedTarget(root, relativePath);
  let cursor = root;
  for (const component of relativePath.split("/")) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) throw new Error(`${label} is missing: ${relativePath}`);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} crosses a symbolic link: ${relativePath}`);
    }
  }
  const metadata = lstatSync(target);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${relativePath}`);
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} exceeds its allowed byte size`);
  }
  if (realpathSync(target) !== target) throw new Error(`${label} is not canonical: ${relativePath}`);
  return new Uint8Array(readFileSync(target));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseProfileLock(bytes: Uint8Array): MapProfileLock {
  let input: unknown;
  try {
    input = JSON.parse(decodeUtf8(bytes, "MAP profile lock"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`MAP profile lock JSON is invalid: ${error.message}`);
    throw error;
  }
  const parsed = ProfileLockSchema.safeParse(input);
  if (!parsed.success) throw new Error(`MAP profile lock schema is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function ensureContainedDirectory(root: string, relativePath: string): string {
  const target = containedTarget(root, relativePath);
  let cursor = root;
  for (const component of relativePath.split("/")) {
    cursor = join(cursor, component);
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`MAP learning administration path crosses a symbolic link: ${relativePath}`);
    }
    if (!metadata.isDirectory() || realpathSync(cursor) !== cursor) {
      throw new Error(`MAP learning administration path is not a contained directory: ${relativePath}`);
    }
  }
  return target;
}

function requireBytes(bytes: Uint8Array, maximumBytes: number, label: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} must contain between 1 and ${maximumBytes} exact bytes`);
  }
}

function parseCanonicalCandidate(bytes: Uint8Array): MapLearningCandidate {
  requireBytes(bytes, MAX_CANDIDATE_BYTES, "MAP learning candidate");
  let input: unknown;
  try {
    input = JSON.parse(decodeUtf8(bytes, "MAP learning candidate"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`MAP learning candidate JSON is invalid: ${error.message}`);
    throw error;
  }
  const parsed = MapLearningCandidateSchema.safeParse(input);
  if (!parsed.success) throw new Error(`MAP learning candidate schema is invalid: ${parsed.error.message}`);
  const candidate: MapLearningCandidate = {
    ...parsed.data,
    controlIds: [...parsed.data.controlIds].sort(),
    consumerScopes: ["codex", "grok", "claude"],
  };
  const canonicalBytes = encoder.encode(`${JSON.stringify(candidate)}\n`);
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalBytes))) {
    throw new Error("MAP learning candidate must use exact canonical JSON bytes");
  }
  return candidate;
}

function verifyCanonicalProfile(root: string): VerifiedMapProfile {
  const profileLockBytes = readContainedFile(
    root,
    PROFILE_LOCK_PATH,
    MAX_PROFILE_LOCK_BYTES,
    "MAP profile lock",
  );
  const profileLock = parseProfileLock(profileLockBytes);
  const manifestBytes = readContainedFile(
    root,
    MAP_MANIFEST_PATH,
    MAX_MANIFEST_BYTES,
    "MAP install manifest",
  );
  const mapManifestSha256 = sha256(manifestBytes);
  if (mapManifestSha256 !== profileLock.mapManifestSha256) {
    throw new Error("MAP install manifest digest does not match the checked-in profile lock");
  }
  const mapConfigSha256 = sha256(readContainedFile(
    root,
    ".map/config.yaml",
    MAX_PROFILE_LOCK_BYTES,
    "MAP project configuration",
  ));
  if (mapConfigSha256 !== profileLock.mapConfigSha256) {
    throw new Error("MAP project configuration digest does not match the checked-in profile lock");
  }
  const updateToolPath = profileLock.updateTool.executablePath;
  const updateToolMetadata = lstatSync(updateToolPath);
  if (!updateToolMetadata.isFile() || updateToolMetadata.isSymbolicLink() ||
      realpathSync(updateToolPath) !== updateToolPath || (updateToolMetadata.mode & 0o111) === 0 ||
      sha256(readFileSync(updateToolPath)) !== profileLock.updateTool.executableSha256) {
    throw new Error("MAP update tool does not match the checked-in executable identity");
  }
  const sandboxToolPath = profileLock.sandboxTool.executablePath;
  const sandboxToolMetadata = lstatSync(sandboxToolPath);
  if (!sandboxToolMetadata.isFile() || sandboxToolMetadata.isSymbolicLink() ||
      realpathSync(sandboxToolPath) !== sandboxToolPath || sandboxToolMetadata.uid !== 0 ||
      (sandboxToolMetadata.mode & 0o111) === 0 ||
      sha256(readFileSync(sandboxToolPath)) !== profileLock.sandboxTool.executableSha256) {
    throw new Error("MAP sandbox tool does not match the checked-in executable identity");
  }
  const runtimeTool = profileLock.runtimeTool;
  if (realpathSync(runtimeTool.toolRoot) !== runtimeTool.toolRoot ||
      !lstatSync(runtimeTool.toolRoot).isDirectory() || lstatSync(runtimeTool.toolRoot).isSymbolicLink() ||
      runtimeTool.executablePath !== join(runtimeTool.toolRoot, "bin/mapify")) {
    throw new Error("MAP runtime tool does not match the checked-in executable identity");
  }
  assertMapRuntimeToolTreeIdentity(runtimeTool.toolRoot, runtimeTool);
  const expectation: MapProfileExpectation = {
    version: profileLock.version,
    sourceRevision: profileLock.sourceRevision,
    sourceArchiveSha256: profileLock.sourceArchiveSha256,
    provider: profileLock.provider,
    managedFileSha256: profileLock.managedFileSha256,
    outsideScopeSha256: profileLock.outsideScopeSha256,
  };
  return {
    ...validateMapProfile(root, expectation),
    mapManifestSha256,
    mapConfigSha256,
    profileLockSha256: sha256(profileLockBytes),
    updateTool: profileLock.updateTool,
    sandboxTool: profileLock.sandboxTool,
    runtimeTool: profileLock.runtimeTool,
  };
}

export function verifyInstalledMapProfile(projectRoot: string): VerifiedMapProfile {
  return verifyCanonicalProfile(canonicalProjectRoot(projectRoot));
}

function closeMapLearningFromBytes(
  projectRoot: string,
  input: MapLearningBytesInput,
  authority: MapLearningRuntimeAuthority,
): MapLearningCloseReceipt {
  requireBytes(input.taskPacketBytes, MAX_TASK_PACKET_BYTES, "MAP learning task packet");
  requireBytes(input.handoffBytes, MAX_HANDOFF_BYTES, "MAP learning handoff");
  const candidate = parseCanonicalCandidate(input.candidateBytes);
  const root = canonicalProjectRoot(projectRoot);
  const profile = verifyCanonicalProfile(root);
  const recordsRoot = ensureContainedDirectory(root, LEARNING_RECORDS_PATH);
  const sameProfile = (): void => {
    const current = verifyCanonicalProfile(root);
    if (
      current.version !== profile.version ||
      current.sourceRevision !== profile.sourceRevision ||
      current.sourceArchiveSha256 !== profile.sourceArchiveSha256 ||
      current.provider !== profile.provider ||
      current.mapManifestSha256 !== profile.mapManifestSha256 ||
      current.mapConfigSha256 !== profile.mapConfigSha256 ||
      current.profileLockSha256 !== profile.profileLockSha256 ||
      JSON.stringify(current.updateTool) !== JSON.stringify(profile.updateTool) ||
      JSON.stringify(current.sandboxTool) !== JSON.stringify(profile.sandboxTool) ||
      JSON.stringify(current.runtimeTool) !== JSON.stringify(profile.runtimeTool) ||
      JSON.stringify(current.managedFileSha256) !== JSON.stringify(profile.managedFileSha256) ||
      JSON.stringify(current.outsideScopeSha256) !== JSON.stringify(profile.outsideScopeSha256)
    ) {
      throw new Error("MAP learning promotion profile changed during close");
    }
  };
  const registry = new MapLearningAdministration({
    controlRoot: root,
    databasePath: authority.databasePath,
    ...(authority.controlFingerprint ? { controlFingerprint: authority.controlFingerprint } : {}),
    ...(authority.promotionCheckpoint ? { promotionCheckpoint: authority.promotionCheckpoint } : {}),
  });
  if (registry.recordsRoot !== recordsRoot) {
    throw new Error("MAP learning registry path does not match the contained administration path");
  }
  const record = registry.close({
    taskPacketBytes: input.taskPacketBytes,
    handoffBytes: input.handoffBytes,
    candidate,
    mapVersion: profile.version,
    mapManifestSha256: profile.mapManifestSha256,
  });
  ensureContainedDirectory(root, LEARNING_RECORDS_PATH);
  return { profile, record };
}

export function projectMapLearning(
  projectRoot: string,
  consumer: LearningConsumer,
): MapLearningProjectionReceipt {
  const root = canonicalProjectRoot(projectRoot);
  const profile = verifyCanonicalProfile(root);
  const recordsRoot = ensureContainedDirectory(root, LEARNING_RECORDS_PATH);
  const registry = new MapLearningAdministration({
    controlRoot: root,
    databasePath: ":memory:",
  });
  if (registry.recordsRoot !== recordsRoot) {
    throw new Error("MAP learning registry path does not match the contained administration path");
  }
  const projection = registry.projection(consumer, {
    mapVersion: profile.version,
    mapManifestSha256: profile.mapManifestSha256,
  });
  ensureContainedDirectory(root, LEARNING_RECORDS_PATH);
  return { profile, projection };
}

function parseMapLearningLaunchBinding(input: unknown): MapLearningLaunchBinding {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("MAP learning launch binding is missing");
  }
  const binding = input as Record<string, unknown>;
  if (
    binding.schemaVersion !== "map-learning-launch-binding/v1" ||
    (binding.consumer !== "codex" && binding.consumer !== "grok" && binding.consumer !== "claude") ||
    typeof binding.projectionBase64 !== "string" ||
    binding.projectionBase64.length === 0 ||
    binding.projectionBase64.length > MAX_TASK_PACKET_BYTES * 2 ||
    typeof binding.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(binding.digest) ||
    Object.keys(binding).some((key) => ![
      "schemaVersion",
      "consumer",
      "projectionBase64",
      "digest",
    ].includes(key))
  ) {
    throw new Error("MAP learning launch binding is malformed");
  }
  const bytes = Buffer.from(binding.projectionBase64, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_TASK_PACKET_BYTES ||
    bytes.toString("base64") !== binding.projectionBase64 ||
    sha256(bytes) !== binding.digest
  ) {
    throw new Error("MAP learning launch projection bytes or digest are malformed");
  }
  return {
    schemaVersion: "map-learning-launch-binding/v1",
    consumer: binding.consumer,
    projectionBase64: binding.projectionBase64,
    digest: binding.digest,
  };
}

export function createMapLearningLaunchBinding(
  projectRoot: string,
  consumer: LearningConsumer,
): MapLearningLaunchBinding {
  const { projection } = projectMapLearning(projectRoot, consumer);
  return {
    schemaVersion: "map-learning-launch-binding/v1",
    consumer,
    projectionBase64: Buffer.from(projection.bytes).toString("base64"),
    digest: projection.digest,
  };
}

export function formatMapLearningLaunchBindingContext(input: unknown): string {
  const binding = parseMapLearningLaunchBinding(input);
  return `Promoted MAP learning projection for ${binding.consumer} (${binding.digest}):\n${Buffer.from(
    binding.projectionBase64,
    "base64",
  ).toString("utf8").trimEnd()}`;
}

export function assertCurrentMapLearningLaunchBinding(
  projectRoot: string,
  consumer: LearningConsumer,
  input: unknown,
  prompt: string,
): MapLearningLaunchBinding {
  const binding = parseMapLearningLaunchBinding(input);
  if (binding.consumer !== consumer) {
    throw new Error("MAP learning launch binding consumer does not match the saved provider decision");
  }
  const current = createMapLearningLaunchBinding(projectRoot, consumer);
  if (
    binding.digest !== current.digest ||
    binding.projectionBase64 !== current.projectionBase64
  ) {
    throw new Error("MAP learning projection is stale before provider launch");
  }
  const context = formatMapLearningLaunchBindingContext(binding);
  if (
    prompt.split(context).length !== 2 ||
    prompt.split("Promoted MAP learning projection for ").length !== 2
  ) {
    throw new Error("run prompt does not contain its exact MAP learning projection once");
  }
  return binding;
}

export function createCurrentMapLearningLaunchBinding(
  consumer: LearningConsumer,
): MapLearningLaunchBinding {
  return createMapLearningLaunchBinding(MAP_CONTROL_ROOT, consumer);
}

export function assertCurrentControlMapLearningLaunchBinding(
  consumer: LearningConsumer,
  input: unknown,
  prompt: string,
): MapLearningLaunchBinding {
  return assertCurrentMapLearningLaunchBinding(
    MAP_CONTROL_ROOT,
    consumer,
    input,
    prompt,
  );
}

export function verifyCurrentMapProfile(): VerifiedMapProfile {
  return verifyInstalledMapProfile(MAP_CONTROL_ROOT);
}

export function formatMapLearningContext(
  projectRoot: string,
  consumer: LearningConsumer,
): string {
  return formatMapLearningLaunchBindingContext(
    createMapLearningLaunchBinding(projectRoot, consumer),
  );
}

/** @internal */
export class ConfiguredMapControlPlane {
  private readonly evidence: FlowEvidenceLedger;
  private readonly controlRoot: string;
  private readonly authority: MapLearningRuntimeAuthority;

  constructor(databasePath: string, options?: {
    controlRoot?: string;
    controlFingerprint?: () => string;
    promotionCheckpoint?: (phase: "before_publish" | "after_publish") => void;
  }) {
    this.controlRoot = canonicalProjectRoot(options?.controlRoot ?? MAP_CONTROL_ROOT);
    this.authority = {
      databasePath,
      ...(options?.controlFingerprint ? { controlFingerprint: options.controlFingerprint } : {}),
      ...(options?.promotionCheckpoint ? { promotionCheckpoint: options.promotionCheckpoint } : {}),
    };
    this.evidence = new FlowEvidenceLedger(databasePath);
  }

  closeLearning(input: MapLearningBytesInput): MapLearningCloseReceipt {
    return closeMapLearningFromBytes(this.controlRoot, input, this.authority);
  }

  recordLearningEvidence(
    input: MapLearningEvidenceInput,
  ) {
    return this.evidence.runCanonicalAndRecord({
      ...input,
      projectRoot: this.controlRoot,
    });
  }

  inspectLearningEvidenceClaim(id: string): MapLearningEvidenceClaim | null {
    return this.evidence.inspectClaim(id);
  }

  reconcileLearningEvidenceClaim(
    id: string,
    input: MapLearningEvidenceReconciliation,
  ): MapLearningEvidenceClaim {
    return this.evidence.reconcileClaim(id, input);
  }

  close(): void {
    this.evidence.close();
  }
}

export class MapControlPlane {
  private readonly configured: ConfiguredMapControlPlane;

  constructor(databasePath: string) {
    this.configured = new ConfiguredMapControlPlane(databasePath);
  }

  closeLearning(input: MapLearningBytesInput): MapLearningCloseReceipt {
    return this.configured.closeLearning(input);
  }

  recordLearningEvidence(
    input: MapLearningEvidenceInput,
  ) {
    return this.configured.recordLearningEvidence(input);
  }

  inspectLearningEvidenceClaim(id: string): MapLearningEvidenceClaim | null {
    return this.configured.inspectLearningEvidenceClaim(id);
  }

  reconcileLearningEvidenceClaim(
    id: string,
    input: MapLearningEvidenceReconciliation,
  ): MapLearningEvidenceClaim {
    return this.configured.reconcileLearningEvidenceClaim(id, input);
  }

  close(): void {
    this.configured.close();
  }
}
