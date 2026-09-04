import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalJson, computeBytesSha256 } from "../domain/canonical-json.js";

// Decoded package JSON stays untyped until the exact protocol checks below succeed.
type DecodedJson = Record<string, any>;
type ProgressFile = { name: string; path: string };
type SeedReference = { sequence: number; path: string; fileSha256: string; eventSha256: string };

export interface VerifyImplementationProgressInput {
  root: string;
  gitRoot?: string;
  packagePath?: string;
  migrationSeedPath?: string;
}
export interface ProgressVerificationSummary {
  startSha256: string;
  progressEventCount: number;
  lastEventSha256: string;
  events: Array<{ stageId: string; terminalResult: string; eventSha256: string }>;
  migrationSeedSha256?: string;
}
export interface ImplementationProgressVerification extends ProgressVerificationSummary {
  schemaVersion: "implementation-verification/v1";
  status: "verified";
  planId: string;
  planAnchorCommit: string;
  sourceBaselineHead: string;
  commitPushScope: unknown;
  liveProviderScope: unknown;
  lastSequence: number;
  events: Array<DecodedJson & {
    stageId: string; terminalResult: string; eventSha256: string; evidenceVerified: boolean;
  }>;
}
export type VerifiedProgressEvent = DecodedJson & {
  planId: string; sequence: number; eventId: string; startSha256: string;
  previousEventSha256: string; effectivePlanSha256: string; eventSha256: string;
  recordedAt: string; eventJson: string;
};
export interface VerifiedProgressBundle {
  events: VerifiedProgressEvent[];
  lastEventSha256: string;
}

