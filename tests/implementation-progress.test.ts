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

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-progress-")); roots.push(root);
  cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true }); cpSync(join(repo, "repo-c4.json"), join(root, "repo-c4.json"));
  return root;
};

const event = (root: string, overrides: Record<string, unknown> = {}) => {
  const start = JSON.parse(readFileSync(join(root, "docs/hybrid-flow-v1/IMPLEMENTATION_START.json"), "utf8")) as { startSha256: string };
  const lock = JSON.parse(readFileSync(join(root, "docs/hybrid-flow-v1/PLAN_LOCK.json"), "utf8")) as { planSha256: string };
  const value: Record<string, unknown> = {
    schemaVersion: "PlanProgressEvent/v1", eventId: "stg00.verifier", sequence: 1,
    previousEventSha256: start.startSha256, startSha256: start.startSha256, eventType: "step_completed",
    planId: "agent-collab-hybrid-flow-v1", effectivePlanSha256: lock.planSha256, stageId: "STG-00",
    gateId: "stg00-progress-verifier", sourceFingerprint: "f".repeat(64), actor: "codex:/root",
    commandOrOracle: "vitest:implementation-progress", inputHashes: [], outputHashes: [], attemptIds: ["attempt-1"],
    reviewReceiptHashes: [], artifactPaths: ["docs/hybrid-flow-v1/IMPLEMENTATION_START.json"], terminalResult: "PASS",
    recordedAt: "2026-08-31T09:54:00+08:00", ...overrides,
  };
  value.eventSha256 = hash(canonical(value));
  const dir = join(root, "docs/hybrid-flow-v1/stage-close/pre-v4"); mkdirSync(dir, { recursive: true });
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
});
