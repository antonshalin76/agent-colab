import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

type OperationalVersion = "v1" | "v2";
interface OperationalTarget {
  version: OperationalVersion;
  stateDatabase: { path: string; sha256: string };
  historyDatabase: { path: string; sha256: string };
  runtime: { path: string; sha256: string };
  unit: { path: string; sha256: string };
  dispatcher: { path: string; sha256: string; mcpRegistration: string };
  bundle: { path: string; sha256: string };
  serviceWasActive: boolean;
  poisonProviders: string[];
}

type RunnerAction = "restore_v1" | "compensate_v2" | "recover";
type PermitAction =
  | "start_verification"
  | "is_active"
  | "pid"
  | "exec_start"
  | "mcp_initialize"
  | "mcp_list_tools"
  | "start_normal"
  | "prove_normal";

interface RunnerInput {
  action: RunnerAction;
  target?: OperationalVersion;
  journalPath: string;
  lockPath: string;
  dispatcherSource: string;
  activeRuntime: string;
  managedServiceChild: string;
  managedServiceState: string;
  v1Target: OperationalTarget;
  v2Target: OperationalTarget;
}

interface DurablePermit {
  nonce: string;
  token: string;
  consumed: boolean;
  targetVersion?: OperationalVersion;
}

interface RunnerJournal {
  action: RunnerAction;
  nonce: string;
  phase: string;
  targetVersion: OperationalVersion;
  permits: Record<PermitAction, DurablePermit>;
  poisonDetection?: { provider: string; action: string; count: number };
  lastProvenPhase?: string;
}

interface ManagedServiceState {
  managerPid: number;
  workerPid: number;
  isActive: boolean;
  execStart: string;
}

const permitActions: PermitAction[] = [
  "start_verification", "is_active", "pid", "exec_start", "mcp_initialize",
  "mcp_list_tools", "start_normal", "prove_normal",
];

function writeJournal(path: string, journal: RunnerJournal): void {
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function readJournal(path: string): RunnerJournal {
  return JSON.parse(readFileSync(path, "utf8")) as RunnerJournal;
}

function createJournal(input: RunnerInput, target: OperationalVersion): RunnerJournal {
  const nonce = process.env.EXPECTED_NONCE ?? randomUUID();
  const permits = Object.fromEntries(permitActions.map((action) => [action, {
    nonce,
    token: randomUUID(),
    consumed: false,
    ...(action === "start_normal" || action === "prove_normal" ? { targetVersion: target } : {}),
  }])) as Record<PermitAction, DurablePermit>;
  const journal: RunnerJournal = {
    action: input.action,
    nonce,
    phase: "verifying",
    targetVersion: target,
    permits,
  };
  writeJournal(input.journalPath, journal);
  return journal;
}

function dispatcherEnvironment(input: RunnerInput, target: OperationalVersion): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_COLLAB_RESTORE_JOURNAL: input.journalPath,
    AGENT_COLLAB_RESTORE_LOCK: input.lockPath,
    AGENT_COLLAB_ACTIVE_RUNTIME: input.activeRuntime,
    TARGET_VERSION: target,
  };
}

