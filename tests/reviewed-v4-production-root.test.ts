import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  createProgressFixture,
  migrationSurfaceSnapshot,
  removeProgressFixture,
  type ProgressFixture,
} from "./helpers/implementation-progress-fixture.js";
import {
  removeTestReviewedV4RemoteRef,
  reviewedV4TestTrust,
} from "./helpers/reviewed-v4-source-acceptance-fixture.js";

interface ReviewedV4ProductionProcess {
  migrateExactOperation(): Promise<unknown>;
  close(): void;
}

interface ReviewedV4ProductionModule {
  resolveReviewedV4ProductionSourceRoot(): string;
  createProductionReviewedV4MigrationProcess(input: {
    readonly stateRoot: string;
    readonly sourceAcceptanceReceiptSha256: string;
    readonly promotionTrust?: ReturnType<typeof reviewedV4TestTrust>;
  }): ReviewedV4ProductionProcess;
}

const repositoryRoot = realpathSync(resolve("."));
const productionModuleUrl = pathToFileURL(
  resolve("src/migration/reviewed-v4-production-process.ts"),
).href;
const fixtures: ProgressFixture[] = [];
const scratchRoots: string[] = [];
const closeables: ReviewedV4ProductionProcess[] = [];

const receiptSha256 = "7".repeat(64);

async function loadProductionModule(): Promise<ReviewedV4ProductionModule> {
  return await import(productionModuleUrl) as unknown as ReviewedV4ProductionModule;
}

function fixture(): ProgressFixture {
  const value = createProgressFixture();
  fixtures.push(value);
  return value;
}

afterEach(() => {
  for (const closeable of closeables.splice(0).reverse()) closeable.close();
  for (const value of fixtures.splice(0)) removeProgressFixture(value);
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => removeTestReviewedV4RemoteRef());

describe("reviewed v4 production source root", () => {
  it("derives the canonical execution root from the loaded module when cwd points elsewhere", () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "agent-collab-source-root-cwd-"));
    scratchRoots.push(otherCwd);
    const script = `
      process.chdir(${JSON.stringify(otherCwd)});
      const runtime = await import(${JSON.stringify(productionModuleUrl)});
      process.stdout.write(runtime.resolveReviewedV4ProductionSourceRoot());
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(repositoryRoot);
  });

  it("rejects the compiled dist entrypoint before opening the target state layout", () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-collab-dist-rejected-"));
    scratchRoots.push(scratch);
    const stateRoot = join(scratch, "state");
    const distModuleUrl = pathToFileURL(
      resolve("dist/migration/reviewed-v4-production-process.js"),
    ).href;
    const script = `
      const runtime = await import(${JSON.stringify(distModuleUrl)});
      try {
        runtime.createProductionReviewedV4MigrationProcess({
          stateRoot: ${JSON.stringify(stateRoot)},
          sourceAcceptanceReceiptSha256: ${JSON.stringify(receiptSha256)},
        });
      } catch (error) {
        process.stderr.write(String(error instanceof Error ? error.message : error));
        process.exitCode = 17;
      }
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status, result.stderr).toBe(17);
    expect(result.stderr).toMatch(/source launcher.*dist execution is forbidden/i);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("rejects a symlinked production public-key file before reading promotion or state", () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-collab-key-file-rejected-"));
    scratchRoots.push(scratch);
    const stateRoot = join(scratch, "state");
    const keyTarget = join(scratch, "key-target.pem");
    const keyLink = join(scratch, "key.pem");
    writeFileSync(keyTarget, "not-a-key\n", { mode: 0o600 });
    symlinkSync(keyTarget, keyLink);
    const script = `
      const runtime = await import(${JSON.stringify(productionModuleUrl)});
      try {
        runtime.adoptProductionReviewedV4Source({
          stateRoot: ${JSON.stringify(stateRoot)},
          externalPromotionPath: ${JSON.stringify(join(scratch, "missing-promotion.json"))},
        });
      } catch (error) {
        process.stderr.write(String(error instanceof Error ? error.message : error));
        process.exitCode = 17;
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          AGENT_COLLAB_REVIEWED_SOURCE_PUBLIC_KEY_FILE: keyLink,
          AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_URL: "/configured/remote.git",
          AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_REF: "refs/heads/reviewed-v4-candidate",
        },
      },
    );

    expect(result.status, result.stderr).toBe(17);
    expect(result.stderr).toMatch(/public key file.*(canonical|no-follow)/i);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it.each(["repositoryRoot", "gitRoot", "sourceIdentity", "reviewedWorktreeParent"] as const)(
    "rejects caller-controlled %s before state, backup, or authority effects",
    async (field) => {
      const runtime = await loadProductionModule();
      const value = fixture();
      const before = migrationSurfaceSnapshot(value);
      const injected = {
        stateRoot: value.stateRoot,
        sourceAcceptanceReceiptSha256: receiptSha256,
        promotionTrust: reviewedV4TestTrust(),
        [field]: field === "sourceIdentity"
          ? { commitOid: "1".repeat(40), treeOid: "2".repeat(40) }
          : value.repositoryRoot,
      };

      expect(() => runtime.createProductionReviewedV4MigrationProcess(
        injected as unknown as {
          readonly stateRoot: string;
          readonly sourceAcceptanceReceiptSha256: string;
          readonly promotionTrust?: ReturnType<typeof reviewedV4TestTrust>;
        },
      )).toThrow(/unknown|caller|source root|production input|not permitted/i);
      expect(migrationSurfaceSnapshot(value)).toEqual(before);
    },
  );

  it("requires the externally accepted source before quiescence or migration effects", async () => {
    const runtime = await loadProductionModule();
    const value = fixture();
    const before = migrationSurfaceSnapshot(value);
    const process = runtime.createProductionReviewedV4MigrationProcess({
      stateRoot: value.stateRoot,
      sourceAcceptanceReceiptSha256: receiptSha256,
      promotionTrust: reviewedV4TestTrust(),
    });
    closeables.push(process);

    await expect(process.migrateExactOperation()).rejects.toThrow(
      /source (acceptance|adoption)|accepted source|receipt.*(absent|missing|required)/i,
    );
    expect(migrationSurfaceSnapshot(value)).toEqual(before);
  });
});
