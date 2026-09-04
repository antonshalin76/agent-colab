import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

type Permit = {
  nonce: string;
  token: string;
  consumed: boolean;
  targetVersion?: string;
};

type RestoreJournal = {
  action: string;
  nonce: string;
  phase: string;
  targetVersion?: string;
  permits: Record<string, Permit>;
  [key: string]: unknown;
};

type LockMode = "shared" | "exclusive";

const PERMANENTLY_QUARANTINED_RUNTIME_COMMANDS = new Set([
  "worker",
  "mcp",
  "review-mcp",
  "mcp-verify-session",
  "start-normal",
  "prove-normal",
  "verify-unit",
]);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("invalid dispatcher arguments");
    }
    if (flags.has(flag)) throw new Error(`duplicate dispatcher argument ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function acquireLock(mode: LockMode): number {
  const lockPath = requiredEnvironment("AGENT_COLLAB_RESTORE_LOCK");
  const descriptor = openSync(lockPath, "a+", 0o600);
  const result = spawnSync("/usr/bin/flock", ["-n", mode === "shared" ? "-s" : "-x", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", descriptor],
  });
  if (result.error || result.status !== 0) {
    closeSync(descriptor);
    throw new Error(`dispatcher lock busy: ${result.error?.message ?? result.stderr ?? "flock denied"}`);
  }
  return descriptor;
}

function withLock<T>(mode: LockMode, operation: () => T): T {
  const descriptor = acquireLock(mode);
  try {
    return operation();
  } finally {
    closeSync(descriptor);
  }
}

function readJournal(): RestoreJournal {
  const path = requiredEnvironment("AGENT_COLLAB_RESTORE_JOURNAL");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid restore journal");
  }
  const journal = parsed as Partial<RestoreJournal>;
  if (
    typeof journal.action !== "string" ||
    typeof journal.nonce !== "string" ||
    typeof journal.phase !== "string" ||
    !journal.permits ||
    typeof journal.permits !== "object" ||
    Array.isArray(journal.permits)
  ) {
    throw new Error("invalid restore journal");
  }
  return journal as RestoreJournal;
}

function writeJournal(journal: RestoreJournal): void {
  const path = requiredEnvironment("AGENT_COLLAB_RESTORE_JOURNAL");
  const temporary = `${path}.dispatcher-${process.pid}-${Date.now()}.tmp`;
  let temporaryExists = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    temporaryExists = true;
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    temporaryExists = false;
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (temporaryExists && existsSync(temporary)) unlinkSync(temporary);
  }
}

function crashAt(failpoint: string): void {
  if (process.env.AGENT_COLLAB_DISPATCHER_FAILPOINT === failpoint) {
    process.kill(process.pid, "SIGKILL");
  }
}

function validateAndConsume(
  journal: RestoreJournal,
  action: string,
  nonce: string,
  token: string,
  targetVersion?: string,
): void {
  if (journal.nonce !== nonce) throw new Error("invalid dispatcher nonce");
  const permit = journal.permits[action];
  if (!permit || permit.nonce !== nonce || permit.token !== token) {
    throw new Error(`invalid permit for action ${action}`);
  }
  if (permit.consumed) throw new Error(`permit replay: ${action} already consumed`);
  if (targetVersion !== undefined && permit.targetVersion !== targetVersion) {
    throw new Error(`permit target mismatch for action ${action}`);
  }
  if (targetVersion !== undefined && journal.targetVersion !== targetVersion) {
    throw new Error(`journal target mismatch for action ${action}`);
  }
  permit.consumed = true;
}

function consumePermits(
  requests: Array<{ action: string; nonce: string; token: string; targetVersion?: string }>,
  expectedPhase?: string,
  nextPhase?: string,
): RestoreJournal {
  const journal = withLock("exclusive", () => {
    const current = readJournal();
    if (expectedPhase !== undefined && current.phase !== expectedPhase) {
      throw new Error(`maintenance phase ${current.phase} does not allow this action`);
    }
    for (const request of requests) {
      validateAndConsume(current, request.action, request.nonce, request.token, request.targetVersion);
    }
    if (nextPhase !== undefined) current.phase = nextPhase;
    writeJournal(current);
    return current;
  });
  crashAt("after_permit_consume");
  return journal;
}

function runPermittedStatus(flags: Map<string, string>): void {
  const action = requiredFlag(flags, "--action");
  const nonce = requiredFlag(flags, "--nonce");
  const token = requiredFlag(flags, "--permit");
  const expectedAction = ["is_active", "pid", "exec_start"].includes(action) ? action : undefined;
  if (!expectedAction) throw new Error(`invalid action ${action} for status`);
  consumePermits([{ action, nonce, token }], "verifying");
  process.stdout.write(`${JSON.stringify(action === "is_active"
    ? { protocol: "agent-collab/v1", targetVersion: process.env.TARGET_VERSION }
    : { action, targetVersion: process.env.TARGET_VERSION })}\n`);
  crashAt("after_runtime_exec");
}

function runMigrationLock(flags: Map<string, string>): void {
  const nonce = requiredFlag(flags, "--nonce");
  const holdMilliseconds = Number(requiredFlag(flags, "--hold-ms"));
  if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 0) {
    throw new Error("invalid migration lock duration");
  }
  withLock("exclusive", () => {
    if (readJournal().nonce !== nonce) throw new Error("invalid dispatcher nonce");
    const marker = process.env.AGENT_COLLAB_LOCK_HELD_MARKER;
    if (marker) writeFileSync(marker, "locked\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMilliseconds);
  });
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (!command) throw new Error("missing dispatcher command");
  if (PERMANENTLY_QUARANTINED_RUNTIME_COMMANDS.has(command)) {
    throw new Error(`legacy runtime command ${command} is permanently quarantined; use review-worker, review-mcp-codex, or review-mcp-status`);
  }
  const flags = parseFlags(argv);
  if (command === "status") return runPermittedStatus(flags);
  if (command === "migration-lock") return runMigrationLock(flags);
  throw new Error(`unsupported dispatcher command ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