const HASH = /^[a-f0-9]{64}$/;
const PROGRESS_SEED_FILE = "STATE_V4_PROGRESS_SEED.json";
const PROGRESS_SEED_SHA256 = "741d67139b3171d5e3d678e37de09385ccc7d0bd8058d9b8d8629a27a0b22cb7";
const PROGRESS_SEED_SOURCE_COMMIT = "cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50";
const PROGRESS_SEED_SOURCE_TREE = "955260b898f2465b72ecaabcb43b1453a15e3ebc";
const readJson = (path: string): DecodedJson => JSON.parse(readFileSync(path, "utf8")) as DecodedJson;
const git = (root: string, args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const normalizePackagePath = (path: string): string => path === "R2"
  ? "docs/hybrid-flow-v1-r2" : path === "v1" ? "docs/hybrid-flow-v1" : path;
const exactKeys = (value: unknown, keys: string[]): value is DecodedJson => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
const safeArtifactPath = (root: string, path: unknown): string => {
  if (typeof path !== "string" || path.length === 0) throw new Error(`artifact path is invalid: ${String(path)}`);
  const canonicalRoot = resolve(root); const target = resolve(canonicalRoot, path);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}/`)) throw new Error(`artifact path escapes root: ${path}`);
  if (!existsSync(target)) throw new Error(`artifact does not exist: ${path}`);
  return target;
};

const validatePassEvidence = (root: string, event: DecodedJson, name: string): void => {
  if (!HASH.test(event.sourceFingerprint)) throw new Error(`sourceFingerprint is invalid: ${name}`);
  const readHashEntries = (field: "inputHashes" | "outputHashes") => {
    const entries = event[field];
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${field} must be nonempty for PASS: ${name}`);
    const seen = new Set<string>();
    return entries.map((entry: unknown) => {
      if (!exactKeys(entry, ["path", "sha256"]) || typeof entry.path !== "string" ||
          typeof entry.sha256 !== "string" || !HASH.test(entry.sha256) || seen.has(entry.path)) {
        throw new Error(`${field} entry is invalid: ${name}`);
      }
      seen.add(entry.path); const path = safeArtifactPath(root, entry.path);
      if (computeBytesSha256(readFileSync(path)) !== entry.sha256) throw new Error(`${field} artifact digest mismatch: ${entry.path}`);
      return { path: entry.path, sha256: entry.sha256 };
    });
  };
  const inputHashes = readHashEntries("inputHashes"); const outputHashes = readHashEntries("outputHashes");
  if (!Array.isArray(event.attemptIds) || event.attemptIds.length === 0 ||
      event.attemptIds.some((id: unknown) => typeof id !== "string" || id.length === 0) ||
      new Set(event.attemptIds).size !== event.attemptIds.length) throw new Error(`attemptIds are invalid for PASS: ${name}`);
  if (!Array.isArray(event.reviewReceiptHashes) || event.reviewReceiptHashes.length !== 2) {
    throw new Error(`reviewReceiptHashes must contain Codex auditor and critic: ${name}`);
  }
  const receipts = new Map<string, DecodedJson>();
  for (const receiptRef of event.reviewReceiptHashes as unknown[]) {
    if (!exactKeys(receiptRef, ["agent", "role", "attemptId", "artifactPath", "sha256"]) ||
        receiptRef.agent !== "codex" || !["auditor", "critic"].includes(receiptRef.role) ||
        typeof receiptRef.attemptId !== "string" || !receiptRef.attemptId ||
        typeof receiptRef.artifactPath !== "string" || typeof receiptRef.sha256 !== "string" ||
        !HASH.test(receiptRef.sha256) || receipts.has(receiptRef.role)) {
      throw new Error(`reviewReceiptHashes entry is invalid: ${name}`);
    }
    const receiptPath = safeArtifactPath(root, receiptRef.artifactPath);
    if (computeBytesSha256(readFileSync(receiptPath)) !== receiptRef.sha256) {
      throw new Error(`review receipt artifact digest mismatch: ${receiptRef.artifactPath}`);
    }
    const receipt = readJson(receiptPath); const verdict = receipt.reviewVerdict;
    if (receipt.schemaVersion !== "review-receipt/v1" || receipt.agent !== "codex" ||
        receipt.role !== receiptRef.role || receipt.attemptId !== receiptRef.attemptId ||
        receipt.sourceFingerprint !== event.sourceFingerprint || verdict?.schemaVersion !== "review-verdict/v1" ||
        verdict.verdict !== "PASS" || !Array.isArray(verdict.findings) ||
        verdict.findings.some((finding: DecodedJson) => finding?.risk_level !== "info")) {
      throw new Error(`review receipt is not an exact semantic PASS: ${receiptRef.artifactPath}`);
    }
    receipts.set(receiptRef.role, receiptRef);
  }
  if (!receipts.has("auditor") || !receipts.has("critic") ||
      canonicalJson([...(event.attemptIds as string[])].sort()) !==
        canonicalJson([...receipts.values()].map(({ attemptId }) => attemptId).sort())) {
    throw new Error(`attemptIds do not match Codex PASS receipts: ${name}`);
  }
  if (!exactKeys(event.commandOrOracle, ["kind", "artifactPath", "sha256"]) ||
      event.commandOrOracle.kind !== "oracle" || typeof event.commandOrOracle.artifactPath !== "string" ||
      typeof event.commandOrOracle.sha256 !== "string" || !HASH.test(event.commandOrOracle.sha256)) {
    throw new Error(`commandOrOracle must identify an exact terminal oracle for PASS: ${name}`);
  }
  const oraclePath = safeArtifactPath(root, event.commandOrOracle.artifactPath);
  if (computeBytesSha256(readFileSync(oraclePath)) !== event.commandOrOracle.sha256) {
    throw new Error(`terminal oracle digest mismatch: ${event.commandOrOracle.artifactPath}`);
  }
  const oracle = readJson(oraclePath);
  if (oracle.schemaVersion !== "terminal-oracle/v1" || oracle.stageId !== event.stageId ||
      oracle.gateId !== event.gateId || oracle.sourceFingerprint !== event.sourceFingerprint ||
      oracle.terminalResult !== "PASS") throw new Error(`terminal oracle does not match PASS event: ${name}`);
  const outputByPath = new Map(outputHashes.map((entry) => [entry.path, entry.sha256]));
  if (outputByPath.get(event.commandOrOracle.artifactPath) !== event.commandOrOracle.sha256) {
    throw new Error(`terminal oracle is not bound as output evidence: ${name}`);
  }
  const barriers = outputHashes.filter(({ path }) => {
    try { return readJson(resolve(root, path)).schemaVersion === "review-barrier-evidence/v1"; } catch { return false; }
  });
  if (barriers.length !== 1) throw new Error(`exactly one barrier evidence artifact is required for PASS: ${name}`);
  const barrier = readJson(resolve(root, barriers[0]!.path));
  if (barrier.stageId !== event.stageId || barrier.gateId !== event.gateId ||
      barrier.sourceFingerprint !== event.sourceFingerprint || barrier.satisfied !== true ||
      barrier.requiredCount !== 2 || barrier.terminalCount !== 2 || !Array.isArray(barrier.requiredReceipts) ||
      barrier.requiredReceipts.length !== 2) throw new Error(`barrier evidence does not prove exact closure: ${name}`);
  const barrierRoles = new Set<string>();
  for (const required of barrier.requiredReceipts as unknown[]) {
    const accepted = exactKeys(required, ["agent", "role", "attemptId", "receiptSha256"])
      ? receipts.get(required.role) : undefined;
    if (!exactKeys(required, ["agent", "role", "attemptId", "receiptSha256"]) || required.agent !== "codex" ||
        !accepted || barrierRoles.has(required.role) || required.attemptId !== accepted.attemptId ||
        required.receiptSha256 !== accepted.sha256) throw new Error(`barrier receipt binding mismatch: ${name}`);
    barrierRoles.add(required.role);
  }
  if (!barrierRoles.has("auditor") || !barrierRoles.has("critic")) throw new Error(`barrier does not bind both Codex PASS receipts: ${name}`);
  const referenced = new Set([...inputHashes.map(({ path }) => path), ...outputHashes.map(({ path }) => path),
    ...[...receipts.values()].map(({ artifactPath }) => artifactPath)]);
  if (!Array.isArray(event.artifactPaths) || new Set(event.artifactPaths).size !== event.artifactPaths.length ||
      canonicalJson([...(event.artifactPaths as string[])].sort()) !== canonicalJson([...referenced].sort())) {
    throw new Error(`artifactPaths do not exactly match hashed evidence: ${name}`);
  }
};

