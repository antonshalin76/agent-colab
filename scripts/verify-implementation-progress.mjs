#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const parseArgs = (argv) => {
  const result = {
    root: process.cwd(),
    gitRoot: undefined,
    packagePath: "docs/hybrid-flow-v1",
    migrationSeedPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") result.root = resolve(argv[++index]);
    else if (flag === "--git-root") result.gitRoot = resolve(argv[++index]);
    else if (flag === "--package") result.packagePath = argv[++index];
    else if (flag === "--migration-seed") result.migrationSeedPath = argv[++index];
    else throw new Error(`unknown argument: ${flag}`);
  }
  result.gitRoot ??= result.root;
  return result;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const HASH = /^[a-f0-9]{64}$/;
const STATE_V4_PROGRESS_SEED_SHA256 = "741d67139b3171d5e3d678e37de09385ccc7d0bd8058d9b8d8629a27a0b22cb7";
const STATE_V4_REVIEWED_COMMIT = "cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50";
const STATE_V4_REVIEWED_TREE = "955260b898f2465b72ecaabcb43b1453a15e3ebc";
const normalizePackagePath = (packagePath) => packagePath === "R2"
  ? "docs/hybrid-flow-v1-r2"
  : packagePath === "v1" ? "docs/hybrid-flow-v1" : packagePath;
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
const safeArtifactPath = (root, path) => {
  if (typeof path !== "string" || path.length === 0) throw new Error(`artifact path is invalid: ${String(path)}`);
  const target = resolve(root, path);
  const prefix = `${resolve(root)}/`;
  if (target !== resolve(root) && !target.startsWith(prefix)) throw new Error(`artifact path escapes root: ${path}`);
  if (!existsSync(target)) throw new Error(`artifact does not exist: ${path}`);
  return target;
};

