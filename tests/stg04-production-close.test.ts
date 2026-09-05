import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createReviewedV4MigrationAuthority } from "../src/migration/reviewed-v4-migration-authority.js";
import { verifyCurrentReviewedV4Database } from "../src/migration/reviewed-v4-bootstrap.js";
import { appendStateV4GuardEvent } from "../src/migration/state-v4-restore-authority.js";
import {
  openStateDatabaseLease,
  type StateDatabaseAccess,
} from "../src/store/state-database-fence.js";
import { observeLegacyDatabase } from "../src/migration/state-v4-manifest.js";
import {
  AMD_ACCEPTED_AT,
  AMD_EFFECTIVE_PLAN_SHA256,
  REVIEWED_COMMIT,
  REVIEWED_LAST_EVENT_SHA256,
  REVIEWED_TREE,
  STG03_EVENT_SHA256,
  amendmentFixture,
  canonicalJson,
  createProgressFixture,
  migrationSurfaceSnapshot,
  progressRows,
  removeProgressFixture,
  sha256,
  type JsonObject,
  type ProgressFixture,
} from "./helpers/implementation-progress-fixture.js";
import {
  adoptTestReviewedV4SourceAcceptance,
  createTestReviewedV4Promotion,
  removeTestReviewedV4RemoteRef,
  reviewedV4TestTrust,
} from "./helpers/reviewed-v4-source-acceptance-fixture.js";

interface DatabasePair {
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

interface OfflineProcessScan {
  readonly files: ReadonlyArray<{ readonly pid: number; readonly path: string; readonly dev: number; readonly ino: number }>;
  readonly unreadableSameUidPids: readonly number[];
}

interface QuiescencePorts {
  serviceState(): "active" | "inactive" | "unknown";
  scanSameUidOpenFiles(): OfflineProcessScan;
  stat(path: string): { readonly dev: number; readonly ino: number };
  acquireFence(): { assertCurrent(): void; release(): void };
}

interface OfflineMigrationQuiescence {
  assertServiceInactive(input: DatabasePair): void;
  assertNoOpenDatabaseFds(input: DatabasePair): void;
  acquireExclusiveWriteFence(input: DatabasePair): { assertCurrent(): void; release(): void };
}

type ClosePhase =
  | "PRE_V4"
  | "MIGRATION_AUTHORIZED"
  | "V4_READY"
  | "STG03_RECORDED"
  | "AMD_ACCEPTED"
  | "PROJECTION_CURRENT"
  | "REVIEW_REQUESTED"
  | "REVIEW_SATISFIED"
  | "NEEDS_RECONCILIATION";

interface CloseObservation {
  readonly stateVersion: number;
  readonly historyVersion: number;
  readonly migrationAuthorization: "absent" | "valid" | "invalid";
  readonly migrationCompletion: "absent" | "valid" | "invalid";
  readonly progressSequence: number;
  readonly amdAcceptance: "absent" | "accepted" | "partial" | "invalid";
  readonly projection: "absent" | "pending" | "current" | "stale" | "invalid";
  readonly projectionWatermarkSequence: number | null;
  readonly review: "absent" | "requested" | "satisfied" | "invalid";
}

interface CloseState {
  readonly phase: ClosePhase;
  readonly contradictionCodes: readonly string[];
}

interface ReviewedMigrationReceipt {
  readonly status: "migrated" | "already_current";
  readonly importedProgressEvents: 3;
  readonly lastProgressEventSha256: typeof REVIEWED_LAST_EVENT_SHA256;
  readonly backupPath: string;
  readonly guardPath: string;
  readonly graphExecution: "disabled";
}

interface ReviewedV4MigrationProcess {
  inspectExactOperation(): {
    readonly authorization: "absent" | "valid" | "invalid";
    readonly completion: "absent" | "valid" | "invalid";
    readonly completedReceipt?: Readonly<Record<string, unknown>>;
  };
  migrateExactOperation(): Promise<ReviewedMigrationReceipt>;
  close(): void;
}

interface Stg04CloseService {
  status(): CloseState;
  prepare(input: {
    readonly acceptedAt: number;
    readonly publishedAt: number;
  }): Promise<CloseState>;
  close(): void;
}

interface Stg04CloseRuntime {
  createStg04CloseService(input: {
    readonly stateRoot: string;
    readonly repositoryRoot: string;
    readonly migration: ReviewedV4MigrationProcess;
    readonly openStateDatabaseAccess: () => StateDatabaseAccess;
    readonly faultInjector?: (point: string) => void;
  }): Stg04CloseService;
}

const repo = resolve(".");
const launcher = resolve("scripts/agent-collab-launcher.mjs");
const fixtures: ProgressFixture[] = [];
const scratchRoots: string[] = [];
const closeables: Array<{ close(): void }> = [];

function newFixture(): ProgressFixture {
  const fixture = createProgressFixture();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const closeable of closeables.splice(0).reverse()) closeable.close();
  for (const fixture of fixtures.splice(0)) removeProgressFixture(fixture);
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => removeTestReviewedV4RemoteRef());

