import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repo = process.cwd();
const verifier = join(repo, "scripts", "verify-implementation-progress.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("implementation progress verifier", () => {
  it("accepts the hash-bound start receipt and anchor", () => {
    const output = execFileSync(process.execPath, [verifier, "--root", repo], { encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ status: "verified", planId: "agent-collab-hybrid-flow-v1" });
  });

  it("fails closed when the start receipt is tampered", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-start-tamper-")); roots.push(root);
    cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true });
    cpSync(join(repo, "repo-c4.json"), join(root, "repo-c4.json"));
    const path = join(root, "docs", "hybrid-flow-v1", "IMPLEMENTATION_START.json");
    const start = JSON.parse(readFileSync(path, "utf8")) as { branch: string };
    start.branch = "tampered";
    writeFileSync(path, `${JSON.stringify(start, null, 2)}\n`);
    const result = spawnSync(process.execPath, [verifier, "--root", root, "--git-root", repo], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/startSha256/i);
  });

  it("rejects a changed normative artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-plan-tamper-")); roots.push(root);
    cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true });
    cpSync(join(repo, "repo-c4.json"), join(root, "repo-c4.json"));
    writeFileSync(join(root, "docs", "hybrid-flow-v1", "CONTRACTS.md"), "tampered\n");
    const result = spawnSync(process.execPath, [verifier, "--root", root, "--git-root", repo], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/CONTRACTS\.md/i);
  });
});