const validatePassEvidence = (root, event, name) => {
  if (!HASH.test(event.sourceFingerprint)) throw new Error(`sourceFingerprint is invalid: ${name}`);
  const readHashEntries = (field) => {
    const entries = event[field];
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${field} must be nonempty for PASS: ${name}`);
    const seen = new Set();
    return entries.map((entry) => {
      if (!exactKeys(entry, ["path", "sha256"]) || !HASH.test(entry.sha256) || seen.has(entry.path)) {
        throw new Error(`${field} entry is invalid: ${name}`);
      }
      seen.add(entry.path);
      const path = safeArtifactPath(root, entry.path);
      if (sha256(readFileSync(path)) !== entry.sha256) throw new Error(`${field} artifact digest mismatch: ${entry.path}`);
      return entry;
    });
  };
  const inputHashes = readHashEntries("inputHashes");
  const outputHashes = readHashEntries("outputHashes");
  if (!Array.isArray(event.attemptIds) || event.attemptIds.length === 0 ||
      event.attemptIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(event.attemptIds).size !== event.attemptIds.length) {
    throw new Error(`attemptIds are invalid for PASS: ${name}`);
  }
  if (!Array.isArray(event.reviewReceiptHashes) || event.reviewReceiptHashes.length !== 2) {
    throw new Error(`reviewReceiptHashes must contain Codex auditor and critic: ${name}`);
  }
  const receipts = new Map();
  for (const receiptRef of event.reviewReceiptHashes) {
    if (!exactKeys(receiptRef, ["agent", "role", "attemptId", "artifactPath", "sha256"]) ||
        receiptRef.agent !== "codex" || !["auditor", "critic"].includes(receiptRef.role) ||
        typeof receiptRef.attemptId !== "string" || !receiptRef.attemptId || !HASH.test(receiptRef.sha256) ||
        receipts.has(receiptRef.role)) {
      throw new Error(`reviewReceiptHashes entry is invalid: ${name}`);
    }
    const receiptPath = safeArtifactPath(root, receiptRef.artifactPath);
    if (sha256(readFileSync(receiptPath)) !== receiptRef.sha256) {
      throw new Error(`review receipt artifact digest mismatch: ${receiptRef.artifactPath}`);
    }
    const receipt = readJson(receiptPath);
    const verdict = receipt?.reviewVerdict;
    if (receipt?.schemaVersion !== "review-receipt/v1" || receipt.agent !== "codex" ||
        receipt.role !== receiptRef.role || receipt.attemptId !== receiptRef.attemptId ||
        receipt.sourceFingerprint !== event.sourceFingerprint || verdict?.schemaVersion !== "review-verdict/v1" ||
        verdict.verdict !== "PASS" || !Array.isArray(verdict.findings) ||
        verdict.findings.some((finding) => finding?.risk_level !== "info")) {
      throw new Error(`review receipt is not an exact semantic PASS: ${receiptRef.artifactPath}`);
    }
    receipts.set(receiptRef.role, receiptRef);
  }
  if (!receipts.has("auditor") || !receipts.has("critic") ||
      canonicalJson([...event.attemptIds].sort()) !== canonicalJson([...receipts.values()].map(({ attemptId }) => attemptId).sort())) {
    throw new Error(`attemptIds do not match Codex PASS receipts: ${name}`);
  }
  if (!exactKeys(event.commandOrOracle, ["kind", "artifactPath", "sha256"]) ||
      event.commandOrOracle.kind !== "oracle" || !HASH.test(event.commandOrOracle.sha256)) {
    throw new Error(`commandOrOracle must identify an exact terminal oracle for PASS: ${name}`);
  }
  const oraclePath = safeArtifactPath(root, event.commandOrOracle.artifactPath);
  if (sha256(readFileSync(oraclePath)) !== event.commandOrOracle.sha256) {
    throw new Error(`terminal oracle digest mismatch: ${event.commandOrOracle.artifactPath}`);
  }
  const oracle = readJson(oraclePath);
  if (oracle?.schemaVersion !== "terminal-oracle/v1" || oracle.stageId !== event.stageId ||
      oracle.gateId !== event.gateId || oracle.sourceFingerprint !== event.sourceFingerprint ||
      oracle.terminalResult !== "PASS") throw new Error(`terminal oracle does not match PASS event: ${name}`);

  const outputByPath = new Map(outputHashes.map((entry) => [entry.path, entry.sha256]));
  if (outputByPath.get(event.commandOrOracle.artifactPath) !== event.commandOrOracle.sha256) {
    throw new Error(`terminal oracle is not bound as output evidence: ${name}`);
  }
  const barrierEntries = outputHashes.filter(({ path }) => {
    try { return readJson(resolve(root, path))?.schemaVersion === "review-barrier-evidence/v1"; } catch { return false; }
  });
  if (barrierEntries.length !== 1) throw new Error(`exactly one barrier evidence artifact is required for PASS: ${name}`);
  const barrier = readJson(resolve(root, barrierEntries[0].path));
  if (barrier.stageId !== event.stageId || barrier.gateId !== event.gateId ||
      barrier.sourceFingerprint !== event.sourceFingerprint || barrier.satisfied !== true ||
      barrier.requiredCount !== 2 || barrier.terminalCount !== 2 || !Array.isArray(barrier.requiredReceipts) ||
      barrier.requiredReceipts.length !== 2) throw new Error(`barrier evidence does not prove exact closure: ${name}`);
  const barrierRoles = new Set();
  for (const required of barrier.requiredReceipts) {
    const accepted = receipts.get(required?.role);
    if (!exactKeys(required, ["agent", "role", "attemptId", "receiptSha256"]) ||
        required?.agent !== "codex" || !accepted || barrierRoles.has(required.role) ||
        required.attemptId !== accepted.attemptId ||
        required.receiptSha256 !== accepted.sha256) throw new Error(`barrier receipt binding mismatch: ${name}`);
    barrierRoles.add(required.role);
  }
  if (!barrierRoles.has("auditor") || !barrierRoles.has("critic")) {
    throw new Error(`barrier does not bind both Codex PASS receipts: ${name}`);
  }
  const referenced = new Set([
    ...inputHashes.map(({ path }) => path), ...outputHashes.map(({ path }) => path),
    ...[...receipts.values()].map(({ artifactPath }) => artifactPath),
  ]);
  if (!Array.isArray(event.artifactPaths) || new Set(event.artifactPaths).size !== event.artifactPaths.length ||
      canonicalJson([...event.artifactPaths].sort()) !== canonicalJson([...referenced].sort())) {
    throw new Error(`artifactPaths do not exactly match hashed evidence: ${name}`);
  }
};

export function verifyImplementationStart({
  root,
  gitRoot = root,
  packagePath = "docs/hybrid-flow-v1",
  migrationSeedPath,
}) {
  packagePath = normalizePackagePath(packagePath);
  const packageRoot = resolve(root, packagePath);
  const lockPath = resolve(packageRoot, "PLAN_LOCK.json");
  const startPath = resolve(packageRoot, "IMPLEMENTATION_START.json");
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const start = readJson(startPath);

  const expectedFields = [
    "schemaVersion", "planId", "normativePackageSha256", "planAnchorCommit",
    "sourceBaselineHead", "implementationHead", "branch", "worktree", "mapSha256",
    "routingPolicy", "authorityConsumer", "authorityReceiptSha256", "commitPushScope",
    "liveProviderScope", "startedAt", "startSha256",
  ].sort();
  const actualFields = Object.keys(start).sort();
  if (canonicalJson(actualFields) !== canonicalJson(expectedFields)) throw new Error("start receipt fields do not match implementation-start/v1");
  if (start.schemaVersion !== "implementation-start/v1" || start.planId !== lock.planId) throw new Error("start receipt plan identity mismatch");
  if (start.normativePackageSha256 !== sha256(lockBytes)) throw new Error("normativePackageSha256 does not match PLAN_LOCK.json");
  const withoutDigest = { ...start };
  delete withoutDigest.startSha256;
  if (start.startSha256 !== sha256(canonicalJson(withoutDigest))) throw new Error("startSha256 does not match canonical receipt bytes");
  if (start.sourceBaselineHead !== lock.sourceBaseline.sourceBaselineHead || start.routingPolicy !== lock.sourceBaseline.routingPolicy) {
    throw new Error("start receipt source or routing baseline mismatch");
  }
  if (start.mapSha256 !== lock.sourceBaseline.mapProfileLockSha256) throw new Error("start receipt MAP identity mismatch");

  for (const [path, expected] of Object.entries(lock.normativeArtifacts)) {
    const actual = sha256(readFileSync(resolve(root, path)));
    if (actual !== expected) throw new Error(`${path} digest mismatch`);
  }

  const anchor = git(gitRoot, ["cat-file", "-p", start.planAnchorCommit]);
  const parent = anchor.split("\n").find((line) => line.startsWith("parent "))?.slice(7);
  if (parent !== start.sourceBaselineHead) throw new Error("plan anchor parent does not match source baseline");
  for (const item of lock.initialPackageInventory) {
    const bytes = execFileSync("git", ["-C", gitRoot, "show", `${start.planAnchorCommit}:${item.path}`]);
    if (sha256(bytes) !== item.sha256) throw new Error(`plan anchor mismatch for ${item.path}`);
  }

  const progressRoot = resolve(packageRoot, "stage-close/pre-v4");
  let progressFiles;
  let seedReferences;
  if (migrationSeedPath !== undefined) {
    const seedPath = safeArtifactPath(root, migrationSeedPath);
    const seedBytes = readFileSync(seedPath);
    if (sha256(seedBytes) !== STATE_V4_PROGRESS_SEED_SHA256) {
      throw new Error("state-v4 progress seed manifest digest mismatch");
    }
    const seed = JSON.parse(seedBytes.toString("utf8"));
    if (!exactKeys(seed, ["schemaVersion", "planId", "sourceIdentity", "startSha256", "lastEventSha256", "events"]) ||
        !exactKeys(seed.sourceIdentity, ["commitOid", "treeOid"]) ||
        seed.schemaVersion !== "state-v4-progress-seed/v1" || seed.planId !== start.planId ||
        seed.startSha256 !== start.startSha256 ||
        seed.sourceIdentity.commitOid !== STATE_V4_REVIEWED_COMMIT ||
        seed.sourceIdentity.treeOid !== STATE_V4_REVIEWED_TREE ||
        !Array.isArray(seed.events) || seed.events.length !== 3 ||
        seed.lastEventSha256 !== seed.events.at(-1)?.eventSha256) {
      throw new Error("state-v4 progress seed manifest contract mismatch");
    }
    seedReferences = seed.events;
    progressFiles = seed.events.map((reference, index) => {
      if (!exactKeys(reference, ["sequence", "path", "fileSha256", "eventSha256"]) ||
          reference.sequence !== index + 1 || !HASH.test(reference.fileSha256) ||
          !HASH.test(reference.eventSha256)) {
        throw new Error("state-v4 progress seed event reference is invalid");
      }
      const path = safeArtifactPath(root, reference.path);
      if (!path.startsWith(`${progressRoot}/`) || sha256(readFileSync(path)) !== reference.fileSha256) {
        throw new Error("state-v4 progress seed event file digest or path mismatch");
      }
      return { name: reference.path.split("/").at(-1), path };
    });
  } else {
    progressFiles = existsSync(progressRoot)
      ? readdirSync(progressRoot).filter((name) => name.endsWith(".json")).sort()
        .map((name) => ({ name, path: resolve(progressRoot, name) }))
      : [];
  }
  let previousEventSha256 = start.startSha256;
  const events = [];
  const eventIdPattern = /^[A-Za-z0-9._:-]+$/;
  const terminalResults = new Set(["PASS", "FAIL", "BLOCKED", "DEGRADED_REVIEW_SET", "READY_FOR_AUTHORIZED_PUBLISH"]);
  for (const [index, entry] of progressFiles.entries()) {
    const { name, path } = entry;
    const event = readJson(path);
    const sequence = index + 1;
    const match = name.match(/^(\d{6})-(.+)\.json$/);
    if (!match || Number(match[1]) !== sequence || match[2] !== event.eventId || !eventIdPattern.test(event.eventId)) {
      throw new Error(`invalid progress filename or sequence: ${name}`);
    }
    const expectedEventFields = [
      "schemaVersion", "eventId", "sequence", "previousEventSha256", "startSha256", "eventType",
      "planId", "effectivePlanSha256", "stageId", "gateId", "sourceFingerprint", "actor",
      "commandOrOracle", "inputHashes", "outputHashes", "attemptIds", "reviewReceiptHashes",
      "artifactPaths", "terminalResult", "recordedAt", "eventSha256",
    ].sort();
    if (canonicalJson(Object.keys(event).sort()) !== canonicalJson(expectedEventFields)) throw new Error(`progress event fields are invalid: ${name}`);
    if (event.schemaVersion !== "PlanProgressEvent/v1" || event.sequence !== sequence) throw new Error(`progress event identity mismatch: ${name}`);
    if (event.previousEventSha256 !== previousEventSha256) throw new Error(`previousEventSha256 mismatch: ${name}`);
    if (event.startSha256 !== start.startSha256) throw new Error(`startSha256 mismatch: ${name}`);
    if (event.planId !== lock.planId || event.effectivePlanSha256 !== lock.planSha256) throw new Error(`effectivePlanSha256 mismatch: ${name}`);
    if (!/^(?:R2-)?STG-(0[0-9]|1[0-2])$/.test(event.stageId) || typeof event.gateId !== "string" || !event.gateId) throw new Error(`stage or gate identity mismatch: ${name}`);
    if (!terminalResults.has(event.terminalResult)) throw new Error(`terminalResult is invalid: ${name}`);
    if (!Array.isArray(event.artifactPaths)) throw new Error(`artifactPaths are invalid: ${name}`);
    for (const path of event.artifactPaths) {
      if (typeof path !== "string" || !existsSync(resolve(root, path))) throw new Error(`artifact does not exist: ${String(path)}`);
    }
    if (event.eventType === "step_completed" && event.terminalResult === "PASS") {
      validatePassEvidence(root, event, name);
    }
    const digestInput = { ...event }; delete digestInput.eventSha256;
    const digest = sha256(canonicalJson(digestInput));
    if (event.eventSha256 !== digest) throw new Error(`eventSha256 mismatch: ${name}`);
    if (seedReferences?.[index]?.eventSha256 !== undefined &&
        seedReferences[index].eventSha256 !== event.eventSha256) {
      throw new Error(`state-v4 progress seed event digest mismatch: ${name}`);
    }
    previousEventSha256 = digest;
    events.push({ ...event, evidenceVerified: event.eventType === "step_completed" && event.terminalResult === "PASS" });
  }

  return {
    schemaVersion: "implementation-verification/v1",
    status: "verified",
    planId: start.planId,
    startSha256: start.startSha256,
    planAnchorCommit: start.planAnchorCommit,
    sourceBaselineHead: start.sourceBaselineHead,
    commitPushScope: start.commitPushScope,
    liveProviderScope: start.liveProviderScope,
    progressEventCount: events.length,
    lastSequence: events.length,
    lastEventSha256: previousEventSha256,
    events,
    ...(migrationSeedPath === undefined ? {} : { migrationSeedSha256: STATE_V4_PROGRESS_SEED_SHA256 }),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyImplementationStart(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
