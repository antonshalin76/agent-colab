import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = process.cwd();
const verifier = join(repo, "scripts/verify-implementation-progress.mjs");
const renderer = join(repo, "scripts/render-implementation-progress.mjs");
const roots: string[] = [];
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-progress-")); roots.push(root);
  cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true }); cpSync(join(repo, "repo-c4.json"), join(root, "repo-c4.json"));
  cpSync(join(repo, "evals"), join(root, "evals"), { recursive: true });
  return root;
};

const event = (root: string, overrides: Record<string, unknown> = {}, packageName = "hybrid-flow-v1") => {
  const packageRoot = join(root, "docs", packageName);
  const start = JSON.parse(readFileSync(join(packageRoot, "IMPLEMENTATION_START.json"), "utf8")) as { startSha256: string };
  const lock = JSON.parse(readFileSync(join(packageRoot, "PLAN_LOCK.json"), "utf8")) as { planSha256: string; planId: string };
  const evidenceRoot = join(packageRoot, "stage-close", "evidence"); mkdirSync(evidenceRoot, { recursive: true });
  const sourceFingerprint = "f".repeat(64);
  const inputPath = `docs/${packageName}/IMPLEMENTATION_START.json`;
  const writeEvidence = (name: string, value: unknown) => {
    const relative = `docs/${packageName}/stage-close/evidence/${name}`;
    writeFileSync(join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
    return { path: relative, sha256: fileHash(join(root, relative)) };
  };
  const receipts = (["auditor", "critic"] as const).map((role) => writeEvidence(`${role}.json`, {
    schemaVersion: "review-receipt/v1", agent: "codex", role, attemptId: `codex-${role}-1`,
    sourceFingerprint, reviewVerdict: { schemaVersion: "review-verdict/v1", verdict: "PASS", findings: [] },
  }));
  const barrier = writeEvidence("barrier.json", {
    schemaVersion: "review-barrier-evidence/v1", stageId: packageName.endsWith("-r2") ? "R2-STG-00" : "STG-00",
    gateId: "stg00-progress-verifier", sourceFingerprint, satisfied: true, requiredCount: 2, terminalCount: 2,
    requiredReceipts: receipts.map((receipt, index) => ({ agent: "codex", role: index === 0 ? "auditor" : "critic",
      attemptId: `codex-${index === 0 ? "auditor" : "critic"}-1`, receiptSha256: receipt.sha256 })),
  });
  const oracle = writeEvidence("oracle.json", {
    schemaVersion: "terminal-oracle/v1", stageId: packageName.endsWith("-r2") ? "R2-STG-00" : "STG-00",
    gateId: "stg00-progress-verifier", sourceFingerprint, terminalResult: "PASS",
  });
  const value: Record<string, unknown> = {
    schemaVersion: "PlanProgressEvent/v1", eventId: "stg00.verifier", sequence: 1,
    previousEventSha256: start.startSha256, startSha256: start.startSha256, eventType: "step_completed",
    planId: lock.planId, effectivePlanSha256: lock.planSha256,
    stageId: packageName.endsWith("-r2") ? "R2-STG-00" : "STG-00",
    gateId: "stg00-progress-verifier", sourceFingerprint, actor: "codex:/root",
    commandOrOracle: { kind: "oracle", artifactPath: oracle.path, sha256: oracle.sha256 },
    inputHashes: [{ path: inputPath, sha256: fileHash(join(root, inputPath)) }],
    outputHashes: [barrier, oracle], attemptIds: ["codex-auditor-1", "codex-critic-1"],
    reviewReceiptHashes: receipts.map((receipt, index) => ({ agent: "codex", role: index === 0 ? "auditor" : "critic",
      attemptId: `codex-${index === 0 ? "auditor" : "critic"}-1`, artifactPath: receipt.path, sha256: receipt.sha256 })),
    artifactPaths: [inputPath, barrier.path, oracle.path, ...receipts.map(({ path }) => path)], terminalResult: "PASS",
    recordedAt: "2026-08-31T09:54:00+08:00", ...overrides,
  };
  value.eventSha256 = hash(canonical(value));
  const dir = join(packageRoot, "stage-close/pre-v4"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `000001-${String(value.eventId)}.json`), `${JSON.stringify(value, null, 2)}\n`);
};

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pre-v4 progress chain", () => {
  it("verifies a contiguous start-rooted event and renders its checkbox", () => {
    const root = fixture(); event(root);
    const verified = JSON.parse(execFileSync(process.execPath, [verifier, "--root", root, "--git-root", repo], { encoding: "utf8" }));
    expect(verified).toMatchObject({ progressEventCount: 1, lastSequence: 1 });
    const rendered = execFileSync(process.execPath, [renderer, "--root", root, "--git-root", repo], { encoding: "utf8" });
    expect(rendered).toContain("[x] STG-00/stg00-progress-verifier");
  });

  it.each([
    ["broken chain", { previousEventSha256: "0".repeat(64) }, /previousEventSha256/i],
    ["wrong plan", { effectivePlanSha256: "0".repeat(64) }, /effectivePlanSha256/i],
    ["missing artifact", { artifactPaths: ["missing.file"] }, /missing\.file/i],
  ])("rejects %s", (_name, overrides, pattern) => {
    const root = fixture(); event(root, overrides);
    const result = spawnSync(process.execPath, [verifier, "--root", root, "--git-root", repo], { encoding: "utf8" });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(pattern);
  });

  it.each([
    ["empty source fingerprint", { sourceFingerprint: "" }, /sourceFingerprint/i],
    ["missing input hashes", { inputHashes: [] }, /inputHashes/i],
    ["missing output hashes", { outputHashes: [] }, /outputHashes/i],
    ["missing attempts", { attemptIds: [] }, /attemptIds/i],
    ["missing critic receipt", { reviewReceiptHashes: [] }, /reviewReceiptHashes/i],
    ["missing barrier evidence", { outputHashes: [] }, /outputHashes|barrier/i],
    ["shallow string oracle", { commandOrOracle: "vitest:implementation-progress" }, /commandOrOracle|oracle/i],
  ])("rejects shallow PASS evidence: %s", (_name, overrides, pattern) => {
    const root = fixture(); event(root, overrides);
    const result = spawnSync(process.execPath, [verifier, "--root", root, "--git-root", repo], { encoding: "utf8" });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(pattern);
  });

  it("supports the R2 package alias and renders only deeply verified PASS events", () => {
    const root = fixture(); event(root, {}, "hybrid-flow-v1-r2");
    const rendered = execFileSync(process.execPath, [renderer, "--root", root, "--git-root", repo, "--package", "R2"], { encoding: "utf8" });
    expect(rendered).toContain("[x] R2-STG-00/stg00-progress-verifier");
  });
});
