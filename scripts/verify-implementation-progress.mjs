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
  const result = { root: process.cwd(), gitRoot: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") result.root = resolve(argv[++index]);
    else if (flag === "--git-root") result.gitRoot = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  result.gitRoot ??= result.root;
  return result;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

export function verifyImplementationStart({ root, gitRoot = root }) {
  const packageRoot = resolve(root, "docs/hybrid-flow-v1");
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
  const progressFiles = existsSync(progressRoot)
    ? readdirSync(progressRoot).filter((name) => name.endsWith(".json")).sort()
    : [];
  let previousEventSha256 = start.startSha256;
  const events = [];
  const eventIdPattern = /^[A-Za-z0-9._:-]+$/;
  const terminalResults = new Set(["PASS", "FAIL", "BLOCKED", "DEGRADED_REVIEW_SET", "READY_FOR_AUTHORIZED_PUBLISH"]);
  for (const [index, name] of progressFiles.entries()) {
    const event = readJson(resolve(progressRoot, name));
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
    if (!/^STG-(0[0-9]|1[0-2])$/.test(event.stageId) || typeof event.gateId !== "string" || !event.gateId) throw new Error(`stage or gate identity mismatch: ${name}`);
    if (!terminalResults.has(event.terminalResult)) throw new Error(`terminalResult is invalid: ${name}`);
    for (const path of event.artifactPaths) {
      if (typeof path !== "string" || !existsSync(resolve(root, path))) throw new Error(`artifact does not exist: ${String(path)}`);
    }
    const digestInput = { ...event }; delete digestInput.eventSha256;
    const digest = sha256(canonicalJson(digestInput));
    if (event.eventSha256 !== digest) throw new Error(`eventSha256 mismatch: ${name}`);
    previousEventSha256 = digest;
    events.push(event);
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
