import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadVerifiedMigrationProgressBundle,
  verifyImplementationStart,
} from "../src/flow/implementation-progress-package-verifier.js";
import { ImplementationProgressProjectionFiles } from "../src/store/implementation-progress-projection-files.js";
import { ImplementationProgressProjector } from "../src/app/implementation-progress-projector.js";
import { renderImplementationProgressProjection } from "../src/flow/implementation-progress.js";

const roots: string[] = [];
const repo = process.cwd();
const verifier = join(repo, "scripts", "verify-implementation-progress.mjs");

const migrationPackageFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-in-process-progress-"));
  roots.push(root);
  cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true });
  cpSync(join(repo, "evals"), join(root, "evals"), { recursive: true });
  cpSync(join(repo, "repo-c4.json"), join(root, "repo-c4.json"));
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("implementation progress verifier", () => {
  it("renders the accepted amendment and the complete immutable stage inventory without false completion", () => {
    const events = readFileSync(join(repo, "docs/hybrid-flow-v1-r2/IMPLEMENTATION_PROGRESS.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const markdown = renderImplementationProgressProjection(events).markdownBytes.toString("utf8");

    expect(markdown).toBe(readFileSync(join(repo,
      "docs/hybrid-flow-v1-r2/IMPLEMENTATION_PROGRESS.md"), "utf8"));
    expect(markdown).toContain("- [x] AMD-0001 (accepted)");
    expect(markdown).toContain("- [x] STG-03 (completed)");
    expect(markdown).toContain("- [ ] STG-04 (eligible)");
    for (let stage = 5; stage <= 12; stage += 1) {
      expect(markdown).toContain(`- [ ] STG-${String(stage).padStart(2, "0")} (pending)`);
    }
    expect(markdown).not.toContain("- [x] STG-04");
  });
  it("uses the same typed in-process verifier as the CLI for the migration seed", () => {
    const input = {
      root: repo,
      gitRoot: repo,
      packagePath: "docs/hybrid-flow-v1-r2",
      migrationSeedPath: "docs/hybrid-flow-v1-r2/STATE_V4_PROGRESS_SEED.json",
    };
    const direct = verifyImplementationStart(input);
    const cli = JSON.parse(execFileSync(process.execPath, [
      verifier,
      "--root", repo,
      "--git-root", repo,
      "--package", input.packagePath,
      "--migration-seed", input.migrationSeedPath,
    ], { encoding: "utf8" })) as unknown;

    expect(cli).toEqual(direct);
  });

  it("does not let MigrationCoordinator execute the verifier script or parse its stdout", () => {
    const source = readFileSync(join(repo, "src/migration/coordinator.ts"), "utf8");

    expect(source).not.toContain("scripts/verify-implementation-progress.mjs");
    expect(source).not.toContain("execFileSync(process.execPath");
  });

  it("loads the migration bundle in process without a scripts directory", () => {
    const root = migrationPackageFixture();

    const bundle = loadVerifiedMigrationProgressBundle({
      repositoryRoot: root,
      gitRoot: repo,
      progressPackagePath: "docs/hybrid-flow-v1-r2",
    });

    expect(bundle.events).toHaveLength(3);
    expect(bundle.events.at(-1)).toMatchObject({ stageId: "STG-02", sequence: 3 });
  });

  it("retains the post-verification reread fence without hardcoded coordinator filenames", () => {
    const root = migrationPackageFixture();
    const eventPath = join(root,
      "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json");

    expect(() => loadVerifiedMigrationProgressBundle({
      repositoryRoot: root,
      gitRoot: repo,
      progressPackagePath: "docs/hybrid-flow-v1-r2",
      afterVerify: () => {
        const event = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>;
        event.eventId = "changed-after-verification";
        writeFileSync(eventPath, `${JSON.stringify(event)}\n`);
      },
    })).toThrow(/bytes changed after verification/i);
  });

  it("accepts the hash-bound start receipt and anchor", () => {
    const output = execFileSync(process.execPath, [verifier, "--root", repo], { encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ status: "verified", planId: "agent-collab-hybrid-flow-v1" });
  });

  it("accepts the independent R2 plan root", () => {
    const output = execFileSync(process.execPath, [verifier, "--root", repo, "--package", "docs/hybrid-flow-v1-r2"], { encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ status: "verified", planId: "agent-collab-hybrid-flow-v1-r2" });
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

  it("closes projection directory owners idempotently and rejects use after close", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-progress-close-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    const stateRoot = join(root, "state");
    mkdirSync(packageRoot);
    mkdirSync(stateRoot);
    const files = new ImplementationProgressProjectionFiles({ packageRoot, stateRoot });
    const projector = new ImplementationProgressProjector({
      store: {} as never,
      files,
      stateRoot,
    });

    projector.close();
    projector.close();
    files.close();
    files.close();
    expect(() => projector.project({ publishedAt: 1 })).toThrow(/projector is closed/i);
    expect(() => files.publish({
      jsonlBytes: Buffer.from("{}\n"),
      markdownBytes: Buffer.from("projection"),
      watermarkSequence: 1,
      watermarkEventSha256: "a".repeat(64),
    })).toThrow(/files are closed/i);
  });
});