async function dispatch(
  input: RunnerInput,
  target: OperationalVersion,
  args: string[],
  stdin?: string,
): Promise<string> {
  const result = await execa(process.execPath, [
    "--experimental-strip-types", input.dispatcherSource, ...args,
  ], {
    env: dispatcherEnvironment(input, target),
    ...(stdin === undefined ? {} : { input: stdin }),
    reject: false,
    timeout: 5_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`dispatcher ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function auth(journal: RunnerJournal, action: PermitAction): string[] {
  const permit = journal.permits[action];
  return ["--action", action, "--nonce", permit.nonce, "--permit", permit.token];
}

async function verifyOffline(input: RunnerInput, target: OperationalVersion, journal: RunnerJournal): Promise<void> {
  await dispatch(input, target, ["verify-unit", ...auth(journal, "start_verification")]);
  await dispatch(input, target, ["status", ...auth(journal, "is_active")]);
  await dispatch(input, target, ["status", ...auth(journal, "pid")]);
  await dispatch(input, target, ["status", ...auth(journal, "exec_start")]);

  const initialize = { jsonrpc: "2.0", id: 11, method: "initialize", params: {} };
  const tools = { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} };
  const output = await dispatch(input, target, [
    "mcp-verify-session", "--nonce", journal.nonce,
    "--initialize-action", "mcp_initialize",
    "--initialize-permit", journal.permits.mcp_initialize.token,
    "--tools-action", "mcp_list_tools",
    "--tools-permit", journal.permits.mcp_list_tools.token,
  ], `${JSON.stringify(initialize)}\n${JSON.stringify(tools)}\n`);
  const responses = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    id: number;
    result?: { protocolVersion?: string; tools?: Array<{ name: string }> };
  });
  if (responses[0]?.id !== 11 || responses[0].result?.protocolVersion !== "2025-11-25") {
    throw new Error("MCP initialize verification failed");
  }
  if (responses[1]?.id !== 12 || responses[1].result?.tools?.map(({ name }) => name).join(",") !==
    "collab_status,collab_delegate") {
    throw new Error("MCP tools/list verification failed");
  }
}

function observePoison(): { provider: string; action: string; count: number } | undefined {
  const path = process.env.NEGATIVE_PROVIDER_LOG;
  if (!path || !existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return undefined;
  const [provider = "unknown", action = "unknown"] = lines[0]!.split(":", 2);
  return { provider, action, count: lines.length };
}

async function waitForManagedService(path: string): Promise<ManagedServiceState> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const state = JSON.parse(readFileSync(path, "utf8")) as ManagedServiceState;
        if (state.isActive && state.managerPid > 0 && state.workerPid > 0) return state;
      } catch {
        // The manager may be between truncating and completing its state write.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("managed service did not become active");
}

async function waitForPhase(path: string, phase: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      if (readJournal(path).phase === phase) return;
    } catch {
      // Dispatcher journal replacement can briefly race this observation.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`journal did not reach ${phase}`);
}

async function startManagedNormal(
  input: RunnerInput,
  target: OperationalVersion,
  journal: RunnerJournal,
): Promise<void> {
  const permit = journal.permits.start_normal;
  const argv = [
    input.managedServiceState,
    process.execPath,
    "--experimental-strip-types",
    input.dispatcherSource,
    "start-normal",
    "--target", target,
    "--action", "start_normal",
    "--nonce", permit.nonce,
    "--permit", permit.token,
  ];
  const manager = spawn(process.execPath, [input.managedServiceChild, ...argv], {
    detached: true,
    stdio: "ignore",
    env: dispatcherEnvironment(input, target),
  });
  manager.unref();
  await waitForManagedService(input.managedServiceState);
  await waitForPhase(input.journalPath, "normal_started_pending_proof");
}

function managedServiceIsAlive(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as ManagedServiceState;
    process.kill(state.managerPid, 0);
    process.kill(state.workerPid, 0);
    return state.isActive;
  } catch {
    return false;
  }
}

async function proveNormal(input: RunnerInput, target: OperationalVersion): Promise<void> {
  const journal = readJournal(input.journalPath);
  await dispatch(input, target, [
    "prove-normal", "--target", target, ...auth(journal, "prove_normal"),
  ]);
}

async function runFresh(input: RunnerInput): Promise<void> {
  const requestedTarget: OperationalVersion = input.action === "compensate_v2" ? "v2" : "v1";
  let journal = createJournal(input, requestedTarget);
  await verifyOffline(input, requestedTarget, journal);

  const poison = observePoison();
  const target: OperationalVersion = poison ? "v2" : requestedTarget;
  const finalPhase = target === "v1" ? "committed" : "compensated";
  journal = readJournal(input.journalPath);
  journal.targetVersion = target;
  journal.phase = target === "v1" ? "committed_start_pending" : "compensated_start_pending";
  journal.permits.start_normal.targetVersion = target;
  journal.permits.prove_normal.targetVersion = target;
  if (poison) journal.poisonDetection = poison;
  writeJournal(input.journalPath, journal);

  await startManagedNormal(input, target, journal);
  if (process.env.AGENT_COLLAB_OPERATIONAL_FAILPOINT === "after_normal_start") {
    process.kill(process.pid, "SIGKILL");
  }
  await proveNormal(input, target);
  journal = readJournal(input.journalPath);
  if (journal.phase !== finalPhase) throw new Error(`normal proof did not reach ${finalPhase}`);
  if (poison) {
    journal.poisonDetection = poison;
    journal.lastProvenPhase = "compensation_normal_verified";
    writeJournal(input.journalPath, journal);
  }
}

async function recover(input: RunnerInput): Promise<void> {
  let journal = readJournal(input.journalPath);
  const target = input.target ?? journal.targetVersion;
  const pending = target === "v1" ? "committed_start_pending" : "compensated_start_pending";
  const terminal = target === "v1" ? "committed" : "compensated";
  if (journal.phase === terminal) return;
  if (journal.phase === pending) {
    if (!managedServiceIsAlive(input.managedServiceState)) {
      await startManagedNormal(input, target, journal);
    }
  } else if (journal.phase !== "normal_started_pending_proof") {
    throw new Error(`cannot recover operational runner from ${journal.phase}`);
  }
  if (process.env.AGENT_COLLAB_OPERATIONAL_FAILPOINT === "after_normal_start") {
    process.kill(process.pid, "SIGKILL");
  }
  await proveNormal(input, target);
  journal = readJournal(input.journalPath);
  if (journal.phase !== terminal) throw new Error(`normal proof did not reach ${terminal}`);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const inputPath = option(args, "--input");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as RunnerInput;
  if (command === "run") await runFresh(input);
  else if (command === "recover") await recover(input);
  else throw new Error(`unsupported operational runner command: ${command ?? "missing"}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
