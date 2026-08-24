import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface JournalPayload {
  generation: number;
  directoryFsynced?: boolean;
  [key: string]: unknown;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  fsyncPath(dirname(path));
}

function readImage(path: string): JournalPayload | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as JournalPayload;
    if (!Number.isInteger(value.generation)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeImage(path: string, image: JournalPayload): void {
  const temporary = `${path}.commit.tmp`;
  writeFileSync(temporary, `${JSON.stringify(image, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncDirectory(path);
}

function crashAt(actual: string | undefined, expected: string): void {
  if (actual === expected) process.kill(process.pid, "SIGKILL");
}

export function writeAtomicJournal(input: {
  journalPath: string;
  payload: JournalPayload;
  failpoint?: string;
}): void {
  const { journalPath, failpoint } = input;
  const temporary = `${journalPath}.tmp`;
  const previous = `${journalPath}.previous`;
  const candidate = { ...input.payload, directoryFsynced: false };

  if (existsSync(journalPath)) {
    const previousTemporary = `${previous}.tmp`;
    copyFileSync(journalPath, previousTemporary);
    fsyncPath(previousTemporary);
    renameSync(previousTemporary, previous);
    fsyncDirectory(previous);
  }

  writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  crashAt(failpoint, "after_temp_write");
  fsyncPath(temporary);
  crashAt(failpoint, "after_file_fsync");

  renameSync(temporary, journalPath);
  crashAt(failpoint, "after_rename");
  fsyncDirectory(journalPath);

  writeImage(journalPath, { ...input.payload, directoryFsynced: true });
  crashAt(failpoint, "after_directory_fsync");
  crashAt(failpoint, "after_previous_rotation");
}

export function recoverAtomicJournal(journalPath: string): {
  generation: number;
  source: "canonical" | "previous";
  integrity: "fsynced";
} {
  const canonical = readImage(journalPath);
  const previous = readImage(`${journalPath}.previous`);
  const interruptedBeforeRename = existsSync(`${journalPath}.tmp`);
  const selected = !interruptedBeforeRename && canonical?.directoryFsynced === true
    ? { image: canonical, source: "canonical" as const }
    : previous?.directoryFsynced === true
      ? { image: previous, source: "previous" as const }
      : undefined;
  if (!selected) throw new Error("no fsynced journal image is recoverable");

  rmSync(`${journalPath}.tmp`, { force: true });
  rmSync(`${journalPath}.commit.tmp`, { force: true });
  writeImage(journalPath, { ...selected.image, directoryFsynced: true });
  return { generation: selected.image.generation, source: selected.source, integrity: "fsynced" };
}

export function writeJournalAtomically(journalPath: string, payload: JournalPayload): void {
  writeAtomicJournal({ journalPath, payload });
}

export function recoverJournal(journalPath: string): ReturnType<typeof recoverAtomicJournal> {
  return recoverAtomicJournal(journalPath);
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "write") {
    const journalPath = argument("--journal");
    const payload = JSON.parse(readFileSync(argument("--payload"), "utf8")) as JournalPayload;
    const failpointIndex = process.argv.indexOf("--failpoint");
    writeAtomicJournal({
      journalPath,
      payload,
      ...(failpointIndex >= 0 ? { failpoint: process.argv[failpointIndex + 1] } : {}),
    });
    return;
  }
  if (command === "recover") {
    process.stdout.write(`${JSON.stringify(recoverAtomicJournal(argument("--journal")))}\n`);
    return;
  }
  throw new Error(`unsupported journal command: ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