async function loadOfflineQuiescence(): Promise<(ports: QuiescencePorts) => OfflineMigrationQuiescence> {
  const module = await import(pathToFileURL(resolve("src/migration/offline-quiescence.ts")).href);
  return module.createOfflineMigrationQuiescence as (ports: QuiescencePorts) => OfflineMigrationQuiescence;
}

async function loadCloseReducer(): Promise<(observation: CloseObservation) => CloseState> {
  const module = await import(pathToFileURL(resolve("src/app/stg04-close-aggregate.ts")).href);
  return module.deriveStg04CloseState as (observation: CloseObservation) => CloseState;
}

async function loadProductionMigrationFactory(): Promise<(
  input: {
    readonly stateRoot: string;
    readonly sourceAcceptanceReceiptSha256: string;
    readonly promotionTrust?: ReturnType<typeof reviewedV4TestTrust>;
    readonly faultInjector?: (point: "after_v4_coordinator_return") => void;
  },
) => ReviewedV4MigrationProcess> {
  const module = await import(pathToFileURL(resolve("src/migration/reviewed-v4-production-process.ts")).href);
  return module.createProductionReviewedV4MigrationProcess as (
    input: {
      readonly stateRoot: string;
      readonly sourceAcceptanceReceiptSha256: string;
      readonly promotionTrust?: ReturnType<typeof reviewedV4TestTrust>;
      readonly faultInjector?: (point: "after_v4_coordinator_return") => void;
    },
  ) => ReviewedV4MigrationProcess;
}

async function loadProductionRecovery(): Promise<(input: {
  readonly stateRoot: string;
  readonly predecessorSourceAcceptanceReceiptSha256: string;
  readonly externalPromotionPath: string;
  readonly promotionTrust: ReturnType<typeof reviewedV4TestTrust>;
  readonly faultInjector?: (point: "after_recovery_acceptance") => void;
}) => Promise<{
  readonly sourceAcceptance: { readonly receiptSha256: string; readonly created: boolean };
  readonly migration: ReviewedMigrationReceipt;
}>> {
  const module = await import(pathToFileURL(resolve("src/migration/reviewed-v4-production-process.ts")).href);
  return module.recoverProductionReviewedV4Source as Awaited<ReturnType<typeof loadProductionRecovery>>;
}

async function loadCloseRuntime(): Promise<Stg04CloseRuntime> {
  const module = await import(pathToFileURL(resolve("src/app/stg04-close-service.ts")).href);
  return { createStg04CloseService: module.createStg04CloseService as Stg04CloseRuntime["createStg04CloseService"] };
}

function productionMigration(
  createProcess: Awaited<ReturnType<typeof loadProductionMigrationFactory>>,
  fixture: ProgressFixture,
  faultInjector?: (point: "after_v4_coordinator_return") => void,
): ReviewedV4MigrationProcess {
  return createProcess({
    stateRoot: fixture.stateRoot,
    sourceAcceptanceReceiptSha256: adoptTestReviewedV4SourceAcceptance(fixture.stateRoot),
    promotionTrust: reviewedV4TestTrust(),
    ...(faultInjector ? { faultInjector } : {}),
  });
}

function migrationAuthorityBinding(fixture: ProgressFixture, operationId = "stg04-production-close") {
  const root = statSync(fixture.stateRoot);
  const state = statSync(fixture.databasePath);
  const history = statSync(fixture.historyPath);
  const stateObservation = observeLegacyDatabase(fixture.databasePath, "state");
  const historyObservation = observeLegacyDatabase(fixture.historyPath, "history");
  return {
    operationId,
    consumer: "codex:/root:state-v4-reviewed-bootstrap" as const,
    scope: "reviewed-state-v4-migration" as const,
    adoptionSha256: "7".repeat(64),
    promotionSha256: "8".repeat(64),
    sourceIdentity: {
      commitOid: REVIEWED_COMMIT,
      treeOid: REVIEWED_TREE,
      manifestSha256: "6".repeat(64),
      lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
    } as const,
    targetIdentity: {
      root: { path: fixture.stateRoot, dev: root.dev, ino: root.ino },
      state: {
        path: fixture.databasePath,
        dev: state.dev,
        ino: state.ino,
        userVersion: stateObservation.userVersion,
        bytesSha256: stateObservation.bytesSha256,
        manifestSha256: stateObservation.manifestSha256,
      },
      history: {
        path: fixture.historyPath,
        dev: history.dev,
        ino: history.ino,
        userVersion: historyObservation.userVersion,
        bytesSha256: historyObservation.bytesSha256,
        manifestSha256: historyObservation.manifestSha256,
      },
    },
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
  };
}

function databaseVersions(fixture: ProgressFixture): { state: number; history: number } {
  const read = (path: string): number => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try { return Number(db.pragma("user_version", { simple: true })); }
    finally { db.close(); }
  };
  return { state: read(fixture.databasePath), history: read(fixture.historyPath) };
}

