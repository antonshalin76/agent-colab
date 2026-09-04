import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateV4RestoreGuard } from "../src/migration/operational-restore.js";
import { assertPhysicalRestoreAllowed } from "../src/migration/state-v4-restore-authority.js";

const roots: string[] = [];
const digest = (value: string) => value.repeat(64).slice(0, 64);

interface DurablePairBackupEvidence {
  version: "v1" | "v2";
  stateDatabase: { path: string; sha256: string };
  historyDatabase: { path: string; sha256: string };
  wal: { checkpointed: true; sourceWalObserved: boolean; sourceShmObserved: boolean };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("state-v4 restore guard", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-state-v4-guard-"));
    roots.push(root);
    const journalPath = join(root, "state-v4-backup.jsonl");
    const create = (faultInjector?: ConstructorParameters<typeof StateV4RestoreGuard>[0]["faultInjector"]) =>
      new StateV4RestoreGuard({
        journalPath,
        databaseIdentity: digest("a"),
        backupSha256: digest("b"),
        tableDigestManifestSha256: digest("c"),
        writeEpoch: digest("d"),
        ...(faultInjector ? { faultInjector } : {}),
      });
    return { root, journalPath, create };
  };

  it("persists a canonical hash chain and forbids restore after service reopen", () => {
    const fx = fixture();
    const guard = fx.create();
    const backup = guard.createBackupRecord(1);
    expect(backup.event).toBe("backup_created");
    expect(assertPhysicalRestoreAllowed({ writeEpoch: digest("d"), tableDigestManifestSha256: digest("c") },
      guard.readAndVerify(), {
      writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c"),
    })).toEqual(backup);
    const reopened = guard.append("service_reopened", 2);
    expect(reopened.previousRecordSha256).toBe(backup.recordSha256);
    expect(guard.readAndVerify().map(({ event }) => event)).toEqual([
      "backup_created", "service_reopened",
    ]);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, guard.readAndVerify())).toThrow(/forbidden after reopen/i);
  });

  it("durably consumes the only legal restore and rejects replay", () => {
    const guard = fixture().create();
    guard.createBackupRecord(1);
    expect(guard.append("restore_consumed", 2).event).toBe("restore_consumed");
    expect(() => guard.append("restore_consumed", 3)).toThrow(/already consumed/i);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, guard.readAndVerify())).toThrow(/prior restore/i);
  });

  it.each([
    "after_guard_temp_write",
    "after_guard_file_fsync",
    "after_guard_rename",
    "after_guard_directory_fsync",
  ] as const)("fails closed at %s", (point) => {
    const fx = fixture();
    const guard = fx.create((actual) => {
      if (actual === point) throw new Error(`fault:${point}`);
    });
    expect(() => guard.createBackupRecord(1)).toThrow(`fault:${point}`);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, fx.create().readAndVerify()))
      .toThrow(/missing|truncated|malformed|interrupted/i);
  });

  it("rejects truncation, reordered identities, and noncanonical bytes", () => {
    const fx = fixture();
    const guard = fx.create();
    guard.createBackupRecord(1);
    const valid = readFileSync(fx.journalPath, "utf8");
    writeFileSync(fx.journalPath, valid.slice(0, -1));
    expect(() => guard.readAndVerify()).toThrow(/truncated/i);
    writeFileSync(fx.journalPath, valid.replace("{", "{ "));
    expect(() => guard.readAndVerify()).toThrow(/canonical|identity|hash/i);
  });
});

const databasePairModulePath = join(process.cwd(), "src", "migration", "database-pair.ts");
const journalWriterSource = join(process.cwd(), "src", "migration", "journal-writer.ts");

interface DatabasePairModule {
  replaceDatabasePairAtomically(input: Record<string, unknown>): Promise<void>;
  recoverDatabasePairReplacement(input: Record<string, unknown>): Promise<void>;
  abortDatabasePairReplacement(input: Record<string, unknown>): Promise<void>;
}

async function loadDatabasePairModule(): Promise<DatabasePairModule> {
  return await import(databasePairModulePath) as DatabasePairModule;
}

const databaseLabel = (path: string) => {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare("SELECT value FROM identity ORDER BY rowid DESC LIMIT 1").pluck().get() as string;
  } finally {
    database.close();
  }
};

