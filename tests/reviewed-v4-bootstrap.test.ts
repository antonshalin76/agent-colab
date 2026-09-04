import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/domain/canonical-json.js";

import {
  REVIEWED_COMMIT,
  REVIEWED_LAST_EVENT_SHA256,
  REVIEWED_TREE,
  createProgressFixture,
  migrationSurfaceSnapshot,
  progressRows,
  removeProgressFixture,
  type ProgressFixture,
} from "./helpers/implementation-progress-fixture.js";

declare const migrationAuthorityBrand: unique symbol;
interface MigrationAuthorityCapability {
  readonly [migrationAuthorityBrand]: true;
}

interface MigrationAuthorityBinding {
  readonly operationId: string;
  readonly consumer: "codex:/root:state-v4-reviewed-bootstrap";
  readonly scope: "reviewed-state-v4-migration";
  readonly sourceIdentity: {
    readonly commitOid: typeof REVIEWED_COMMIT;
    readonly treeOid: typeof REVIEWED_TREE;
  };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

interface ReviewedMigrationInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

interface ReviewedMigrationProcess {
  run(input: ReviewedMigrationInvocation): Promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

interface MigrationFenceLease {
  assertCurrent(): void;
  release(): void;
}

interface MigrationQuiescence {
  assertServiceInactive(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
  assertNoOpenDatabaseFds(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
  acquireExclusiveWriteFence(input: {
    readonly stateDatabase: string;
    readonly historyDatabase: string;
  }): MigrationFenceLease;
}

interface ReviewedBootstrapInput {
  readonly operationId: string;
  readonly gitRoot: string;
  readonly reviewedWorktreeParent: string;
  readonly sourceIdentity: { readonly commitOid: string; readonly treeOid: string };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

interface ReviewedBootstrapReceipt {
  readonly status: "migrated" | "already_current";
  readonly sourceCommitOid: string;
  readonly sourceTreeOid: string;
  readonly importedProgressEvents: number;
  readonly lastProgressEventSha256: string;
  readonly backupPath: string;
  readonly guardPath: string;
  readonly graphExecution: "disabled";
}

interface ReviewedV4BootstrapComposition {
  bootstrapReviewedV4(
    input: ReviewedBootstrapInput,
    migrationAuthority?: MigrationAuthorityCapability,
  ): Promise<ReviewedBootstrapReceipt>;
}

interface MigrationAuthorityComposition {
  readonly issuer: { issue(binding: MigrationAuthorityBinding): MigrationAuthorityCapability };
  readonly consumer: {
    claim(capability: MigrationAuthorityCapability | undefined, binding: MigrationAuthorityBinding): {
      readonly alreadyCompleted: boolean;
      readonly completedReceipt: Readonly<Record<string, unknown>> | null;
      complete(receipt: Readonly<Record<string, unknown>>): void;
      abort(): void;
    };
  };
  close(): void;
}

type CreateReviewedV4Bootstrap = (input: {
  readonly process: ReviewedMigrationProcess;
  readonly quiescence: MigrationQuiescence;
  readonly migrationAuthority: unknown;
}) => ReviewedV4BootstrapComposition;

interface ObservedInvocation extends ReviewedMigrationInvocation {
  readonly sourceCommitOid: string;
  readonly sourceTreeOid: string;
}

interface BootstrapHarness {
  readonly composition: ReviewedV4BootstrapComposition;
  readonly authority: MigrationAuthorityComposition;
  readonly operations: string[];
  readonly invocations: ObservedInvocation[];
}

interface MigrationProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface BootstrapHarnessOptions {
  readonly failFirstProcess?: boolean;
  readonly databasePaths?: { readonly stateDatabase: string; readonly historyDatabase: string };
  readonly afterProcess?: (input: {
    readonly call: number;
    readonly fixture: ProgressFixture;
    readonly result: MigrationProcessResult;
  }) => MigrationProcessResult | void;
  readonly afterFenceAcquired?: (fixture: ProgressFixture) => void;
}

const repo = process.cwd();
const fixtures: ProgressFixture[] = [];
const authorityOwners: MigrationAuthorityComposition[] = [];

const newFixture = (): ProgressFixture => {
  const fixture = createProgressFixture();
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const authority of authorityOwners.splice(0)) authority.close();
  for (const fixture of fixtures.splice(0)) removeProgressFixture(fixture);
});

async function loadBootstrapFactory(): Promise<CreateReviewedV4Bootstrap> {
  const modulePath = pathToFileURL(resolve("src/migration/reviewed-v4-bootstrap.ts")).href;
  const module = await import(modulePath);
  return module.createReviewedV4Bootstrap as CreateReviewedV4Bootstrap;
}

function input(fixture: ProgressFixture, overrides: Partial<ReviewedBootstrapInput> = {}): ReviewedBootstrapInput {
  return {
    operationId: "test-reviewed-v4",
    gitRoot: repo,
    reviewedWorktreeParent: join(fixture.root, "reviewed-worktrees"),
    sourceIdentity: { commitOid: REVIEWED_COMMIT, treeOid: REVIEWED_TREE },
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
    ...overrides,
  };
}

function authorityBinding(fixture: ProgressFixture): MigrationAuthorityBinding {
  return {
    operationId: "test-reviewed-v4",
    consumer: "codex:/root:state-v4-reviewed-bootstrap",
    scope: "reviewed-state-v4-migration",
    sourceIdentity: { commitOid: REVIEWED_COMMIT, treeOid: REVIEWED_TREE },
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
  };
}

async function bootstrapHarness(
  fixture: ProgressFixture,
  options: BootstrapHarnessOptions = {},
): Promise<BootstrapHarness> {
  const createBootstrap = await loadBootstrapFactory();
  const authorityModule = await import(pathToFileURL(resolve("src/migration/reviewed-v4-migration-authority.ts")).href);
  const authority = authorityModule.createReviewedV4MigrationAuthority({ stateRoot: fixture.stateRoot }) as MigrationAuthorityComposition;
  authorityOwners.push(authority);
  const operations: string[] = [];
  const invocations: ObservedInvocation[] = [];
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\nexit 3\n");
  chmodSync(systemctl, 0o755);
  let processCalls = 0;

  const migrationProcess: ReviewedMigrationProcess = {
    async run(invocation) {
      operations.push("process_run");
      processCalls += 1;
      const sourceCommitOid = execFileSync("git", ["-C", invocation.cwd, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const sourceTreeOid = execFileSync("git", ["-C", invocation.cwd, "rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }).trim();
      invocations.push({ ...invocation, sourceCommitOid, sourceTreeOid });
      if (options.failFirstProcess && processCalls === 1) {
        return { status: 70, stdout: "", stderr: "injected reviewed migrator process interruption" };
      }
      symlinkSync(resolve("node_modules"), join(invocation.cwd, "node_modules"), "dir");
      const result = spawnSync(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          ...invocation.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 30_000,
      });
      const outcome = {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      return options.afterProcess?.({ call: processCalls, fixture, result: outcome }) ?? outcome;
    },
  };

  const paths = options.databasePaths ?? {
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
  };
  const quiescence: MigrationQuiescence = {
    assertServiceInactive(observed) {
      expect(observed).toEqual(paths);
      operations.push("service_inactive");
    },
    assertNoOpenDatabaseFds(observed) {
      expect(observed).toEqual(paths);
      operations.push("database_fds_zero");
    },
    acquireExclusiveWriteFence(observed) {
      expect(observed).toEqual(paths);
      operations.push("write_fence_acquired");
      options.afterFenceAcquired?.(fixture);
      let released = false;
      return {
        assertCurrent() {
          if (released) throw new Error("test fence already released");
          operations.push("write_fence_current");
        },
        release() {
          if (released) throw new Error("test fence released twice");
          released = true;
          operations.push("write_fence_released");
        },
      };
    },
  };

  return {
    composition: createBootstrap({ process: migrationProcess, quiescence, migrationAuthority: authority.consumer } as never),
    authority,
    operations,
    invocations,
  };
}

function assertExactMigratorInvocation(fixture: ProgressFixture, observed: ObservedInvocation): void {
  expect(Object.keys(observed).sort()).toEqual([
    "args", "cwd", "env", "executable", "sourceCommitOid", "sourceTreeOid",
  ]);
  expect(observed.sourceCommitOid).toBe(REVIEWED_COMMIT);
  expect(observed.sourceTreeOid).toBe(REVIEWED_TREE);
  expect(observed.executable).toBe(process.execPath);
  expect(observed.args).toEqual([
    join(observed.cwd, "scripts/agent-collab-launcher.mjs"),
    "migrate-v4",
  ]);
  expect(observed.env).toEqual({ AGENT_COLLAB_STATE_DIR: fixture.stateRoot });
  expect(observed.cwd.startsWith(`${join(fixture.root, "reviewed-worktrees")}/`)).toBe(true);
}

function assertQuiescedProcessOrder(operations: readonly string[]): void {
  expect(operations).toEqual([
    "service_inactive",
    "database_fds_zero",
    "write_fence_acquired",
    "write_fence_current",
    "process_run",
    "write_fence_current",
    "write_fence_released",
  ]);
}

function assertMigratedState(fixture: ProgressFixture): void {
  const db = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  try {
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(4);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM graph_flows").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM collaboration_dispatch_outbox").pluck().get()).toBe(0);
  } finally {
    db.close();
  }
  const rows = progressRows(fixture.databasePath);
  expect(rows.events.map(({ sequence_no, event_sha256 }) => ({ sequence_no, event_sha256 }))).toEqual([
    { sequence_no: 1, event_sha256: "ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7" },
    { sequence_no: 2, event_sha256: "98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97" },
    { sequence_no: 3, event_sha256: REVIEWED_LAST_EVENT_SHA256 },
  ]);
  expect(rows.outbox).toHaveLength(3);
}

describe("reviewed source state-v4 bootstrap authority and process transport", () => {
  it("does not expose a migration-authority issuer through the bootstrap composition", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const module = await import(pathToFileURL(resolve("src/migration/reviewed-v4-bootstrap.ts")).href);

    expect(harness.composition).not.toHaveProperty("issueMigrationAuthority");
    expect(module).not.toHaveProperty("issueMigrationAuthority");
    expect(module).not.toHaveProperty("createMigrationAuthority");
  });

  it("has zero DB, backup, guard, fence, worktree, or process effect without an issued capability", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const before = migrationSurfaceSnapshot(fixture);
    await expect(harness.composition.bootstrapReviewedV4(input(fixture)))
      .rejects.toThrow(/migration authority|required|capability/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
    expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
  });

  it("durably binds one operation and permits only one live claim", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const competingHarness = await bootstrapHarness(fixture);
    const binding = authorityBinding(fixture);
    const firstCapability = harness.authority.issuer.issue(binding);
    const replayCapability = competingHarness.authority.issuer.issue(structuredClone(binding));
    const claim = harness.authority.consumer.claim(firstCapability, binding);

    expect(() => competingHarness.authority.consumer.claim(replayCapability, binding))
      .toThrow(/concurrent|active|claim/i);
    expect(() => harness.authority.consumer.claim(firstCapability, {
      ...binding,
      operationId: "different-operation",
    })).toThrow(/exact operation|authority|capability/i);
    claim.abort();
    expect(() => competingHarness.authority.consumer.claim(replayCapability, binding).abort()).not.toThrow();
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
  });

  it.each(["structural clone", "foreign issuer"] as const)(
    "rejects a %s capability before quiescence or any mutation",
    async (variant) => {
      const fixture = newFixture();
      const harness = await bootstrapHarness(fixture);
      const authority = harness.authority.issuer.issue(authorityBinding(fixture));
      const candidate = variant === "structural clone"
        ? Object.freeze({ ...authority }) as unknown as MigrationAuthorityCapability
        : (await bootstrapHarness(fixture)).authority.issuer.issue(authorityBinding(fixture));
      const before = migrationSurfaceSnapshot(fixture);
      await expect(harness.composition.bootstrapReviewedV4(input(fixture), candidate))
        .rejects.toThrow(/migration authority|issuer|capability|identity/i);
      expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
      expect(harness.operations).toEqual([]);
      expect(harness.invocations).toEqual([]);
      expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
    },
  );

  it("rejects a genuine capability rebound to different state/history targets before quiescence or mutation", async () => {
    const fixture = newFixture();
    const other = newFixture();
    const harness = await bootstrapHarness(fixture);
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const beforeFixture = migrationSurfaceSnapshot(fixture);
    const beforeOther = migrationSurfaceSnapshot(other);
    await expect(harness.composition.bootstrapReviewedV4(input(fixture, {
      stateDatabase: other.databasePath,
      historyDatabase: other.historyPath,
    }), authority)).rejects.toThrow(/migration authority|capability|binding|database|target/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(beforeFixture);
    expect(migrationSurfaceSnapshot(other)).toEqual(beforeOther);
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
    expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
  });

  it("runs the exact reviewed worktree CLI inside an inactive exclusive fence and imports only events 1..3", async () => {
    const fixture = newFixture();
    const historyBefore = readFileSync(fixture.historyPath);
    const harness = await bootstrapHarness(fixture);
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const receipt = await harness.composition.bootstrapReviewedV4(input(fixture), authority);

    expect(receipt).toEqual({
      status: "migrated",
      sourceCommitOid: REVIEWED_COMMIT,
      sourceTreeOid: REVIEWED_TREE,
      importedProgressEvents: 3,
      lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
      backupPath: expect.any(String),
      guardPath: expect.any(String),
      graphExecution: "disabled",
    });
    expect(existsSync(receipt.backupPath)).toBe(true);
    expect(existsSync(receipt.guardPath)).toBe(true);
    expect(harness.invocations).toHaveLength(1);
    assertExactMigratorInvocation(fixture, harness.invocations[0]!);
    assertQuiescedProcessOrder(harness.operations);
    assertMigratedState(fixture);
    expect(readFileSync(fixture.historyPath)).toEqual(historyBefore);
  }, 60_000);

  it("rejects a noncanonical history target before quiescence even when an unrelated valid database exists", async () => {
    const fixture = newFixture();
    const unrelatedHistory = join(fixture.stateRoot, "unrelated-history.db");
    copyFileSync(fixture.historyPath, unrelatedHistory);
    const paths = { stateDatabase: fixture.databasePath, historyDatabase: unrelatedHistory };
    const harness = await bootstrapHarness(fixture, { databasePaths: paths });
    const binding = { ...authorityBinding(fixture), historyDatabase: unrelatedHistory };
    const before = migrationSurfaceSnapshot(fixture);
    expect(() => harness.authority.issuer.issue(binding))
      .toThrow(/canonical|history|database|target|pair|path/i);

    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
  });

  it("detects a valid history-v2 content mutation and recovers after the exact history bytes are restored", async () => {
    const fixture = newFixture();
    const historyBefore = readFileSync(fixture.historyPath);
    const harness = await bootstrapHarness(fixture, {
      afterProcess({ call, result }) {
        if (call !== 1 || result.status !== 0) return result;
        const history = new Database(fixture.historyPath);
        try {
          history.prepare("UPDATE sources SET checkpoint_offset = checkpoint_offset + 1").run();
        } finally {
          history.close();
        }
        return result;
      },
    });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/history.*(changed|digest|identity|immutable)|database pair/i);
    expect(harness.operations.at(-1)).toBe("write_fence_released");
    expect(readFileSync(fixture.historyPath)).not.toEqual(historyBefore);

    writeFileSync(fixture.historyPath, historyBefore, { mode: 0o600 });
    const receipt = await harness.composition.bootstrapReviewedV4(input(fixture), authority);
    expect(receipt.status).toBe("already_current");
    expect(readFileSync(fixture.historyPath)).toEqual(historyBefore);
    assertMigratedState(fixture);
  }, 120_000);

  it("rejects same-inode state-v3 byte drift after issuance before quiescence or any migration effect", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const identityBefore = statSync(fixture.databasePath);
    const state = new Database(fixture.databasePath);
    try {
      state.prepare("INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at) VALUES (?,?,?,?)")
        .run("unauthorized-after-issuance", "{}", 1, 1);
    } finally {
      state.close();
    }
    const identityAfter = statSync(fixture.databasePath);
    expect({ dev: identityAfter.dev, ino: identityAfter.ino })
      .toEqual({ dev: identityBefore.dev, ino: identityBefore.ino });
    const afterUnauthorizedMutation = migrationSurfaceSnapshot(fixture);

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/state.*(bytes|manifest|digest|drift)|authority/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(afterUnauthorizedMutation);
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
    expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
  });

  it("rejects same-inode state-v3 drift introduced after the exclusive fence is acquired", async () => {
    const fixture = newFixture();
    let mutated = false;
    const harness = await bootstrapHarness(fixture, {
      afterFenceAcquired() {
        const state = new Database(fixture.databasePath);
        try {
          state.prepare("INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at) VALUES (?,?,?,?)")
            .run("changed-under-exclusive-fence", "{}", 1, 1);
          mutated = true;
        } finally {
          state.close();
        }
      },
    });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const identityBefore = statSync(fixture.databasePath);

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/state.*(bytes|manifest|digest|drift)|authority/i);
    const identityAfter = statSync(fixture.databasePath);
    expect(mutated).toBe(true);
    expect({ dev: identityAfter.dev, ino: identityAfter.ino })
      .toEqual({ dev: identityBefore.dev, ino: identityBefore.ino });
    expect(harness.operations).toEqual([
      "service_inactive",
      "database_fds_zero",
      "write_fence_acquired",
      "write_fence_current",
      "write_fence_released",
    ]);
    expect(harness.invocations).toEqual([]);
    expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
    expect(existsSync(join(
      fixture.stateRoot,
      "migration-v4",
      "authority",
      "test-reviewed-v4.completion.json",
    ))).toBe(false);
  });

