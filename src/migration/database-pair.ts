import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

interface PairInput {
  activeLink: string;
  currentRoot: string;
  targetRoot: string;
  stagingRoot: string;
  journalPath: string;
  files: { state: string; history: string };
  failpoint?: string;
}

interface BackupInput extends PairInput {
  sourceRoot: string;
  backupRoot: string;
  backupJournalPath: string;
}

interface BackupFileEvidence {
  path: string;
  sha256: string;
}

interface BackupEvidence {
  currentV2Backup: {
    version: "v2";
    stateDatabase: BackupFileEvidence;
    historyDatabase: BackupFileEvidence;
    wal: { checkpointed: true; sourceWalObserved: boolean; sourceShmObserved: boolean };
    fsync: { stateFile: true; historyFile: true; directory: true; journal: true; journalDirectory: true };
  };
  generation: number;
  phase: string;
  directoryFsynced: true;
  [key: string]: unknown;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  fsyncPath(path);
}

function writeDurableJson(path: string, value: Record<string, unknown>): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

async function sqliteBackup(source: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  rmSync(destination, { force: true });
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try { await database.backup(destination); }
  finally { database.close(); }
  fsyncPath(destination);
}

function crashOrThrow(failpoint: string | undefined, expected: string, processCrash: boolean): void {
  if (failpoint !== expected) return;
  if (processCrash) process.kill(process.pid, "SIGKILL");
  throw new Error(`simulated crash at ${expected}`);
}

function generationRoot(input: PairInput): string {
  return `${input.stagingRoot}.generation`;
}

function activeTarget(input: PairInput): string | undefined {
  try { return lstatSync(input.activeLink).isSymbolicLink() ? readlinkSync(input.activeLink) : undefined; }
  catch { return undefined; }
}

function swapActiveLink(activeLink: string, target: string): void {
  const temporary = `${activeLink}.next-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary, "dir");
  renameSync(temporary, activeLink);
  fsyncDirectory(dirname(activeLink));
}

async function replacePair(input: PairInput, processCrash: boolean): Promise<void> {
  const generation = generationRoot(input);
  if (activeTarget(input) === generation && existsSync(generation)) return;
  rmSync(input.stagingRoot, { recursive: true, force: true });
  mkdirSync(input.stagingRoot, { recursive: true, mode: 0o700 });

  await sqliteBackup(join(input.targetRoot, input.files.state), join(input.stagingRoot, input.files.state));
  crashOrThrow(input.failpoint, "after_first_copy", processCrash);
  crashOrThrow(input.failpoint, "after_first_replacement", false);
  await sqliteBackup(join(input.targetRoot, input.files.history), join(input.stagingRoot, input.files.history));
  crashOrThrow(input.failpoint, "after_history_backup_before_link_swap", false);
  fsyncDirectory(input.stagingRoot);
  crashOrThrow(input.failpoint, "after_pair_staged", processCrash);

  rmSync(generation, { recursive: true, force: true });
  renameSync(input.stagingRoot, generation);
  fsyncDirectory(dirname(generation));
  swapActiveLink(input.activeLink, generation);
  crashOrThrow(input.failpoint, "after_link_swap", processCrash);
}

export async function replaceDatabasePairAtomically(input: Record<string, unknown>): Promise<void> {
  await replacePair(input as unknown as PairInput, false);
}

export async function recoverDatabasePairReplacement(input: Record<string, unknown>): Promise<void> {
  const typed = input as unknown as PairInput;
  if (activeTarget(typed) === generationRoot(typed) && existsSync(generationRoot(typed))) return;
  const { failpoint: _ignored, ...retry } = typed;
  await replacePair(retry, false);
}

export async function abortDatabasePairReplacement(input: Record<string, unknown>): Promise<void> {
  const typed = input as unknown as PairInput;
  if (activeTarget(typed) !== typed.currentRoot) swapActiveLink(typed.activeLink, typed.currentRoot);
  rmSync(typed.stagingRoot, { recursive: true, force: true });
  rmSync(generationRoot(typed), { recursive: true, force: true });
}

async function backupV2(input: BackupInput, failpoint?: string): Promise<void> {
  rmSync(input.backupRoot, { recursive: true, force: true });
  mkdirSync(input.backupRoot, { recursive: true, mode: 0o700 });
  const statePath = join(input.backupRoot, input.files.state);
  const historyPath = join(input.backupRoot, input.files.history);
  await sqliteBackup(join(input.sourceRoot, input.files.state), statePath);
  await sqliteBackup(join(input.sourceRoot, input.files.history), historyPath);
  fsyncDirectory(input.backupRoot);

  const evidence: BackupEvidence = {
    generation: 1,
    phase: "backup_journal_fsynced",
    directoryFsynced: true,
    currentV2Backup: {
      version: "v2",
      stateDatabase: { path: statePath, sha256: sha256(statePath) },
      historyDatabase: { path: historyPath, sha256: sha256(historyPath) },
      wal: {
        checkpointed: true,
        sourceWalObserved: [input.files.state, input.files.history]
          .every((file) => existsSync(join(input.sourceRoot, `${file}-wal`))),
        sourceShmObserved: [input.files.state, input.files.history]
          .every((file) => existsSync(join(input.sourceRoot, `${file}-shm`))),
      },
      fsync: { stateFile: true, historyFile: true, directory: true, journal: true, journalDirectory: true },
    },
  };
  writeDurableJson(input.backupJournalPath, evidence);
  if (failpoint === "after_backup_journal_fsync") process.kill(process.pid, "SIGKILL");
}

function appendAction(path: string | undefined, event: string): void {
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ event })}\n`, { mode: 0o600 });
  fsyncPath(path);
}