function defaultObservation(overrides: Partial<CloseObservation> = {}): CloseObservation {
  return {
    stateVersion: 3,
    historyVersion: 2,
    migrationAuthorization: "absent",
    migrationCompletion: "absent",
    progressSequence: 0,
    amdAcceptance: "absent",
    projection: "absent",
    projectionWatermarkSequence: null,
    review: "absent",
    ...overrides,
  };
}

function projectionEvents(fixture: ProgressFixture): JsonObject[] {
  const path = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/IMPLEMENTATION_PROGRESS.jsonl");
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JsonObject);
}

describe("STG-04 production migration authority boundary", () => {
  it("denies the legacy public migrate-v4 command before creating a state layout", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-stg04-cli-red-"));
    scratchRoots.push(root);
    const stateRoot = join(root, "must-not-exist");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const systemctl = join(bin, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\nexit 3\n");
    chmodSync(systemctl, 0o755);
    const result = spawnSync(process.execPath, [launcher, "migrate-v4"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, AGENT_COLLAB_STATE_DIR: stateRoot, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/reviewed|authorized|stg04-close|disabled|unavailable|quarantined/i);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("binds one adoption to the exact STG-04 operation and adopted database bytes", () => {
    const fixture = newFixture();
    const authority = createReviewedV4MigrationAuthority({ stateRoot: fixture.stateRoot });
    closeables.push(authority);

    expect(() => authority.issuer.issue(migrationAuthorityBinding(fixture, "other-operation")))
      .toThrow(/scope|operation|reviewed source/i);

    const adoptedBinding = migrationAuthorityBinding(fixture);
    const database = new Database(fixture.databasePath);
    try {
      database.pragma("application_id = 42");
    } finally {
      database.close();
    }
    expect(() => authority.issuer.issue(adoptedBinding)).toThrow(/adopted target|contents|bytes|manifest/i);
  });

});

describe("offline migration quiescence", () => {
  it.each([
    {
      name: "active managed service",
      ports: (fixture: ProgressFixture): QuiescencePorts => ({
        serviceState: () => "active",
        scanSameUidOpenFiles: () => ({ files: [], unreadableSameUidPids: [] }),
        stat: (path) => statSync(path),
        acquireFence: () => ({ assertCurrent: () => undefined, release: () => undefined }),
      }),
      invoke: (quiescence: OfflineMigrationQuiescence, fixture: ProgressFixture) =>
        quiescence.assertServiceInactive({ stateDatabase: fixture.databasePath, historyDatabase: fixture.historyPath }),
      error: /service.*active|inactive.*required/i,
    },
    {
      name: "open SQLite sidecar descriptor",
      ports: (fixture: ProgressFixture): QuiescencePorts => {
        const identity = statSync(fixture.databasePath);
        return {
          serviceState: () => "inactive",
          scanSameUidOpenFiles: () => ({
            files: [{ pid: process.pid, path: `${fixture.databasePath}-wal`, dev: identity.dev, ino: identity.ino }],
            unreadableSameUidPids: [],
          }),
          stat: (path) => statSync(path),
          acquireFence: () => ({ assertCurrent: () => undefined, release: () => undefined }),
        };
      },
      invoke: (quiescence: OfflineMigrationQuiescence, fixture: ProgressFixture) =>
        quiescence.assertNoOpenDatabaseFds({ stateDatabase: fixture.databasePath, historyDatabase: fixture.historyPath }),
      error: /open.*(database|sqlite|sidecar|descriptor)|wal/i,
    },
    {
      name: "unreadable same-UID proc entry",
      ports: (fixture: ProgressFixture): QuiescencePorts => ({
        serviceState: () => "inactive",
        scanSameUidOpenFiles: () => ({ files: [], unreadableSameUidPids: [4242] }),
        stat: (path) => statSync(path),
        acquireFence: () => ({ assertCurrent: () => undefined, release: () => undefined }),
      }),
      invoke: (quiescence: OfflineMigrationQuiescence, fixture: ProgressFixture) =>
        quiescence.assertNoOpenDatabaseFds({ stateDatabase: fixture.databasePath, historyDatabase: fixture.historyPath }),
      error: /proc|unreadable|incomplete|same.uid/i,
    },
  ])("fails closed for $name after authority issuance without further effects", async ({ ports, invoke, error }) => {
    const createQuiescence = await loadOfflineQuiescence();
    const fixture = newFixture();
    const authority = createReviewedV4MigrationAuthority({ stateRoot: fixture.stateRoot });
    closeables.push(authority);
    authority.issuer.issue(migrationAuthorityBinding(fixture));
    const afterIssuance = migrationSurfaceSnapshot(fixture);
    const quiescence = createQuiescence(ports(fixture));

    expect(() => invoke(quiescence, fixture)).toThrow(error);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(afterIssuance);
  });

  it("detects database inode drift while the exclusive fence is held and releases the lower fence once", async () => {
    const createQuiescence = await loadOfflineQuiescence();
    const fixture = newFixture();
    const authority = createReviewedV4MigrationAuthority({ stateRoot: fixture.stateRoot });
    closeables.push(authority);
    authority.issuer.issue(migrationAuthorityBinding(fixture));
    const identities = new Map([
      [fixture.databasePath, statSync(fixture.databasePath)],
      [fixture.historyPath, statSync(fixture.historyPath)],
    ]);
    let stateDrifted = false;
    let releases = 0;
    const quiescence = createQuiescence({
      serviceState: () => "inactive",
      scanSameUidOpenFiles: () => ({ files: [], unreadableSameUidPids: [] }),
      stat(path) {
        const original = identities.get(path)!;
        return stateDrifted && path === fixture.databasePath
          ? { dev: original.dev, ino: original.ino + 1 }
          : original;
      },
      acquireFence: () => ({ assertCurrent: () => undefined, release: () => { releases += 1; } }),
    });
    const pair = { stateDatabase: fixture.databasePath, historyDatabase: fixture.historyPath };
    const lease = quiescence.acquireExclusiveWriteFence(pair);
    stateDrifted = true;

    expect(() => lease.assertCurrent()).toThrow(/identity|inode|drift|replaced/i);
    lease.release();
    lease.release();
    expect(releases).toBe(1);
  });
});

describe("reviewed v4 production migration process", () => {
  it("preserves inert legacy runs and published dispatch evidence without treating it as activation", async () => {
    const createProcess = await loadProductionMigrationFactory();
    const fixture = newFixture();
    const database = new Database(fixture.databasePath);
    try {
      database.exec(`
        INSERT INTO runs(id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
        VALUES('legacy-terminal','legacy-terminal','review',1,'completed',1,1);
        INSERT INTO collaboration_runs VALUES('legacy-workflow','{"status":"completed"}',1,2);
        INSERT INTO collaboration_dispatch_outbox
          (dispatch_id,workflow_id,payload_json,published_at,terminal_reason)
        VALUES('legacy-dispatch','legacy-workflow','{}',3,NULL);
      `);
    } finally { database.close(); }
    const migration = productionMigration(createProcess, fixture);
    closeables.push(migration);

    await expect(migration.migrateExactOperation()).resolves.toMatchObject({ status: "migrated" });
    const migrated = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(migrated.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(1);
      expect(migrated.prepare("SELECT COUNT(*) FROM collaboration_dispatch_outbox").pluck().get()).toBe(1);
    } finally { migrated.close(); }
  }, 120_000);

  it.each([
    ["queued legacy run", "UPDATE runs SET status='queued' WHERE id='legacy-terminal'", /executable.*legacy runs/i],
    ["owned legacy run", "UPDATE runs SET worker_id='worker' WHERE id='legacy-terminal'", /owned legacy runs/i],
    ["unpublished legacy dispatch", "UPDATE collaboration_dispatch_outbox SET published_at=NULL", /unpublished legacy dispatches/i],
  ])("rejects %s at the reviewed boundary", async (_label, sql, message) => {
    const createProcess = await loadProductionMigrationFactory();
    const fixture = newFixture();
    const database = new Database(fixture.databasePath);
    try {
      database.exec(`
        INSERT INTO runs(id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
        VALUES('legacy-terminal','legacy-terminal','review',1,'completed',1,1);
        INSERT INTO collaboration_runs VALUES('legacy-workflow','{"status":"completed"}',1,2);
        INSERT INTO collaboration_dispatch_outbox
          (dispatch_id,workflow_id,payload_json,published_at,terminal_reason)
        VALUES('legacy-dispatch','legacy-workflow','{}',3,NULL);
      `);
    } finally { database.close(); }
    const migration = productionMigration(createProcess, fixture);
    closeables.push(migration);
    await migration.migrateExactOperation();
    const mutate = new Database(fixture.databasePath);
    try { mutate.exec(sql); } finally { mutate.close(); }

    expect(() => verifyCurrentReviewedV4Database(fixture.databasePath)).toThrow(message);
  }, 120_000);

  it("runs the authorized migration in-process, imports exactly events 1..3, preserves history and replays", async () => {
    const createProcess = await loadProductionMigrationFactory();
    const fixture = newFixture();
    const historyBefore = readFileSync(fixture.historyPath);
    const migration = productionMigration(createProcess, fixture);
    closeables.push(migration);
    const first = await migration.migrateExactOperation();
    expect(first).toMatchObject({
      status: "migrated",
      importedProgressEvents: 3,
      lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
      graphExecution: "disabled",
    });
    expect(databaseVersions(fixture)).toEqual({ state: 4, history: 2 });
    expect(readFileSync(fixture.historyPath)).toEqual(historyBefore);
    expect(progressRows(fixture.databasePath).events.map(({ sequence_no, event_sha256 }) => ({ sequence_no, event_sha256 })))
      .toEqual([
        { sequence_no: 1, event_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { sequence_no: 2, event_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { sequence_no: 3, event_sha256: REVIEWED_LAST_EVENT_SHA256 },
      ]);
    expect(existsSync(first.backupPath)).toBe(true);
    expect(existsSync(first.guardPath)).toBe(true);

    const stable = migrationSurfaceSnapshot(fixture);
    const replay = await migration.migrateExactOperation();
    expect(replay).toMatchObject({ status: "already_current", importedProgressEvents: 3 });
    expect(migrationSurfaceSnapshot(fixture)).toEqual(stable);
  }, 120_000);

  it("reopens after a crash between the v4 commit and completion publication", async () => {
    const createProcess = await loadProductionMigrationFactory();
    const fixture = newFixture();
    let armed = true;
    const migration = productionMigration(createProcess, fixture,
      (point) => {
        if (armed && point === "after_v4_coordinator_return") throw new Error(point);
      });
    await expect(migration.migrateExactOperation())
      .rejects.toThrow(/after_v4_coordinator_return/);
    expect(databaseVersions(fixture)).toEqual({ state: 4, history: 2 });
    migration.close();

    armed = false;
    const reopened = productionMigration(createProcess, fixture);
    closeables.push(reopened);
    expect(reopened.inspectExactOperation()).toEqual(expect.objectContaining({
      authorization: "valid",
      completion: "absent",
    }));
    await expect(reopened.migrateExactOperation())
      .resolves.toMatchObject({
        status: "already_current",
        importedProgressEvents: 3,
        lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
      });
    expect(reopened.inspectExactOperation()).toEqual(expect.objectContaining({
      authorization: "valid",
      completion: "valid",
    }));
  }, 120_000);

  it("accepts a reviewed recovery source and completes an exact post-commit migration generation", async () => {
    const [createProcess, recover, runtime] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
      loadCloseRuntime(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const interrupted = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
      faultInjector(point) {
        if (point === "after_v4_coordinator_return") throw new Error("simulated post-commit failure");
      },
    });
    await expect(interrupted.migrateExactOperation()).rejects.toThrow(/post-commit failure/i);
    interrupted.close();
    expect(databaseVersions(fixture)).toEqual({ state: 4, history: 2 });

    const packet = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "reviewed-v4-recovery-candidate"; },
    });
    scratchRoots.push(packet.directory);
    const recovered = await recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    });
    expect(recovered).toMatchObject({
      sourceAcceptance: { created: true, receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      migration: { status: "already_current", graphExecution: "disabled" },
    });

    const replay = await recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    });
    expect(replay.sourceAcceptance).toMatchObject({
      created: false,
      receiptSha256: recovered.sourceAcceptance.receiptSha256,
    });
    expect(replay.migration).toMatchObject({ status: "already_current" });

    amendmentFixture(fixture);
    const recoveredMigration = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: recovered.sourceAcceptance.receiptSha256,
      promotionTrust: packet.trust,
    });
    const close = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration: recoveredMigration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(close, recoveredMigration);
    await expect(close.prepare({ acceptedAt: AMD_ACCEPTED_AT, publishedAt: AMD_ACCEPTED_AT + 1_000 }))
      .resolves.toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    expect(close.status()).toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
  }, 120_000);

  it("replays one immutable recovery generation after a crash before completion", async () => {
    const [createProcess, recover] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const interrupted = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
      faultInjector() { throw new Error("simulated post-commit failure"); },
    });
    await expect(interrupted.migrateExactOperation()).rejects.toThrow(/post-commit failure/i);
    interrupted.close();
    const packet = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "reviewed-v4-recovery-crash-candidate"; },
    });
    scratchRoots.push(packet.directory);

    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
      faultInjector() { throw new Error("simulated recovery acceptance crash"); },
    })).rejects.toThrow(/recovery acceptance crash/i);
    expect(() => openStateDatabaseLease(fixture.databasePath, "mutating_service"))
      .toThrow(/recovery.*pending.*completion/i);

    const conflicting = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "conflicting-recovery-successor"; },
    });
    scratchRoots.push(conflicting.directory);
    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: conflicting.promotionPath,
      promotionTrust: conflicting.trust,
    })).rejects.toThrow(/fork.*reconciliation/i);

    const recovered = await recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    });
    expect(recovered.sourceAcceptance.created).toBe(false);
    expect(recovered.migration).toMatchObject({ status: "already_current" });
  }, 120_000);

  it.each([
    ["v4 state bytes", (fixture: ProgressFixture) => {
      const database = new Database(fixture.databasePath);
      try { database.prepare("UPDATE plan_progress_outbox SET terminal_reason='tampered' WHERE rowid=1").run(); }
      finally { database.close(); }
    }],
    ["history bytes", (fixture: ProgressFixture) => {
      const database = new Database(fixture.historyPath);
      try { database.pragma("application_id = 17"); }
      finally { database.close(); }
    }],
    ["restore guard", (fixture: ProgressFixture) => {
      appendStateV4GuardEvent(fixture.stateRoot, "service_reopened");
    }],
    ["migration authorization", (fixture: ProgressFixture) => {
      const path = join(fixture.stateRoot,
        "migration-v4/authority/stg04-production-close.authorization.json");
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
    }],
    ["restore descriptor", (fixture: ProgressFixture) => {
      const path = join(fixture.stateRoot, "migration-v4/active-restore-guard.json");
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
    }],
  ] as const)("rejects post-acceptance drift in %s without publishing completion", async (_label, mutate) => {
    const [createProcess, recover] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const interrupted = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
      faultInjector() { throw new Error("simulated post-commit failure"); },
    });
    await expect(interrupted.migrateExactOperation()).rejects.toThrow(/post-commit failure/i);
    interrupted.close();
    const packet = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = `drift-recovery-${_label}`; },
    });
    scratchRoots.push(packet.directory);
    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
      faultInjector() { throw new Error("simulated recovery acceptance crash"); },
    })).rejects.toThrow(/recovery acceptance crash/i);

    mutate(fixture);
    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    })).rejects.toThrow();
    expect(existsSync(join(fixture.stateRoot,
      "migration-v4/authority/stg04-production-close.completion.json"))).toBe(false);
  }, 120_000);

  it("completes a linear two-generation recovery chain and releases one leaf-bound barrier", async () => {
    const [createProcess, recover] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const interrupted = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
      faultInjector() { throw new Error("simulated post-commit failure"); },
    });
    await expect(interrupted.migrateExactOperation()).rejects.toThrow(/post-commit failure/i);
    interrupted.close();
    const first = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "recovery-source-generation-a"; },
    });
    scratchRoots.push(first.directory);
    let firstRecoverySha256 = "";
    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: first.promotionPath,
      promotionTrust: first.trust,
      faultInjector() {
        const names = readdirSync(join(fixture.stateRoot,
          "migration-v4/source-acceptance/recoveries"));
        firstRecoverySha256 = names[0]!.slice(0, -5);
        throw new Error("first recovery generation interrupted");
      },
    })).rejects.toThrow(/first recovery generation interrupted/i);
    const second = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "recovery-source-generation-b"; },
    });
    scratchRoots.push(second.directory);
    const recovered = await recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: firstRecoverySha256,
      externalPromotionPath: second.promotionPath,
      promotionTrust: second.trust,
    });
    expect(recovered.migration.status).toBe("already_current");
    const access = openStateDatabaseLease(fixture.databasePath, "mutating_service");
    access.close();
    const marker = JSON.parse(readFileSync(join(fixture.stateRoot,
      `migration-v4/source-acceptance/recovery-completions/${recovered.sourceAcceptance.receiptSha256}.json`),
    "utf8")) as { recoveryChainSha256: string[] };
    expect(marker.recoveryChainSha256).toEqual([
      firstRecoverySha256,
      recovered.sourceAcceptance.receiptSha256,
    ]);
  }, 120_000);

  it("does not create recovery evidence for an already completed migration generation", async () => {
    const [createProcess, recover] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const migration = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
    });
    await migration.migrateExactOperation();
    migration.close();
    const packet = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "unneeded-recovery-candidate"; },
    });
    scratchRoots.push(packet.directory);

    await expect(recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    })).rejects.toThrow(/no existing exact acceptance/i);
    expect(existsSync(join(fixture.stateRoot,
      "migration-v4/source-acceptance/recoveries"))).toBe(false);
  }, 120_000);

  it("ignores exact non-authoritative publisher temps across dead and reused PIDs", async () => {
    const [createProcess, recover] = await Promise.all([
      loadProductionMigrationFactory(),
      loadProductionRecovery(),
    ]);
    const fixture = newFixture();
    const adoptionSha256 = adoptTestReviewedV4SourceAcceptance(fixture.stateRoot);
    const interrupted = createProcess({
      stateRoot: fixture.stateRoot,
      sourceAcceptanceReceiptSha256: adoptionSha256,
      promotionTrust: reviewedV4TestTrust(),
      faultInjector() { throw new Error("simulated post-commit failure"); },
    });
    await expect(interrupted.migrateExactOperation()).rejects.toThrow(/post-commit failure/i);
    interrupted.close();
    const recoveryDirectory = join(fixture.stateRoot, "migration-v4/source-acceptance/recoveries");
    mkdirSync(recoveryDirectory, { recursive: true });
    const tempNames = [
      `.${"a".repeat(64)}.json.99999999.12345678-1234-4123-8123-123456789abc.tmp`,
      `.${"b".repeat(64)}.json.${process.pid}.abcdefab-cdef-4abc-8abc-abcdefabcdef.tmp`,
    ];
    expect(existsSync("/proc/99999999")).toBe(false);
    for (const name of tempNames) {
      writeFileSync(join(recoveryDirectory, name), "interrupted unpublished bytes", { mode: 0o600 });
    }
    const packet = createTestReviewedV4Promotion({
      mutateDraft(draft) { draft.promotionId = "recovery-after-orphan-temp"; },
    });
    scratchRoots.push(packet.directory);

    const recovered = await recover({
      stateRoot: fixture.stateRoot,
      predecessorSourceAcceptanceReceiptSha256: adoptionSha256,
      externalPromotionPath: packet.promotionPath,
      promotionTrust: packet.trust,
    });
    expect(recovered.migration.status).toBe("already_current");
    expect(tempNames.every((name) => existsSync(join(recoveryDirectory, name)))).toBe(true);
    const access = openStateDatabaseLease(fixture.databasePath, "mutating_service");
    access.close();
  }, 120_000);
});