  it.each([
    "extra top-level key",
    "wrong reviewed consumer",
    "wrong reviewed commit",
    "relative database path",
    "non-integer file identity",
    "invalid state bytes digest",
    "state user version is not v3",
    "history user version is not v2",
  ] as const)("rejects durable authorization with %s before issuing a new capability", async (variant) => {
    const fixture = newFixture();
    const first = await bootstrapHarness(fixture);
    const binding = authorityBinding(fixture);
    first.authority.issuer.issue(binding);
    const authorizationPath = join(
      fixture.stateRoot,
      "migration-v4",
      "authority",
      "test-reviewed-v4.authorization.json",
    );
    const authorization = JSON.parse(readFileSync(authorizationPath, "utf8")) as Record<string, any>;
    if (variant === "extra top-level key") authorization.unexpected = true;
    else if (variant === "wrong reviewed consumer") authorization.binding.consumer = "another-consumer";
    else if (variant === "wrong reviewed commit") authorization.binding.sourceIdentity.commitOid = "0".repeat(40);
    else if (variant === "relative database path") authorization.binding.stateDatabase = "collaboration.db";
    else if (variant === "non-integer file identity") authorization.stateIdentity.dev = 1.5;
    else if (variant === "invalid state bytes digest") authorization.preState.bytesSha256 = "not-a-sha256";
    else if (variant === "state user version is not v3") authorization.preState.userVersion = 4;
    else authorization.preHistory.userVersion = 3;
    writeFileSync(authorizationPath, `${canonicalJson(authorization)}\n`, { mode: 0o600 });
    const afterTamper = migrationSurfaceSnapshot(fixture);
    const second = await bootstrapHarness(fixture);

    expect(() => second.authority.issuer.issue(binding))
      .toThrow(/authorization.*(invalid|pre-state|v3|schema)|durable migration authority/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(afterTamper);
    expect(second.operations).toEqual([]);
    expect(second.invocations).toEqual([]);
  });

  it("rejects existing v4 recovery derived from a different authorized v3 state", async () => {
    const fixture = newFixture();
    const first = await bootstrapHarness(fixture);
    const firstBinding = authorityBinding(fixture);
    const firstCapability = first.authority.issuer.issue(firstBinding);
    const state = new Database(fixture.databasePath);
    try {
      state.prepare("INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at) VALUES (?,?,?,?)")
        .run("different-authorized-v3-state", "{}", 1, 1);
    } finally {
      state.close();
    }

    const second = await bootstrapHarness(fixture);
    const secondBinding = { ...authorityBinding(fixture), operationId: "migrate-different-v3-state" };
    const secondCapability = second.authority.issuer.issue(secondBinding);
    expect((await second.composition.bootstrapReviewedV4(input(fixture, {
      operationId: secondBinding.operationId,
    }), secondCapability)).status).toBe("migrated");
    const beforeRejectedReplay = migrationSurfaceSnapshot(fixture);

    await expect(first.composition.bootstrapReviewedV4(input(fixture), firstCapability))
      .rejects.toThrow(/recovery|pre-migration|pre-state|backup|manifest|digest|authority/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(beforeRejectedReplay);
    expect(first.invocations).toEqual([]);
    expect(existsSync(join(
      fixture.stateRoot,
      "migration-v4",
      "authority",
      "test-reviewed-v4.completion.json",
    ))).toBe(false);
  }, 60_000);

  it("rejects pathname replacement of the migrated state database even when the replacement has exact valid bytes", async () => {
    const fixture = newFixture();
    const stateIdentityBefore = statSync(fixture.databasePath);
    const harness = await bootstrapHarness(fixture, {
      afterProcess({ call, result }) {
        if (call !== 1 || result.status !== 0) return result;
        const replacement = join(fixture.stateRoot, "replacement-state.db");
        copyFileSync(fixture.databasePath, replacement);
        renameSync(replacement, fixture.databasePath);
        return result;
      },
    });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/state.*(changed|identity|replaced)|database pair/i);
    const stateIdentityAfter = statSync(fixture.databasePath);
    expect({ dev: stateIdentityAfter.dev, ino: stateIdentityAfter.ino })
      .not.toEqual({ dev: stateIdentityBefore.dev, ino: stateIdentityBefore.ino });
    expect(harness.operations.at(-1)).toBe("write_fence_released");
  }, 60_000);

  it("rejects existing recovery artifacts outside the active canonical authority and then replays safely", async () => {
    const fixture = newFixture();
    let unrelatedBackup = "";
    let unrelatedGuard = "";
    const harness = await bootstrapHarness(fixture, {
      afterProcess({ call, result }) {
        if (call !== 1 || result.status !== 0) return result;
        const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
        unrelatedBackup = join(fixture.stateRoot, "unrelated-existing-backup.db");
        unrelatedGuard = join(fixture.stateRoot, "unrelated-existing-guard.jsonl");
        copyFileSync(String(receipt.backupPath), unrelatedBackup);
        copyFileSync(String(receipt.guardPath), unrelatedGuard);
        return {
          ...result,
          stdout: `${JSON.stringify({ ...receipt, backupPath: unrelatedBackup, guardPath: unrelatedGuard })}\n`,
        };
      },
    });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/recovery|authority|canonical|artifact|descriptor|receipt/i);
    expect(existsSync(unrelatedBackup)).toBe(true);
    expect(existsSync(unrelatedGuard)).toBe(true);
    expect(harness.operations.at(-1)).toBe("write_fence_released");

    const recovered = await harness.composition.bootstrapReviewedV4(input(fixture), authority);
    expect(recovered.status).toBe("already_current");
    expect(harness.invocations).toHaveLength(1);
    expect(recovered.backupPath).not.toBe(unrelatedBackup);
    expect(recovered.guardPath).not.toBe(unrelatedGuard);
    assertMigratedState(fixture);
  }, 120_000);