function markMutation(path: string | undefined): void {
  if (!path) return;
  writeFileSync(path, "active-data-or-link-mutation\n", { mode: 0o600 });
  fsyncPath(path);
}

function restoreJournalFailure(journalPath: string, evidence: BackupEvidence, failedBackup: string): void {
  writeDurableJson(journalPath, {
    ...evidence,
    generation: evidence.generation + 1,
    phase: "needs_reconciliation",
    lastProvenPhase: "backup_journal_fsynced",
    failedBackup,
    operatorActions: [
      "inspect_backup_integrity", "retain_v1_and_v2_evidence", "recreate_v2_backup",
    ],
  });
}

async function restoreV2FromJournal(input: {
  journalPath: string;
  activeLink: string;
  actionLog?: string;
  mutationMarker?: string;
}): Promise<void> {
  const evidence = JSON.parse(readFileSync(input.journalPath, "utf8")) as BackupEvidence;
  appendAction(input.actionLog, "backup_integrity_check_started");
  const backups = [
    ["stateDatabase", evidence.currentV2Backup.stateDatabase],
    ["historyDatabase", evidence.currentV2Backup.historyDatabase],
  ] as const;
  const failed = backups.find(([, file]) => !existsSync(file.path) || sha256(file.path) !== file.sha256);
  if (failed) {
    appendAction(input.actionLog, "backup_integrity_check_failed");
    restoreJournalFailure(input.journalPath, evidence, failed[0]);
    throw new Error(`retained v2 backup integrity failed: ${failed[0]}`);
  }

  appendAction(input.actionLog, "backup_integrity_check_passed");
  const restoredRoot = join(dirname(input.activeLink), `.v2-restored-${process.pid}`);
  rmSync(restoredRoot, { recursive: true, force: true });
  mkdirSync(restoredRoot, { recursive: true, mode: 0o700 });
  copyFileSync(evidence.currentV2Backup.stateDatabase.path,
    join(restoredRoot, basename(evidence.currentV2Backup.stateDatabase.path)));
  copyFileSync(evidence.currentV2Backup.historyDatabase.path,
    join(restoredRoot, basename(evidence.currentV2Backup.historyDatabase.path)));
  fsyncPath(join(restoredRoot, basename(evidence.currentV2Backup.stateDatabase.path)));
  fsyncPath(join(restoredRoot, basename(evidence.currentV2Backup.historyDatabase.path)));
  fsyncDirectory(restoredRoot);

  markMutation(input.mutationMarker);
  appendAction(input.actionLog, "first_active_mutation_marker_written");
  appendAction(input.actionLog, "active_data_or_link_mutation_started");
  swapActiveLink(input.activeLink, restoredRoot);
  appendAction(input.actionLog, "restore_completed");
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (["replace", "recover", "abort", "backup-v2"].includes(command ?? "")) {
    const input = JSON.parse(readFileSync(argument("--input"), "utf8")) as BackupInput;
    if (command === "replace") {
      const failpoint = optionalArgument("--failpoint");
      await replacePair({ ...input, ...(failpoint ? { failpoint } : {}) }, true);
    } else if (command === "recover") {
      await recoverDatabasePairReplacement(input as unknown as Record<string, unknown>);
    } else if (command === "abort") {
      await abortDatabasePairReplacement(input as unknown as Record<string, unknown>);
    } else {
      await backupV2(input, optionalArgument("--failpoint"));
    }
    return;
  }
  if (command === "restore-v2-from-journal") {
    const actionLog = optionalArgument("--action-log");
    const mutationMarker = optionalArgument("--mutation-marker");
    await restoreV2FromJournal({
      journalPath: argument("--journal"),
      activeLink: argument("--active-link"),
      ...(actionLog ? { actionLog } : {}),
      ...(mutationMarker ? { mutationMarker } : {}),
    });
    return;
  }
  throw new Error(`unsupported database-pair command: ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