const verifyPackage = (input: VerifyImplementationProgressInput): {
  verification: ImplementationProgressVerification; progressFiles: ProgressFile[];
} => {
  const root = resolve(input.root); const gitRoot = resolve(input.gitRoot ?? root);
  const packagePath = normalizePackagePath(input.packagePath ?? "docs/hybrid-flow-v1");
  const packageRoot = resolve(root, packagePath); const lockPath = resolve(packageRoot, "PLAN_LOCK.json");
  const lockBytes = readFileSync(lockPath); const lock = JSON.parse(lockBytes.toString("utf8")) as DecodedJson;
  const start = readJson(resolve(packageRoot, "IMPLEMENTATION_START.json"));
  const expectedFields = ["schemaVersion", "planId", "normativePackageSha256", "planAnchorCommit",
    "sourceBaselineHead", "implementationHead", "branch", "worktree", "mapSha256", "routingPolicy",
    "authorityConsumer", "authorityReceiptSha256", "commitPushScope", "liveProviderScope", "startedAt", "startSha256"].sort();
  if (canonicalJson(Object.keys(start).sort()) !== canonicalJson(expectedFields)) throw new Error("start receipt fields do not match implementation-start/v1");
  if (start.schemaVersion !== "implementation-start/v1" || start.planId !== lock.planId) throw new Error("start receipt plan identity mismatch");
  if (start.normativePackageSha256 !== computeBytesSha256(lockBytes)) throw new Error("normativePackageSha256 does not match PLAN_LOCK.json");
  const withoutDigest = { ...start }; delete withoutDigest.startSha256;
  if (start.startSha256 !== computeBytesSha256(canonicalJson(withoutDigest))) throw new Error("startSha256 does not match canonical receipt bytes");
  if (start.sourceBaselineHead !== lock.sourceBaseline.sourceBaselineHead || start.routingPolicy !== lock.sourceBaseline.routingPolicy) {
    throw new Error("start receipt source or routing baseline mismatch");
  }
  if (start.mapSha256 !== lock.sourceBaseline.mapProfileLockSha256) throw new Error("start receipt MAP identity mismatch");
  for (const [path, expected] of Object.entries(lock.normativeArtifacts as DecodedJson)) {
    if (computeBytesSha256(readFileSync(resolve(root, path))) !== expected) throw new Error(`${path} digest mismatch`);
  }
  const anchor = git(gitRoot, ["cat-file", "-p", start.planAnchorCommit]);
  const parent = anchor.split("\n").find((line) => line.startsWith("parent "))?.slice(7);
  if (parent !== start.sourceBaselineHead) throw new Error("plan anchor parent does not match source baseline");
  for (const item of lock.initialPackageInventory as DecodedJson[]) {
    const bytes = execFileSync("git", ["-C", gitRoot, "show", `${start.planAnchorCommit}:${item.path}`]);
    if (computeBytesSha256(bytes) !== item.sha256) throw new Error(`plan anchor mismatch for ${item.path}`);
  }

  const progressRoot = resolve(packageRoot, "stage-close/pre-v4");
  let progressFiles: ProgressFile[]; let seedReferences: SeedReference[] | undefined;
  if (input.migrationSeedPath !== undefined) {
    const seedPath = safeArtifactPath(root, input.migrationSeedPath); const seedBytes = readFileSync(seedPath);
    if (computeBytesSha256(seedBytes) !== PROGRESS_SEED_SHA256) throw new Error("state-v4 progress seed manifest digest mismatch");
    const seed = JSON.parse(seedBytes.toString("utf8")) as DecodedJson;
    if (!exactKeys(seed, ["schemaVersion", "planId", "sourceIdentity", "startSha256", "lastEventSha256", "events"]) ||
        !exactKeys(seed.sourceIdentity, ["commitOid", "treeOid"]) || seed.schemaVersion !== "state-v4-progress-seed/v1" ||
        seed.planId !== start.planId || seed.startSha256 !== start.startSha256 ||
        seed.sourceIdentity.commitOid !== PROGRESS_SEED_SOURCE_COMMIT || seed.sourceIdentity.treeOid !== PROGRESS_SEED_SOURCE_TREE ||
        !Array.isArray(seed.events) || seed.events.length !== 3 || seed.lastEventSha256 !== seed.events.at(-1)?.eventSha256) {
      throw new Error("state-v4 progress seed manifest contract mismatch");
    }
    seedReferences = seed.events.map((reference: DecodedJson, index: number) => {
      if (!exactKeys(reference, ["sequence", "path", "fileSha256", "eventSha256"]) || reference.sequence !== index + 1 ||
          typeof reference.path !== "string" || typeof reference.fileSha256 !== "string" || typeof reference.eventSha256 !== "string" ||
          !HASH.test(reference.fileSha256) || !HASH.test(reference.eventSha256)) {
        throw new Error("state-v4 progress seed event reference is invalid");
      }
      return reference as SeedReference;
    });
    progressFiles = seedReferences.map((reference) => {
      const path = safeArtifactPath(root, reference.path);
      if (!path.startsWith(`${progressRoot}/`) || computeBytesSha256(readFileSync(path)) !== reference.fileSha256) {
        throw new Error("state-v4 progress seed event file digest or path mismatch");
      }
      return { name: reference.path.split("/").at(-1)!, path };
    });
  } else {
    progressFiles = existsSync(progressRoot) ? readdirSync(progressRoot).filter((name) => name.endsWith(".json")).sort()
      .map((name) => ({ name, path: resolve(progressRoot, name) })) : [];
  }
  let previousEventSha256 = start.startSha256; const events: ImplementationProgressVerification["events"] = [];
  const eventIdPattern = /^[A-Za-z0-9._:-]+$/;
  const terminalResults = new Set(["PASS", "FAIL", "BLOCKED", "DEGRADED_REVIEW_SET", "READY_FOR_AUTHORIZED_PUBLISH"]);
  for (const [index, entry] of progressFiles.entries()) {
    const event = readJson(entry.path); const sequence = index + 1; const match = entry.name.match(/^(\d{6})-(.+)\.json$/);
    if (!match || Number(match[1]) !== sequence || match[2] !== event.eventId || !eventIdPattern.test(event.eventId)) {
      throw new Error(`invalid progress filename or sequence: ${entry.name}`);
    }
    const expectedEventFields = ["schemaVersion", "eventId", "sequence", "previousEventSha256", "startSha256", "eventType",
      "planId", "effectivePlanSha256", "stageId", "gateId", "sourceFingerprint", "actor", "commandOrOracle", "inputHashes",
      "outputHashes", "attemptIds", "reviewReceiptHashes", "artifactPaths", "terminalResult", "recordedAt", "eventSha256"].sort();
    if (canonicalJson(Object.keys(event).sort()) !== canonicalJson(expectedEventFields)) throw new Error(`progress event fields are invalid: ${entry.name}`);
    if (event.schemaVersion !== "PlanProgressEvent/v1" || event.sequence !== sequence) throw new Error(`progress event identity mismatch: ${entry.name}`);
    if (event.previousEventSha256 !== previousEventSha256) throw new Error(`previousEventSha256 mismatch: ${entry.name}`);
    if (event.startSha256 !== start.startSha256) throw new Error(`startSha256 mismatch: ${entry.name}`);
    if (event.planId !== lock.planId || event.effectivePlanSha256 !== lock.planSha256) throw new Error(`effectivePlanSha256 mismatch: ${entry.name}`);
    if (!/^(?:R2-)?STG-(0[0-9]|1[0-2])$/.test(event.stageId) || typeof event.gateId !== "string" || !event.gateId) {
      throw new Error(`stage or gate identity mismatch: ${entry.name}`);
    }
    if (!terminalResults.has(event.terminalResult)) throw new Error(`terminalResult is invalid: ${entry.name}`);
    if (!Array.isArray(event.artifactPaths)) throw new Error(`artifactPaths are invalid: ${entry.name}`);
    for (const path of event.artifactPaths) if (typeof path !== "string" || !existsSync(resolve(root, path))) {
      throw new Error(`artifact does not exist: ${String(path)}`);
    }
    if (event.eventType === "step_completed" && event.terminalResult === "PASS") validatePassEvidence(root, event, entry.name);
    const digestInput = { ...event }; delete digestInput.eventSha256;
    const digest = computeBytesSha256(canonicalJson(digestInput));
    if (event.eventSha256 !== digest) throw new Error(`eventSha256 mismatch: ${entry.name}`);
    if (seedReferences?.[index]?.eventSha256 !== undefined && seedReferences[index]!.eventSha256 !== event.eventSha256) {
      throw new Error(`state-v4 progress seed event digest mismatch: ${entry.name}`);
    }
    previousEventSha256 = digest;
    events.push({ ...event, stageId: event.stageId, terminalResult: event.terminalResult, eventSha256: digest,
      evidenceVerified: event.eventType === "step_completed" && event.terminalResult === "PASS" });
  }
  return { progressFiles, verification: {
    schemaVersion: "implementation-verification/v1", status: "verified", planId: start.planId,
    startSha256: start.startSha256, planAnchorCommit: start.planAnchorCommit, sourceBaselineHead: start.sourceBaselineHead,
    commitPushScope: start.commitPushScope, liveProviderScope: start.liveProviderScope, progressEventCount: events.length,
    lastSequence: events.length, lastEventSha256: previousEventSha256, events,
    ...(input.migrationSeedPath === undefined ? {} : { migrationSeedSha256: PROGRESS_SEED_SHA256 }),
  } };
};

