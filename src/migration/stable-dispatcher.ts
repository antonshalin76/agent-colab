import { spawn, spawnSync } from "node:child_process";
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

const terminalPhases = new Set(["committed", "compensated"]);
const sensitiveEnvironmentName =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|AUTHORIZATION|BEARER)(?:$|_)/i;

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

async function withLockAsync<T>(mode: LockMode, operation: () => Promise<T>): Promise<T> {
  const descriptor = acquireLock(mode);
  try {
    return await operation();
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

function sanitizedRuntimeEnvironment(verificationProbe: boolean): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (sensitiveEnvironmentName.test(name)) delete environment[name];
  }
  if (!verificationProbe) {
    delete environment.POISON_INJECT_ACTION;
    delete environment.POISON_INJECT_PROVIDER_ENV;
  }
  return environment;
}

async function runRuntime(
  args: string[],
  input?: string,
  onReady?: () => void,
  verificationProbe = false,
): Promise<{ status: number; stdout: string }> {
  const runtime = requiredEnvironment("AGENT_COLLAB_ACTIVE_RUNTIME");
  const child = spawn(runtime, args, {
    env: sanitizedRuntimeEnvironment(verificationProbe),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let ready = false;
  const markReady = () => {
    if (ready) return;
    onReady?.();
    ready = true;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    markReady();
    stdout.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stdin.on("error", () => { /* A runtime may close stdin before consuming all input. */ });
  child.stdin.end(input);

  const forwardTermination = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const forwardSigterm = () => forwardTermination("SIGTERM");
  const forwardSigint = () => forwardTermination("SIGINT");
  process.once("SIGTERM", forwardSigterm);
  process.once("SIGINT", forwardSigint);
  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  }).finally(() => {
    process.removeListener("SIGTERM", forwardSigterm);
    process.removeListener("SIGINT", forwardSigint);
  });
  if (result.signal) throw new Error(`runtime terminated by ${result.signal}`);
  const status = result.status ?? 1;
  if (status !== 0) throw new Error(`runtime exited with status ${status}`);
  markReady();
  return { status, stdout: Buffer.concat(stdout).toString("utf8") };
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

function waitForReleaseMarker(): void {
  const marker = process.env.AGENT_COLLAB_AFTER_LOCK_MARKER;
  if (marker) writeFileSync(marker, "locked\n");
  const release = process.env.AGENT_COLLAB_AFTER_LOCK_RELEASE;
  if (!release) return;
  const deadline = Date.now() + 5_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for dispatcher lock release marker");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

async function runNormal(command: "worker" | "mcp", input?: string): Promise<void> {
  await withLockAsync("shared", async () => {
    waitForReleaseMarker();
    const journal = readJournal();
    if (!terminalPhases.has(journal.phase)) {
      throw new Error(`maintenance mode: phase ${journal.phase} denies normal dispatch`);
    }
    await runRuntime([command], input);
  });
}

function assertMcpInput(input: string, expectedMethods: string[]): void {
  const lines = input.trim().split("\n").filter(Boolean);
  if (lines.length !== expectedMethods.length) throw new Error("invalid MCP verification request count");
  const methods = lines.map((line) => {
    const request: unknown = JSON.parse(line);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("invalid MCP verification request");
    }
    const candidate = request as { jsonrpc?: unknown; method?: unknown };
    if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
      throw new Error("invalid MCP JSON-RPC request");
    }
    return candidate.method;
  });
  if (methods.some((method, index) => method !== expectedMethods[index])) {
    throw new Error("unexpected MCP verification method sequence");
  }
}

async function runPermittedProbe(command: string, flags: Map<string, string>, input?: string): Promise<void> {
  const action = requiredFlag(flags, "--action");
  const nonce = requiredFlag(flags, "--nonce");
  const token = requiredFlag(flags, "--permit");
  const expectedAction = command === "status"
    ? (["is_active", "pid", "exec_start"].includes(action) ? action : undefined)
    : command === "verify-unit"
      ? "start_verification"
      : action;
  if (!expectedAction || action !== expectedAction) throw new Error(`invalid action ${action} for ${command}`);
  if (command === "mcp") {
    const expectedMethod = action === "mcp_initialize"
      ? "initialize"
      : action === "mcp_list_tools"
        ? "tools/list"
        : undefined;
    if (!expectedMethod || input === undefined) throw new Error(`invalid MCP action ${action}`);
    assertMcpInput(input, [expectedMethod]);
  }
  consumePermits([{ action, nonce, token }], "verifying");
  if (command === "status" && action !== "is_active") {
    process.stdout.write(`${JSON.stringify({ action, targetVersion: process.env.TARGET_VERSION })}\n`);
    crashAt("after_runtime_exec");
    return;
  }
  const runtimeArgs = command === "verify-unit" ? ["verify-unit", "--nonce", nonce] : [command];
  await runRuntime(runtimeArgs, input, undefined, true);
  crashAt("after_runtime_exec");
}

async function runMcpVerificationSession(flags: Map<string, string>, input: string): Promise<void> {
  const nonce = requiredFlag(flags, "--nonce");
  const initializeAction = requiredFlag(flags, "--initialize-action");
  const initializePermit = requiredFlag(flags, "--initialize-permit");
  const toolsAction = requiredFlag(flags, "--tools-action");
  const toolsPermit = requiredFlag(flags, "--tools-permit");
  if (initializeAction !== "mcp_initialize" || toolsAction !== "mcp_list_tools") {
    throw new Error("invalid MCP verification actions");
  }
  assertMcpInput(input, ["initialize", "tools/list"]);
  consumePermits([
    { action: initializeAction, nonce, token: initializePermit },
    { action: toolsAction, nonce, token: toolsPermit },
  ], "verifying");
  await runRuntime(["mcp"], input, undefined, true);
  crashAt("after_runtime_exec");
}

async function runStartNormal(flags: Map<string, string>): Promise<void> {
  const target = requiredFlag(flags, "--target");
  const action = requiredFlag(flags, "--action");
  const nonce = requiredFlag(flags, "--nonce");
  const token = requiredFlag(flags, "--permit");
  if (action !== "start_normal") throw new Error("invalid start-normal action");
  const expectedPhase = target === "v1"
    ? "committed_start_pending"
    : target === "v2"
      ? "compensated_start_pending"
      : undefined;
  if (!expectedPhase) throw new Error(`invalid normal runtime target ${target}`);
  consumePermits(
    [{ action, nonce, token, targetVersion: target }],
    expectedPhase,
  );
  await runRuntime(["worker"], undefined, () => {
    withLock("exclusive", () => {
      const journal = readJournal();
      const permit = journal.permits.start_normal;
      if (
        journal.phase !== expectedPhase ||
        !permit?.consumed ||
        permit.nonce !== nonce ||
        permit.token !== token ||
        permit.targetVersion !== target
      ) {
        throw new Error("normal runtime start evidence no longer matches its durable permit");
      }
      journal.phase = "normal_started_pending_proof";
      writeJournal(journal);
    });
  });
  crashAt("after_runtime_exec");
}

async function runProveNormal(flags: Map<string, string>): Promise<void> {
  const target = requiredFlag(flags, "--target");
  const action = requiredFlag(flags, "--action");
  const nonce = requiredFlag(flags, "--nonce");
  const token = requiredFlag(flags, "--permit");
  if (action !== "prove_normal") throw new Error("invalid prove-normal action");
  if (target !== "v1" && target !== "v2") throw new Error(`invalid normal runtime target ${target}`);
  consumePermits(
    [{ action, nonce, token, targetVersion: target }],
    "normal_started_pending_proof",
  );
  const result = await runRuntime(["status"]);
  crashAt("after_runtime_exec");
  const status = JSON.parse(result.stdout) as { protocol?: unknown; targetVersion?: unknown };
  if (status.protocol !== "agent-collab/v1" || status.targetVersion !== target) {
    throw new Error("normal runtime status proof mismatch");
  }
  withLock("exclusive", () => {
    const journal = readJournal();
    if (journal.phase !== "normal_started_pending_proof") {
      throw new Error(`maintenance phase changed during normal proof: ${journal.phase}`);
    }
    journal.phase = target === "v1" ? "committed" : "compensated";
    writeJournal(journal);
  });
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
  const input = command === "mcp" || command === "mcp-verify-session"
    ? readFileSync(0, "utf8")
    : undefined;
  if (command === "worker") return await runNormal("worker");
  if (command === "mcp" && argv.length === 0) return await runNormal("mcp", input);
  const flags = parseFlags(argv);
  if (command === "status" || command === "verify-unit" || command === "mcp") {
    return await runPermittedProbe(command, flags, input);
  }
  if (command === "mcp-verify-session") {
    if (input === undefined) throw new Error("missing MCP verification input");
    return await runMcpVerificationSession(flags, input);
  }
  if (command === "start-normal") return await runStartNormal(flags);
  if (command === "prove-normal") return await runProveNormal(flags);
  if (command === "migration-lock") return runMigrationLock(flags);
  throw new Error(`unsupported dispatcher command ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