describe("STG-04 close aggregate", () => {
  it.each([
    ["PRE_V4", defaultObservation()],
    ["MIGRATION_AUTHORIZED", defaultObservation({ migrationAuthorization: "valid" })],
    ["V4_READY", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 3,
    })],
    ["STG03_RECORDED", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 4,
    })],
    ["AMD_ACCEPTED", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted",
    })],
    ["PROJECTION_CURRENT", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted", projection: "current", projectionWatermarkSequence: 6,
    })],
    ["REVIEW_REQUESTED", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted", projection: "current", projectionWatermarkSequence: 6, review: "requested",
    })],
    ["REVIEW_SATISFIED", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted", projection: "current", projectionWatermarkSequence: 6, review: "satisfied",
    })],
  ] as const)("derives recoverable phase %s from durable owner observations", async (phase, observation) => {
    const derive = await loadCloseReducer();
    expect(derive(observation)).toEqual({ phase, contradictionCodes: [] });
  });

  it.each([
    ["STATE_V4_WITHOUT_COMPLETION", defaultObservation({ stateVersion: 4 })],
    ["MIGRATION_AUTHORITY_INVALID", defaultObservation({ migrationAuthorization: "invalid" })],
    ["MIGRATION_COMPLETION_INVALID", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "invalid", progressSequence: 3,
    })],
    ["AMD_SEQUENCE_PARTIAL", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 5,
      amdAcceptance: "partial",
    })],
    ["PROJECTION_WATERMARK_MISMATCH", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted", projection: "current", projectionWatermarkSequence: 4,
    })],
    ["REVIEW_BEFORE_PROJECTION", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 6,
      amdAcceptance: "accepted", projection: "pending", projectionWatermarkSequence: 4, review: "requested",
    })],
    ["HISTORY_SCHEMA_UNSUPPORTED", defaultObservation({ historyVersion: 1 })],
  ] as const)("returns stable contradiction code %s instead of guessing a phase", async (code, observation) => {
    const derive = await loadCloseReducer();
    expect(derive(observation)).toEqual({ phase: "NEEDS_RECONCILIATION", contradictionCodes: [code] });
  });

  it.each([
    ["PRE_V4_HAS_POST_MIGRATION_STATE", defaultObservation({ progressSequence: 4 })],
    ["PRE_V4_HAS_POST_MIGRATION_STATE", defaultObservation({
      projection: "current", projectionWatermarkSequence: 0,
    })],
    ["MIGRATION_COMPLETION_WITHOUT_AUTHORITY", defaultObservation({
      stateVersion: 4, migrationCompletion: "valid", progressSequence: 3,
    })],
    ["V4_PROGRESS_PREFIX_INCOMPLETE", defaultObservation({
      stateVersion: 4, migrationAuthorization: "valid", migrationCompletion: "valid", progressSequence: 2,
    })],
  ] as const)("rejects impossible cross-state tuple with %s", async (code, observation) => {
    const derive = await loadCloseReducer();
    expect(derive(observation)).toEqual({ phase: "NEEDS_RECONCILIATION", contradictionCodes: [code] });
  });
});