export const verifyImplementationStart = (input: VerifyImplementationProgressInput): ImplementationProgressVerification =>
  verifyPackage(input).verification;
export const verifyImplementationProgressPackage = verifyImplementationStart;

export function bindVerifiedProgressEvents(
  verification: ProgressVerificationSummary, eventPayloads: readonly string[],
): VerifiedProgressBundle {
  if (eventPayloads.length !== verification.progressEventCount) throw new Error("pre-v4 progress inventory changed after verification");
  let previousEventSha256 = verification.startSha256;
  const events = eventPayloads.map((payload, offset) => {
    const event = JSON.parse(payload) as VerifiedProgressEvent;
    const digestInput = { ...event } as DecodedJson; delete digestInput.eventSha256;
    const rereadDigest = computeBytesSha256(canonicalJson(digestInput));
    if (event.sequence !== offset + 1 || event.previousEventSha256 !== previousEventSha256 ||
        event.eventSha256 !== rereadDigest || rereadDigest !== verification.events[offset]?.eventSha256) {
      throw new Error("pre-v4 progress bytes changed after verification");
    }
    previousEventSha256 = rereadDigest; return { ...event, eventJson: canonicalJson(event) };
  });
  if (previousEventSha256 !== verification.lastEventSha256 || events.at(-1)?.eventSha256 !== verification.lastEventSha256) {
    throw new Error("pre-v4 progress terminal hash changed after verification");
  }
  return { events, lastEventSha256: verification.lastEventSha256 };
}