const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function createDatabase(path: string, label: string): void {
  const database = new Database(path);
  database.exec("CREATE TABLE identity(value TEXT NOT NULL)");
  database.prepare("INSERT INTO identity(value) VALUES (?)").run(label);
  database.close();
}

function createCrashWalDatabase(path: string, label: string): void {
  const script = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("journal_mode = WAL");
db.pragma("wal_autocheckpoint = 0");
db.exec("CREATE TABLE identity(value TEXT NOT NULL)");
db.prepare("INSERT INTO identity(value) VALUES (?)").run(process.argv[2]);
process.kill(process.pid, "SIGKILL");
`;
  const result = spawnSync(process.execPath, ["-e", script, path, label], { cwd: process.cwd() });
  expect(result.signal).toBe("SIGKILL");
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(existsSync(`${path}-shm`)).toBe(true);
}

function sqlitePairFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-sqlite-pair-"));
  roots.push(root);
  const currentV2Root = join(root, "v2-retained");
  const targetV1Root = join(root, "v1-retained");
  const stagingRoot = join(root, "staging");
  const activeLink = join(root, "active");
  const journalPath = join(root, "pair-journal.json");
  mkdirSync(currentV2Root);
  mkdirSync(targetV1Root);
  mkdirSync(stagingRoot);
  createCrashWalDatabase(join(currentV2Root, "collaboration.db"), "v2-state");
  createCrashWalDatabase(join(currentV2Root, "history.db"), "v2-history");
  createCrashWalDatabase(join(targetV1Root, "collaboration.db"), "v1-state-wal");
  createCrashWalDatabase(join(targetV1Root, "history.db"), "v1-history-wal");
  symlinkSync(currentV2Root, activeLink, "dir");
  const input = {
    activeLink,
    currentRoot: currentV2Root,
    targetRoot: targetV1Root,
    stagingRoot,
    journalPath,
    files: { state: "collaboration.db", history: "history.db" },
  };
  const labels = () => ({
    state: databaseLabel(join(activeLink, "collaboration.db")),
    history: databaseLabel(join(activeLink, "history.db")),
  });
  return { root, currentV2Root, targetV1Root, stagingRoot, activeLink, journalPath, input, labels };
}

describe("filesystem SQLite/WAL database-pair gate", () => {
  it.each(["stateDatabase", "historyDatabase"] as const)(
    "RB-08 rejects corrupted %s retained backup before changing active data or link",
    (corruptKey) => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    expect(existsSync(join(fx.currentV2Root, "collaboration.db-wal"))).toBe(true);
    expect(existsSync(join(fx.currentV2Root, "history.db-shm"))).toBe(true);
    const inputPath = join(fx.root, "backup-input.json");
    const backupJournalPath = join(fx.root, "durable-v2-backup.json");
    const restoreActionLogPath = join(fx.root, "restore-v2-actions.jsonl");
    const firstActiveMutationMarkerPath = join(fx.root, "first-active-data-or-link-mutation");
    writeFileSync(inputPath, `${JSON.stringify({
      ...fx.input, sourceRoot: fx.currentV2Root, backupRoot: join(fx.root, "v2-backup"),
      backupJournalPath,
    }, null, 2)}\n`);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "backup-v2",
      "--input", inputPath, "--failpoint", "after_backup_journal_fsync",
    ], { encoding: "utf8", timeout: 10_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const evidence = JSON.parse(readFileSync(backupJournalPath, "utf8")) as {
      currentV2Backup: DurablePairBackupEvidence & {
        fsync: { stateFile: true; historyFile: true; directory: true; journal: true; journalDirectory: true };
      };
    };
    expect(evidence.currentV2Backup.wal).toEqual({
      checkpointed: true, sourceWalObserved: true, sourceShmObserved: true,
    });
    expect(fileSha256(evidence.currentV2Backup.stateDatabase.path))
      .toBe(evidence.currentV2Backup.stateDatabase.sha256);
    expect(fileSha256(evidence.currentV2Backup.historyDatabase.path))
      .toBe(evidence.currentV2Backup.historyDatabase.sha256);
    expect(evidence.currentV2Backup.fsync).toEqual({
      stateFile: true, historyFile: true, directory: true, journal: true, journalDirectory: true,
    });
    writeFileSync(evidence.currentV2Backup[corruptKey].path, "corrupted-retained-backup");
    const siblingKey = corruptKey === "stateDatabase" ? "historyDatabase" : "stateDatabase";

    for (const file of ["collaboration.db", "history.db"]) {
      rmSync(join(fx.currentV2Root, file), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-wal`), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-shm`), { force: true });
      createDatabase(join(fx.currentV2Root, file), `mutated-${file}`);
    }
    const activeBeforeRestore = { labels: fx.labels(), link: readlinkSync(fx.activeLink) };
    expect(activeBeforeRestore.labels).toEqual({
      state: "mutated-collaboration.db", history: "mutated-history.db",
    });
    const restored = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "restore-v2-from-journal",
      "--journal", backupJournalPath, "--active-link", fx.activeLink,
      "--action-log", restoreActionLogPath, "--mutation-marker", firstActiveMutationMarkerPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(restored.status).not.toBe(0);
    expect(existsSync(firstActiveMutationMarkerPath)).toBe(false);
    const restoreActions = readFileSync(restoreActionLogPath, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as { event: string });
    expect(restoreActions.map(({ event }) => event)).toEqual([
      "backup_integrity_check_started", "backup_integrity_check_failed",
    ]);
    expect(restoreActions.some(({ event }) => event === "active_data_or_link_mutation_started"))
      .toBe(false);
    expect({ labels: fx.labels(), link: readlinkSync(fx.activeLink) }).toEqual(activeBeforeRestore);
    expect(existsSync(evidence.currentV2Backup.stateDatabase.path)).toBe(true);
    expect(existsSync(evidence.currentV2Backup.historyDatabase.path)).toBe(true);
    expect(fileSha256(evidence.currentV2Backup[siblingKey].path))
      .toBe(evidence.currentV2Backup[siblingKey].sha256);
    expect(JSON.parse(readFileSync(backupJournalPath, "utf8"))).toMatchObject({
      phase: "needs_reconciliation",
      lastProvenPhase: "backup_journal_fsynced",
      failedBackup: corruptKey,
      operatorActions: [
        "inspect_backup_integrity", "retain_v1_and_v2_evidence", "recreate_v2_backup",
      ],
    });
  });

  it("RB-08 calibration writes the marker immediately before the first active mutation for an intact backup", () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const inputPath = join(fx.root, "backup-calibration-input.json");
    const backupJournalPath = join(fx.root, "durable-v2-calibration-backup.json");
    const restoreActionLogPath = join(fx.root, "restore-v2-calibration-actions.jsonl");
    const firstActiveMutationMarkerPath = join(fx.root, "calibration-first-active-mutation");
    writeFileSync(inputPath, `${JSON.stringify({
      ...fx.input, sourceRoot: fx.currentV2Root, backupRoot: join(fx.root, "v2-calibration-backup"),
      backupJournalPath,
    }, null, 2)}\n`);
    const backedUp = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "backup-v2", "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(backedUp.status).toBe(0);
    const evidence = JSON.parse(readFileSync(backupJournalPath, "utf8")) as {
      currentV2Backup: DurablePairBackupEvidence;
    };
    expect(fileSha256(evidence.currentV2Backup.stateDatabase.path))
      .toBe(evidence.currentV2Backup.stateDatabase.sha256);
    expect(fileSha256(evidence.currentV2Backup.historyDatabase.path))
      .toBe(evidence.currentV2Backup.historyDatabase.sha256);

    for (const file of ["collaboration.db", "history.db"]) {
      rmSync(join(fx.currentV2Root, file), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-wal`), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-shm`), { force: true });
      createDatabase(join(fx.currentV2Root, file), `calibration-mutated-${file}`);
    }
    const restored = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "restore-v2-from-journal",
      "--journal", backupJournalPath, "--active-link", fx.activeLink,
      "--action-log", restoreActionLogPath, "--mutation-marker", firstActiveMutationMarkerPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(restored.status).toBe(0);
    expect(existsSync(firstActiveMutationMarkerPath)).toBe(true);
    const restoreEvents = readFileSync(restoreActionLogPath, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => (JSON.parse(line) as { event: string }).event);
    expect(restoreEvents).toEqual([
      "backup_integrity_check_started",
      "backup_integrity_check_passed",
      "first_active_mutation_marker_written",
      "active_data_or_link_mutation_started",
      "restore_completed",
    ]);
    expect(restoreEvents.indexOf("first_active_mutation_marker_written") + 1)
      .toBe(restoreEvents.indexOf("active_data_or_link_mutation_started"));
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
  });

  it.each([
    ["after_first_copy", "recover", { state: "v1-state-wal", history: "v1-history-wal" }],
    ["after_pair_staged", "abort", { state: "v2-state", history: "v2-history" }],
    ["after_link_swap", "recover", { state: "v1-state-wal", history: "v1-history-wal" }],
  ] as const)("RB-09 fresh child %s after SIGKILL %s keeps one visible pair", (failpoint, resolution, expected) => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const inputPath = join(fx.root, "pair-input.json");
    writeFileSync(inputPath, `${JSON.stringify(fx.input, null, 2)}\n`);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "replace",
      "--input", inputPath, "--failpoint", failpoint,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const visibleAfterCrash = fx.labels();
    expect(
      (visibleAfterCrash.state.startsWith("v1-") && visibleAfterCrash.history.startsWith("v1-")) ||
      (visibleAfterCrash.state.startsWith("v2-") && visibleAfterCrash.history.startsWith("v2-")),
    ).toBe(true);
    const fresh = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, resolution, "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(fresh.status).toBe(0);
    expect(fx.labels()).toEqual(expected);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
  });

  it("RB-09 never exposes a mixed active pair after the first replacement and recovers after restart", async () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const firstProcess = await loadDatabasePairModule();
    await expect(firstProcess.replaceDatabasePairAtomically({
      ...fx.input, failpoint: "after_first_replacement",
    })).rejects.toThrow(/after_first_replacement|simulated crash/i);
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
    expect(readlinkSync(fx.activeLink)).toBe(fx.currentV2Root);

    const restartedProcess = await loadDatabasePairModule();
    await restartedProcess.recoverDatabasePairReplacement(fx.input);
    expect(fx.labels()).toEqual({ state: "v1-state-wal", history: "v1-history-wal" });
    expect(readlinkSync(fx.activeLink)).not.toBe(fx.currentV2Root);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
  });

  it("RB-09 aborts staged WAL recovery without mixed visibility and retains both evidence roots", async () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const module = await loadDatabasePairModule();
    await expect(module.replaceDatabasePairAtomically({
      ...fx.input, failpoint: "after_history_backup_before_link_swap",
    })).rejects.toThrow(/after_history_backup_before_link_swap|simulated crash/i);
    await module.abortDatabasePairReplacement(fx.input);
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
    expect(lstatSync(fx.activeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fx.activeLink)).toBe(fx.currentV2Root);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
    expect(existsSync(fx.stagingRoot)).toBe(false);
  });
});
describe("atomic journal writer fresh-process gate", () => {
  it.each([
    ["after_temp_write", 1],
    ["after_file_fsync", 1],
    ["after_rename", 1],
    ["after_directory_fsync", 2],
    ["after_previous_rotation", 2],
  ] as const)("RB-14 SIGKILL %s recovers generation %i", (failpoint, recoveredGeneration) => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-journal-writer-"));
    roots.push(root);
    const journalPath = join(root, "restore-journal.json");
    const payloadPath = join(root, "next.json");
    writeFileSync(journalPath, `${JSON.stringify({ generation: 1, phase: "preflight", directoryFsynced: true })}\n`);
    writeFileSync(`${journalPath}.previous`, `${JSON.stringify({
      generation: 0, phase: "idle", directoryFsynced: true,
    })}\n`);
    writeFileSync(payloadPath, `${JSON.stringify({ generation: 2, phase: "data_restored" })}\n`);
    expect(existsSync(journalWriterSource), "atomic journal writer source must exist").toBe(true);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", journalWriterSource, "write",
      "--journal", journalPath, "--payload", payloadPath, "--failpoint", failpoint,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const recovered = spawnSync(process.execPath, [
      "--experimental-strip-types", journalWriterSource, "recover", "--journal", journalPath,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      generation: recoveredGeneration,
      source: recoveredGeneration === 2 ? "canonical" : "previous",
      integrity: "fsynced",
    });
    const durable = JSON.parse(readFileSync(journalPath, "utf8")) as {
      generation: number; directoryFsynced: boolean;
    };
    expect(durable).toMatchObject({ generation: recoveredGeneration, directoryFsynced: true });
    expect(existsSync(`${journalPath}.tmp`)).toBe(false);
  });
});