describe("STG-04 close service", () => {
  it("performs migration, exact event 4, exact AMD events 5..6, projection and durable reopen idempotently", async () => {
    const [createMigration, runtime] = await Promise.all([loadProductionMigrationFactory(), loadCloseRuntime()]);
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const migration = productionMigration(createMigration, fixture);
    closeables.push(migration);
    const service = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(service);

    await expect(service.prepare({
      acceptedAt: AMD_ACCEPTED_AT,
      publishedAt: AMD_ACCEPTED_AT + 1_000,
    })).resolves.toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    const rows = progressRows(fixture.databasePath);
    expect(rows.events).toHaveLength(6);
    expect(rows.outbox).toHaveLength(6);
    expect(rows.events[2]!.event_sha256).toBe(REVIEWED_LAST_EVENT_SHA256);
    expect(rows.events[3]!.event_sha256).toBe(STG03_EVENT_SHA256);
    expect(rows.events.slice(4).map(({ event_json }) => (JSON.parse(String(event_json)) as JsonObject).eventType))
      .toEqual(["amendment_accepted", "step_eligible"]);
    expect(JSON.parse(String(rows.events[4]!.event_json))).toMatchObject({
      amendmentSha256: amd.amendment.amendmentSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
    });
    expect(JSON.parse(String(rows.events[5]!.event_json))).toMatchObject({
      stageId: "STG-04",
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
    });
    expect(projectionEvents(fixture)).toHaveLength(6);
    expect(projectionEvents(fixture).at(-1)?.eventSha256).toBe(rows.events[5]!.event_sha256);

    const stableRows = canonicalJson(progressRows(fixture.databasePath));
    service.close();
    closeables.splice(closeables.indexOf(service), 1);
    const reopenedMigration = productionMigration(createMigration, fixture);
    closeables.push(reopenedMigration);
    const reopened = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration: reopenedMigration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(reopened);
    expect(reopened.status()).toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    await expect(reopened.prepare({
      acceptedAt: AMD_ACCEPTED_AT,
      publishedAt: AMD_ACCEPTED_AT + 1_000,
    })).resolves.toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    expect(canonicalJson(progressRows(fixture.databasePath))).toBe(stableRows);
  }, 120_000);

  it("observes the completed close through a read-only state capability without mutating any durable surface", async () => {
    const [createMigration, runtime] = await Promise.all([loadProductionMigrationFactory(), loadCloseRuntime()]);
    const fixture = newFixture();
    amendmentFixture(fixture);
    const writerMigration = productionMigration(createMigration, fixture);
    closeables.push(writerMigration);
    const writer = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration: writerMigration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(writer);
    await writer.prepare({ acceptedAt: AMD_ACCEPTED_AT, publishedAt: AMD_ACCEPTED_AT + 1_000 });
    writer.close();
    closeables.splice(closeables.indexOf(writer), 1);
    writerMigration.close();
    closeables.splice(closeables.indexOf(writerMigration), 1);

    const observerMigration = productionMigration(createMigration, fixture);
    closeables.push(observerMigration);
    const readOnly = openStateDatabaseLease(fixture.databasePath, "offline_observation", { readonly: true });
    closeables.push(readOnly);
    const observer = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration: observerMigration,
      openStateDatabaseAccess: () => readOnly.borrow(),
    });
    closeables.push(observer);
    const before = migrationSurfaceSnapshot(fixture);

    expect(observer.status()).toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
  }, 120_000);

  it("does not expose a caller-supplied AMD trust anchor and rejects attempted anchor injection without effects", async () => {
    const [createMigration, runtime] = await Promise.all([loadProductionMigrationFactory(), loadCloseRuntime()]);
    const fixture = newFixture();
    const migration = productionMigration(createMigration, fixture);
    closeables.push(migration);
    const service = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(service);
    const before = migrationSurfaceSnapshot(fixture);
    const forgedInput = {
      acceptedAt: AMD_ACCEPTED_AT,
      publishedAt: AMD_ACCEPTED_AT + 1_000,
      trustedAuthority: {
        schemaVersion: "trusted-amendment-authority/v1",
        consumer: "attacker",
        expectedReceiptSha256: sha256("forged"),
        authorizationTextSha256: sha256("forged"),
      },
    };

    await expect(service.prepare(forgedInput)).rejects.toThrow(/unknown|strict|trusted.*anchor|input/i);
    expect(migrationSurfaceSnapshot(fixture)).toEqual(before);
  });

  it("demotes completed status when durable recovery evidence is missing", async () => {
    const [createMigration, runtime] = await Promise.all([loadProductionMigrationFactory(), loadCloseRuntime()]);
    const fixture = newFixture();
    amendmentFixture(fixture);
    const migration = productionMigration(createMigration, fixture);
    closeables.push(migration);
    const service = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
    });
    closeables.push(service);
    await service.prepare({ acceptedAt: AMD_ACCEPTED_AT, publishedAt: AMD_ACCEPTED_AT + 1_000 });

    const inspection = migration.inspectExactOperation();
    expect(inspection).toEqual(expect.objectContaining({ authorization: "valid", completion: "valid" }));
    const guardPath = inspection.completedReceipt?.guardPath;
    if (typeof guardPath !== "string") throw new Error("test completion receipt has no guard path");
    rmSync(guardPath);

    expect(service.status()).toEqual({
      phase: "NEEDS_RECONCILIATION",
      contradictionCodes: ["MIGRATION_COMPLETION_INVALID"],
    });
  }, 120_000);

  it.each([
    "after_progress_event_insert",
    "after_amendment_acceptance_event",
    "before_projection_reread",
  ])("recovers the whole close flow after existing crash cut %s without duplicate events", async (failpoint) => {
    const [createMigration, runtime] = await Promise.all([loadProductionMigrationFactory(), loadCloseRuntime()]);
    const fixture = newFixture();
    amendmentFixture(fixture);
    const migration = productionMigration(createMigration, fixture);
    closeables.push(migration);
    let armed = true;
    const service = runtime.createStg04CloseService({
      stateRoot: fixture.stateRoot,
      repositoryRoot: fixture.repositoryRoot,
      migration,
      openStateDatabaseAccess: () => openStateDatabaseLease(fixture.databasePath, "mutating_service"),
      faultInjector(point) {
        if (armed && point === failpoint) throw new Error(`injected crash cut ${point}`);
      },
    });
    closeables.push(service);
    const input = {
      acceptedAt: AMD_ACCEPTED_AT,
      publishedAt: AMD_ACCEPTED_AT + 1_000,
    };

    await expect(service.prepare(input)).rejects.toThrow(new RegExp(failpoint));
    armed = false;
    await expect(service.prepare(input)).resolves.toEqual({ phase: "PROJECTION_CURRENT", contradictionCodes: [] });
    const rows = progressRows(fixture.databasePath);
    expect(rows.events).toHaveLength(6);
    expect(new Set(rows.events.map(({ event_id }) => event_id)).size).toBe(6);
    expect(rows.outbox).toHaveLength(6);
    expect(projectionEvents(fixture)).toHaveLength(6);
  }, 120_000);
});