export function loadVerifiedMigrationProgressBundle(input: {
  repositoryRoot: string; gitRoot?: string; progressPackagePath: string; afterVerify?: () => void;
}): VerifiedProgressBundle {
  const repositoryRoot = resolve(input.repositoryRoot); const gitRoot = resolve(input.gitRoot ?? repositoryRoot);
  const packageRoot = resolve(repositoryRoot, input.progressPackagePath); const packageArgument = relative(repositoryRoot, packageRoot);
  if (packageArgument.startsWith("..")) throw new Error("progress package is outside repository root");
  const migrationSeedPath = resolve(packageRoot, PROGRESS_SEED_FILE); const hasSeed = existsSync(migrationSeedPath);
  if (!hasSeed && (git(gitRoot, ["rev-parse", "HEAD"]) !== PROGRESS_SEED_SOURCE_COMMIT ||
      git(gitRoot, ["rev-parse", "HEAD^{tree}"]) !== PROGRESS_SEED_SOURCE_TREE)) {
    throw new Error("state-v4 progress seed manifest is missing outside the exact reviewed source");
  }
  const verified = verifyPackage({ root: repositoryRoot, gitRoot, packagePath: packageArgument,
    ...(hasSeed ? { migrationSeedPath: relative(repositoryRoot, migrationSeedPath) } : {}) });
  const verification = verified.verification;
  if (verification.progressEventCount !== 3 || (hasSeed
    ? verification.migrationSeedSha256 !== PROGRESS_SEED_SHA256 : verification.migrationSeedSha256 !== undefined) ||
    verification.events.at(-1)?.stageId !== "STG-02" || verification.events.at(-1)?.terminalResult !== "PASS") {
    throw new Error("verified pre-v4 progress chain must end at STG-02 PASS");
  }
  input.afterVerify?.();
  return bindVerifiedProgressEvents(verification, verified.progressFiles.map(({ path }) => readFileSync(path, "utf8")));
}