  it.each(["backup", "manifest", "guard"] as const)(
    "rejects a semantically invalid active %s artifact instead of accepting path existence",
    async (artifact) => {
      const fixture = newFixture();
      const harness = await bootstrapHarness(fixture, {
        afterProcess({ call, result }) {
          if (call !== 1 || result.status !== 0) return result;
          const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
          const path = artifact === "backup"
            ? String(receipt.backupPath)
            : artifact === "manifest"
              ? `${String(receipt.backupPath)}.manifest.json`
              : String(receipt.guardPath);
          writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("tampered\n")]));
          return result;
        },
      });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));

      await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
        .rejects.toThrow(/backup|manifest|guard|recovery|authority|artifact|hash|canonical|SQLite/i);
      expect(harness.operations.at(-1)).toBe("write_fence_released");
    },
    60_000,
  );

  it("rejects a malformed review-v3 table even though its name is an allowed post-backup addition", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture, {
      afterProcess({ call, result }) {
        if (call !== 1 || result.status !== 0) return result;
        const db = new Database(fixture.databasePath);
        try {
          db.exec("ALTER TABLE runtime_review_no_spawn_effects ADD COLUMN injected TEXT");
        } finally {
          db.close();
        }
        return result;
      },
    });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/review-v3|schema signature|column signature|migration/i);
    expect(harness.operations.at(-1)).toBe("write_fence_released");
  }, 60_000);

  it.each([
    {
      name: "wrong reviewed commit",
      sourceIdentity: { commitOid: "0".repeat(40), treeOid: REVIEWED_TREE },
    },
    {
      name: "wrong reviewed tree/manifest",
      sourceIdentity: { commitOid: REVIEWED_COMMIT, treeOid: "f".repeat(40) },
    },
    {
      name: "current source containing the fourth event",
      sourceIdentity: {
        commitOid: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        treeOid: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
      },
    },
  ])("rejects $name before quiescence, worktree, process, backup, guard, or DB mutation", async ({ sourceIdentity }) => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const before = migrationSurfaceSnapshot(fixture);
    await expect(harness.composition.bootstrapReviewedV4(input(fixture, { sourceIdentity }), authority))
      .rejects.toThrow(/reviewed|source|commit|tree|manifest|fourth|capability|binding/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
    expect(harness.operations).toEqual([]);
    expect(harness.invocations).toEqual([]);
    expect(existsSync(join(fixture.root, "reviewed-worktrees"))).toBe(false);
  });

  it("releases the exclusive fence after process interruption and safely retries the same bound capability", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture, { failFirstProcess: true });
    const authority = harness.authority.issuer.issue(authorityBinding(fixture));
    const before = migrationSurfaceSnapshot(fixture);

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), authority))
      .rejects.toThrow(/reviewed migrator|process|interruption|status 70/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
    assertQuiescedProcessOrder(harness.operations);

    const receipt = await harness.composition.bootstrapReviewedV4(input(fixture), authority);
    expect(receipt).toMatchObject({ importedProgressEvents: 3, graphExecution: "disabled" });
    expect(harness.invocations).toHaveLength(2);
    assertExactMigratorInvocation(fixture, harness.invocations[1]!);
    assertQuiescedProcessOrder(harness.operations.slice(7));
    assertMigratedState(fixture);
  }, 60_000);

  it("replays a completed durable operation as already_current without rerunning the migrator", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const binding = authorityBinding(fixture);
    const capability = harness.authority.issuer.issue(binding);
    expect((await harness.composition.bootstrapReviewedV4(input(fixture), capability)).status).toBe("migrated");
    expect((await harness.composition.bootstrapReviewedV4(input(fixture), capability)).status).toBe("already_current");
    expect(harness.invocations).toHaveLength(1);
    assertMigratedState(fixture);
  }, 60_000);

  it("rejects malformed or receipt-conflicting durable completion evidence without rerunning migration", async () => {
    const fixture = newFixture();
    const harness = await bootstrapHarness(fixture);
    const binding = authorityBinding(fixture);
    const capability = harness.authority.issuer.issue(binding);
    expect((await harness.composition.bootstrapReviewedV4(input(fixture), capability)).status).toBe("migrated");
    const completionPath = join(fixture.stateRoot, "migration-v4", "authority", "test-reviewed-v4.completion.json");
    const completionBytes = readFileSync(completionPath);
    writeFileSync(completionPath, "{\"not\":\"a completion\"}\n", { mode: 0o600 });
    const corrupted = migrationSurfaceSnapshot(fixture);
    const operationCount = harness.operations.length;

    await expect(harness.composition.bootstrapReviewedV4(input(fixture), capability))
      .rejects.toThrow(/completion.*(record|canonical|operation|malformed)|durable migration completion/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(corrupted);
    expect(harness.operations).toHaveLength(operationCount);
    expect(harness.invocations).toHaveLength(1);

    writeFileSync(completionPath, completionBytes, { mode: 0o600 });
    const claim = harness.authority.consumer.claim(capability, binding);
    expect(claim.alreadyCompleted).toBe(true);
    expect(() => claim.complete({ status: "conflicting-replay" }))
      .toThrow(/completion replay conflicts|persisted exact receipt/i);
    claim.abort();
    expect((await harness.composition.bootstrapReviewedV4(input(fixture), capability)).status).toBe("already_current");
    expect(harness.invocations).toHaveLength(1);
  }, 60_000);
});
