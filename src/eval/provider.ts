import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Effort } from "../domain/routing.js";
import { normalizeCodexResult, type NormalizedCodexEvalResult } from "../runners/codex.js";
import { normalizeGrokResult, type NormalizedGrokEvalResult } from "../runners/grok.js";
import type { CommandSpec } from "../runners/provider-command.js";

type EvalAgent = "codex" | "grok";
type EvalModel = "gpt-5.6-sol" | "grok-4.6";
type Signal = "SIGTERM" | "SIGKILL";

export interface EvalProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: boolean;
}

export interface EvalLaunchedProcess {
  pid?: number;
  result: Promise<EvalProcessResult>;
  terminateGroup(signal: Signal): void | Promise<void>;
  isProcessGroupAlive(): boolean | Promise<boolean>;
}

export interface EvalProcessLauncher {
  launch(
    command: CommandSpec,
    limits?: { maxOutputBytes: number; env?: NodeJS.ProcessEnv },
  ): EvalLaunchedProcess;
}

const PROTOCOL = "agent-collab/v2";
const GROK_TOOLS = "read_file,grep,list_dir,run_terminal_cmd,search_replace";
const CANDIDATE_STATE_ROOT = "/run/agent-collab/state";
const CODEX_RESPONSE_SCHEMA_PATH = `${CANDIDATE_STATE_ROOT}/codex/eval-response-schema.json`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVAL_EFFORTS: ReadonlySet<Effort> = new Set(["medium", "high", "xhigh"]);

function responseSchema(effort: Effort): string {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["protocolVersion", "reasoningEffort", "visibleText"],
    properties: {
      protocolVersion: { type: "string", const: PROTOCOL },
      reasoningEffort: { type: "string", const: effort },
      visibleText: { type: "string", minLength: 1 },
    },
  });
}

export function buildEvalProtocolPrompt(task: string, effort: Effort): string {
  if (!task.trim()) throw new Error("eval task must be non-empty");
  if (!EVAL_EFFORTS.has(effort)) throw new Error("unsupported eval effort");
  return JSON.stringify({
    protocolVersion: PROTOCOL,
    executionDirective: "Execute the task completely in the workspace using the allowed tools before returning the final response. Do not only describe the work.",
    task,
    reasoningEffort: effort,
    responseContract: {
      format: "json",
      exactKeys: ["protocolVersion", "reasoningEffort", "visibleText"],
      protocolVersion: PROTOCOL,
      reasoningEffort: effort,
      visibleText: "non-empty string",
    },
  });
}

export function buildEvalProviderCommand(input: {
  agent: EvalAgent;
  binary: string;
  cwd: string;
  prompt: string;
  effort: Effort;
  timeoutMs: number;
  sessionId?: string;
}): CommandSpec {
  if (!isAbsolute(input.binary) || !isAbsolute(input.cwd)) {
    throw new Error("eval binary and workspace must be absolute");
  }
  if (!EVAL_EFFORTS.has(input.effort)) throw new Error("unsupported eval effort");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("eval timeout must be a positive integer");
  }
  const args = input.agent === "codex"
    ? [
      "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "-m", "gpt-5.6-sol", "-c", `model_reasoning_effort="${input.effort}"`,
      "-C", input.cwd, "-s", "workspace-write", "--output-schema",
      CODEX_RESPONSE_SCHEMA_PATH, "--json", "-",
    ]
    : (() => {
      if (!input.sessionId || !UUID_V4.test(input.sessionId)) {
        throw new Error("Grok eval requires a fresh UUIDv4 session");
      }
      return [
        "--cwd", input.cwd, "--model", "grok-4.6",
        "--reasoning-effort", input.effort, "--single", input.prompt,
        "--verbatim", "--output-format", "json", "--session-id", input.sessionId,
        "--max-turns", "20",
        "--no-plan", "--no-subagents", "--disable-web-search", "--deny", "mcp__*",
        "--sandbox", "strict", "--always-approve", "--tools", GROK_TOOLS,
      ];
    })();
  return {
    file: input.binary,
    args,
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false,
    timeoutMs: input.timeoutMs,
    killProcessGroup: true,
  };
}

function option(args: readonly string[], flag: string): string | null {
  const indices = args.flatMap((value, index) => value === flag ? [index] : []);
  if (indices.length !== 1) return null;
  return args[indices[0]! + 1] ?? null;
}

function requireFlag(args: readonly string[], flag: string, label: string): void {
  if (args.filter((value) => value === flag).length !== 1) throw new Error(`${label} mismatch`);
}

function requireOption(
  args: readonly string[],
  flag: string,
  expected: string,
  label: string,
): void {
  if (option(args, flag) !== expected) throw new Error(`${label} mismatch`);
}

function verifyProtocolPrompt(prompt: string, effort: Effort): void {
  let payload: Record<string, unknown> | null;
  try {
    const parsed: unknown = JSON.parse(prompt);
    payload = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.task !== "string" ||
      buildEvalProtocolPrompt(payload.task, effort) !== prompt) {
    throw new Error("eval response protocol prompt mismatch");
  }
}

export function verifyEvalProviderCommand(input: {
  agent: EvalAgent;
  command: CommandSpec;
  expectedModel: EvalModel;
  expectedEffort: Effort;
  expectedSessionId?: string;
  expectedExecutable?: string;
}): { model: EvalModel; effort: Effort } {
  const { args } = input.command;
  if (!isAbsolute(input.command.file)) throw new Error("provider executable identity mismatch");
  if (input.expectedExecutable &&
      canonicalPath(input.command.file) !== canonicalPath(input.expectedExecutable)) {
    throw new Error("provider executable identity mismatch");
  }
  if (!isAbsolute(input.command.cwd)) throw new Error("workspace mismatch");
  if (!input.command.killProcessGroup || input.command.shell !== false) {
    throw new Error("process group isolation mismatch");
  }
  verifyProtocolPrompt(input.command.stdin, input.expectedEffort);
  if (input.agent === "codex") {
    if (input.expectedModel !== "gpt-5.6-sol") throw new Error("model mismatch");
    if (args[0] !== "exec") throw new Error("Codex exec mismatch");
    requireFlag(args, "--ephemeral", "Codex ephemeral isolation");
    requireFlag(args, "--ignore-user-config", "Codex config isolation");
    requireFlag(args, "--skip-git-repo-check", "Codex Git-free copy");
    requireOption(args, "-m", input.expectedModel, "model");
    requireOption(args, "-c", `model_reasoning_effort="${input.expectedEffort}"`, "effort");
    requireOption(args, "-C", input.command.cwd, "workspace cwd");
    requireOption(args, "-s", "workspace-write", "workspace sandbox");
    requireOption(args, "--output-schema", CODEX_RESPONSE_SCHEMA_PATH, "response schema");
    requireFlag(args, "--json", "JSON output");
    if (args.at(-1) !== "-") throw new Error("JSON stdin mismatch");
  } else {
    if (input.expectedModel !== "grok-4.6") throw new Error("model mismatch");
    requireOption(args, "--model", input.expectedModel, "model");
    requireOption(args, "--reasoning-effort", input.expectedEffort, "effort");
    requireOption(args, "--cwd", input.command.cwd, "workspace cwd");
    if (!input.expectedSessionId || !UUID_V4.test(input.expectedSessionId) ||
        option(args, "--session-id") !== input.expectedSessionId) {
      throw new Error("fresh session mismatch");
    }
    if (option(args, "--single") !== input.command.stdin) {
      throw new Error("one-shot prompt mismatch");
    }
    requireOption(args, "--max-turns", "20", "turn limit");
    requireFlag(args, "--no-plan", "Grok execution mode");
    requireFlag(args, "--no-subagents", "subagent isolation");
    requireFlag(args, "--disable-web-search", "web isolation");
    requireOption(args, "--deny", "mcp__*", "MCP denial");
    requireOption(args, "--sandbox", "strict", "sandbox");
    requireFlag(args, "--always-approve", "approved execution");
    requireOption(args, "--tools", GROK_TOOLS, "semantic tool allowlist");
    requireOption(args, "--output-format", "json", "JSON output");
  }
  const canonical = buildEvalProviderCommand({
    agent: input.agent,
    binary: input.command.file,
    cwd: input.command.cwd,
    prompt: input.command.stdin,
    effort: input.expectedEffort,
    timeoutMs: input.command.timeoutMs,
    ...(input.expectedSessionId ? { sessionId: input.expectedSessionId } : {}),
  });
  if (JSON.stringify(input.command.args) !== JSON.stringify(canonical.args)) {
    throw new Error("provider launch command contains unexpected arguments");
  }
  return { model: input.expectedModel, effort: input.expectedEffort };
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function contained(parent: string, child: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  const path = relative(from, to);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function scaffold(path: string): string[] {
  const parts = resolve(path).split(sep).filter(Boolean);
  const args: string[] = [];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current += `${sep}${part}`;
    args.push("--dir", current);
  }
  return args;
}

export function buildEvalContainment(input: {
  agent: EvalAgent;
  command: CommandSpec;
  attemptRoot: string;
  stateRoot: string;
  authFile: string;
  skillRoot: string;
  allowProviderNetwork?: boolean;
  executableMounts?: readonly { source: string; target: string }[];
  containerExecutable?: string;
}): {
  command: CommandSpec;
  env: Record<"HOME" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME" |
    "XDG_STATE_HOME" | "CODEX_HOME" | "GROK_HOME" | "TMPDIR" | "LANG" | "LC_ALL" |
    "TZ" | "PYTHONDONTWRITEBYTECODE" | "PYTEST_ADDOPTS", string>;
  defaultDenyOutsideAttempt: true;
  state: { hostRoot: string; candidateRoot: typeof CANDIDATE_STATE_ROOT };
} {
  const attemptRoot = resolve(input.attemptRoot);
  const stateRoot = resolve(input.stateRoot);
  if (!isAbsolute(input.attemptRoot) || !isAbsolute(input.stateRoot)) {
    throw new Error("eval containment roots must be absolute");
  }
  if (!isAbsolute(input.authFile) || !isAbsolute(input.skillRoot)) {
    throw new Error("eval auth and skill roots must be absolute");
  }
  if (!existsSync(input.authFile) || !statSync(input.authFile).isFile()) {
    throw new Error("eval auth file is missing");
  }
  if (!existsSync(input.skillRoot) || !statSync(input.skillRoot).isDirectory()) {
    throw new Error("eval skill root is missing");
  }
  if (contained(attemptRoot, stateRoot) || contained(stateRoot, attemptRoot)) {
    throw new Error("eval state root must be separate from the attempt root");
  }
  if (resolve(input.command.cwd) !== attemptRoot) throw new Error("contained command cwd mismatch");
  if (!isAbsolute(input.command.file)) throw new Error("contained command binary must be absolute");
  mkdirSync(attemptRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  if (readdirSync(stateRoot).length !== 0) {
    throw new Error("eval state root must be empty before launch");
  }
  for (const suffix of [
    "home", "xdg/config", "xdg/data", "xdg/cache", "xdg/state", "codex", "grok",
  ]) mkdirSync(join(stateRoot, suffix), { recursive: true });

  const env = {
    HOME: join(CANDIDATE_STATE_ROOT, "home"),
    XDG_CONFIG_HOME: join(CANDIDATE_STATE_ROOT, "xdg", "config"),
    XDG_DATA_HOME: join(CANDIDATE_STATE_ROOT, "xdg", "data"),
    XDG_CACHE_HOME: join(CANDIDATE_STATE_ROOT, "xdg", "cache"),
    XDG_STATE_HOME: join(CANDIDATE_STATE_ROOT, "xdg", "state"),
    CODEX_HOME: join(CANDIDATE_STATE_ROOT, "codex"),
    GROK_HOME: join(CANDIDATE_STATE_ROOT, "grok"),
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTEST_ADDOPTS: "-p no:cacheprovider",
  } as const;
  const args = [
    "--die-with-parent", "--unshare-all",
    ...(input.allowProviderNetwork ? ["--share-net"] : []),
    "--new-session", "--clearenv", "--tmpfs", "/", "--tmpfs", "/tmp",
    "--proc", "/proc", "--dev", "/dev",
  ];
  for (const runtimeRoot of ["/usr", "/bin", "/lib", "/lib64"]) {
    if (existsSync(runtimeRoot)) args.push("--ro-bind", runtimeRoot, runtimeRoot);
  }
  if (input.allowProviderNetwork) {
    for (const runtimeFile of [
      "/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
    ]) {
      if (existsSync(runtimeFile)) {
        args.push(...scaffold(runtimeFile), "--ro-bind", runtimeFile, runtimeFile);
      }
    }
  }
  for (const mount of input.executableMounts ?? []) {
    if (!isAbsolute(mount.source) || !isAbsolute(mount.target) || !existsSync(mount.source)) {
      throw new Error("invalid provider executable mount");
    }
    args.push(...scaffold(mount.target), "--ro-bind", canonicalPath(mount.source), mount.target);
  }
  const commandCoveredByRuntime = ["/usr", "/bin", "/lib", "/lib64"]
    .some((runtimeRoot) => contained(runtimeRoot, input.command.file));
  const commandCoveredByMount = (input.executableMounts ?? [])
    .some((mount) => contained(canonicalPath(mount.source), canonicalPath(input.command.file)));
  if (!commandCoveredByRuntime && !commandCoveredByMount && existsSync(input.command.file)) {
    args.push(...scaffold(input.command.file), "--ro-bind", input.command.file, input.command.file);
  }
  args.push(
    ...scaffold(attemptRoot), "--bind", attemptRoot, attemptRoot,
    ...scaffold(CANDIDATE_STATE_ROOT), "--bind", stateRoot, CANDIDATE_STATE_ROOT,
    "--ro-bind", canonicalPath(input.authFile),
    join(CANDIDATE_STATE_ROOT, input.agent, "auth.json"),
    "--ro-bind", canonicalPath(input.skillRoot),
    join(CANDIDATE_STATE_ROOT, input.agent, "skills"),
    "--setenv", "PATH", "/usr/bin:/bin",
  );
  for (const [name, value] of Object.entries(env)) args.push("--setenv", name, value);
  args.push(
    "--chdir", attemptRoot, "--",
    input.containerExecutable ?? input.command.file,
    ...input.command.args,
  );

  return {
    command: {
      file: "/usr/bin/bwrap",
      args,
      cwd: attemptRoot,
      stdin: input.command.stdin,
      shell: false,
      timeoutMs: input.command.timeoutMs,
      killProcessGroup: true,
    },
    env: { ...env },
    defaultDenyOutsideAttempt: true,
    state: { hostRoot: stateRoot, candidateRoot: CANDIDATE_STATE_ROOT },
  };
}

function codexNativeRelativePath(): string {
  const target = process.platform === "linux" && process.arch === "x64"
    ? ["codex-linux-x64", "x86_64-unknown-linux-musl"]
    : process.platform === "linux" && process.arch === "arm64"
      ? ["codex-linux-arm64", "aarch64-unknown-linux-musl"]
      : process.platform === "darwin" && process.arch === "x64"
        ? ["codex-darwin-x64", "x86_64-apple-darwin"]
        : process.platform === "darwin" && process.arch === "arm64"
          ? ["codex-darwin-arm64", "aarch64-apple-darwin"]
          : null;
  if (!target) throw new Error(`unsupported Codex eval platform: ${process.platform}/${process.arch}`);
  return join(
    "node_modules", "@openai", target[0]!, "vendor", target[1]!, "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

function executableFile(path: string, label: string): string {
  const canonical = canonicalPath(path);
  if (!existsSync(canonical) || !statSync(canonical).isFile()) {
    throw new Error(`${label} executable is missing`);
  }
  return canonical;
}

export function buildContainedEvalProviderCommand(input: {
  agent: EvalAgent;
  binary: string;
  cwd: string;
  task: string;
  effort: Effort;
  timeoutMs: number;
  stateRoot: string;
  authFile: string;
  skillRoot: string;
  allowProviderNetwork?: boolean;
  sessionId?: string;
}) {
  if (!isAbsolute(input.binary)) throw new Error("eval provider binary must be absolute");
  const resolvedBinary = executableFile(input.binary, input.agent);
  let executable = resolvedBinary;
  let containerExecutable: string;
  let executableMounts: readonly { source: string; target: string }[];

  if (input.agent === "codex") {
    const packageRoot = resolve(dirname(resolvedBinary), "..");
    const nativeRelative = codexNativeRelativePath();
    executable = executableFile(join(packageRoot, nativeRelative), "Codex native");
    const containerPackageRoot = "/opt/agent-collab/codex";
    containerExecutable = join(containerPackageRoot, nativeRelative);
    executableMounts = [{ source: packageRoot, target: containerPackageRoot }];
  } else {
    containerExecutable = "/opt/agent-collab/bin/grok";
    executableMounts = [{ source: executable, target: containerExecutable }];
  }

  const prompt = buildEvalProtocolPrompt(input.task, input.effort);
  const innerCommand = buildEvalProviderCommand({
    agent: input.agent,
    binary: executable,
    cwd: input.cwd,
    prompt,
    effort: input.effort,
    timeoutMs: input.timeoutMs,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  const containedCommand = buildEvalContainment({
    agent: input.agent,
    command: innerCommand,
    attemptRoot: input.cwd,
    stateRoot: input.stateRoot,
    authFile: input.authFile,
    skillRoot: input.skillRoot,
    ...(input.allowProviderNetwork ? { allowProviderNetwork: true } : {}),
    executableMounts,
    containerExecutable,
  });
  if (input.agent === "codex") {
    writeFileSync(join(input.stateRoot, "codex", "eval-response-schema.json"),
      `${responseSchema(input.effort)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { ...containedCommand, innerCommand, containerExecutable };
}

export function classifyEvalProviderFailure(input: {
  phase: "prelaunch" | "execution";
  error: unknown;
  stderr?: string;
  timedOut?: boolean;
}) {
  if (input.phase === "execution") {
    return {
      kind: "execution_outcome",
      reason: input.timedOut ? "task_timeout" : "task_failure",
      countsTowardReliability: true,
    } as const;
  }
  const message = `${input.error instanceof Error ? input.error.message : String(input.error)} ${input.stderr ?? ""}`
    .toLowerCase();
  const reason = /quota|usage limit/.test(message)
    ? "quota"
    : /auth|login|not logged|credential/.test(message)
      ? "auth"
      : /rate.?limit|429/.test(message)
        ? "rate_limit"
        : /enoent|not found/.test(message)
          ? "cli_missing"
          : "provider_unavailable";
  return { kind: "provider_unavailable", reason, countsTowardReliability: false } as const;
}

function budgetFailure(
  limits: { maxDiffBytes: number; maxFiles: number; maxProcesses: number },
  observed: { diffBytes: number; fileCount: number; peakProcessCount: number },
) {
  const reason = observed.diffBytes > limits.maxDiffBytes
    ? "diff_budget_exceeded"
    : observed.fileCount > limits.maxFiles
      ? "file_budget_exceeded"
      : observed.peakProcessCount > limits.maxProcesses
        ? "process_budget_exceeded"
        : null;
  return reason === null ? null : {
    kind: "execution_outcome",
    reason,
    countsTowardReliability: true,
  } as const;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validBudgetObservation(input: {
  diffBytes: number;
  fileCount: number;
  peakProcessCount: number;
}): boolean {
  return [input.diffBytes, input.fileCount, input.peakProcessCount]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class NodeEvalProcessLauncher implements EvalProcessLauncher {
  launch(command: CommandSpec, limits?: { maxOutputBytes: number; env?: NodeJS.ProcessEnv }): EvalLaunchedProcess {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      detached: process.platform !== "win32",
      env: limits?.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(command.stdin);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let outputLimitExceeded = false;
    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      bytes += chunk.length;
      if (limits && bytes > limits.maxOutputBytes) {
        outputLimitExceeded = true;
        try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const result = new Promise<EvalProcessResult>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout,
        stderr,
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
      }));
    });
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      result,
      terminateGroup: (signal) => {
        if (!groupAlive(child.pid)) return;
        try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, signal); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
      isProcessGroupAlive: () => groupAlive(child.pid),
    };
  }
}

type EvalFailure = {
  kind: "provider_unavailable" | "execution_outcome" | "harness_failure" | "harness_confounded";
  reason: string;
  countsTowardReliability: boolean;
};

interface RunEvalProviderInput {
  agent: EvalAgent;
  command: CommandSpec;
  providerCommand?: CommandSpec;
  containerExecutable?: string;
  expectedModel: EvalModel;
  expectedEffort: Effort;
  expectedSessionId?: string;
  expectedExecutable?: string;
  launcher?: EvalProcessLauncher;
  terminationGraceMs: number;
  maxOutputBytes: number;
  budgetLimits?: { maxDiffBytes: number; maxFiles: number; maxProcesses: number };
  observeBudgets?: () => Promise<{ diffBytes: number; fileCount: number; peakProcessCount: number }>;
  observeAttemptActivity?: () => Promise<{ candidateMutation: boolean; toolActivity: boolean }>;
  summarizeTerminalEvidence?: (
    stdout: string,
    stderr: string,
  ) => Readonly<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
}

function verifyContainedLaunch(
  outer: CommandSpec,
  provider: CommandSpec,
  containerExecutable: string | undefined,
): void {
  if (!containerExecutable || !isAbsolute(containerExecutable)) {
    throw new Error("contained provider executable identity mismatch");
  }
  if (basename(outer.file) !== "bwrap" || !outer.args.includes("--clearenv") ||
      !outer.args.includes("--unshare-all")) {
    throw new Error("provider containment wrapper mismatch");
  }
  const separator = outer.args.lastIndexOf("--");
  const expectedTail = [containerExecutable, ...provider.args];
  if (separator < 0 || JSON.stringify(outer.args.slice(separator + 1)) !== JSON.stringify(expectedTail)) {
    throw new Error("contained provider command identity mismatch");
  }
  if (outer.cwd !== provider.cwd || outer.stdin !== provider.stdin ||
      outer.timeoutMs !== provider.timeoutMs || outer.shell !== false ||
      !outer.killProcessGroup) {
    throw new Error("contained provider launch contract mismatch");
  }
}

async function alive(launched: EvalLaunchedProcess): Promise<boolean> {
  try { return await launched.isProcessGroupAlive(); }
  catch { return true; }
}

async function terminateAndVerify(
  launched: EvalLaunchedProcess,
  graceMs: number,
): Promise<boolean> {
  try { await launched.terminateGroup("SIGTERM"); } catch { /* verification below is authoritative */ }
  await delay(graceMs);
  try { await launched.terminateGroup("SIGKILL"); } catch { /* verification below is authoritative */ }
  return !(await alive(launched));
}

function failed(failure: EvalFailure, processGroupTerminated: boolean) {
  return {
    status: "failed" as const,
    failure,
    cleanup: { processGroupTerminated },
    oracleAllowed: false as const,
  };
}

export async function runEvalProviderAttempt(input: RunEvalProviderInput): Promise<Record<string, unknown>> {
  try {
    if (!positiveInteger(input.command.timeoutMs) || !positiveInteger(input.terminationGraceMs) ||
        !positiveInteger(input.maxOutputBytes)) throw new Error("invalid eval execution limits");
    if ((input.budgetLimits === undefined) !== (input.observeBudgets === undefined)) {
      throw new Error("budget limits and observer must be configured together");
    }
    if (input.budgetLimits && (!nonNegativeInteger(input.budgetLimits.maxDiffBytes) ||
        !nonNegativeInteger(input.budgetLimits.maxFiles) ||
        !positiveInteger(input.budgetLimits.maxProcesses))) {
      throw new Error("invalid eval artifact budget");
    }
    const providerCommand = input.providerCommand ?? input.command;
    if (input.providerCommand) {
      verifyContainedLaunch(input.command, providerCommand, input.containerExecutable);
    } else if (input.containerExecutable) {
      throw new Error("contained executable provided without a provider command");
    }
    verifyEvalProviderCommand({
      agent: input.agent,
      command: providerCommand,
      expectedModel: input.expectedModel,
      expectedEffort: input.expectedEffort,
      ...(input.expectedSessionId ? { expectedSessionId: input.expectedSessionId } : {}),
      ...(input.expectedExecutable ? { expectedExecutable: input.expectedExecutable } : {}),
    });
  } catch (error) {
    return failed({
      kind: "harness_confounded",
      reason: error instanceof Error ? error.message : String(error),
      countsTowardReliability: false,
    }, true);
  }

  let launched: EvalLaunchedProcess;
  try {
    launched = (input.launcher ?? new NodeEvalProcessLauncher()).launch(input.command, {
      maxOutputBytes: input.maxOutputBytes,
      ...(input.env ? { env: input.env } : {}),
    });
  } catch (error) {
    return failed(classifyEvalProviderFailure({ phase: "prelaunch", error }), true);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopBudgetMonitor = false;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), input.command.timeoutMs);
  });
  const budgetMonitor = input.budgetLimits && input.observeBudgets
    ? (async () => {
      while (!stopBudgetMonitor) {
        await delay(250);
        if (stopBudgetMonitor) break;
        try {
          const observed = await input.observeBudgets!();
          if (!validBudgetObservation(observed)) {
            return { kind: "budget_observation_failure" as const, reason: "invalid_budget_observation" };
          }
          const violation = budgetFailure(input.budgetLimits!, observed);
          if (violation) return { kind: "budget_violation" as const, failure: violation };
        } catch {
          return { kind: "budget_observation_failure" as const, reason: "budget_observation_failed" };
        }
      }
      return new Promise<never>(() => undefined);
    })()
    : new Promise<never>(() => undefined);
  try {
    const terminal = await Promise.race([
      launched.result.then((result) => ({ kind: "result" as const, result })),
      timeout.then(() => ({ kind: "timeout" as const })),
      budgetMonitor,
    ]);
    stopBudgetMonitor = true;
    if (terminal.kind === "timeout") {
      const cleaned = await terminateAndVerify(launched, input.terminationGraceMs);
      return cleaned
        ? failed({ kind: "execution_outcome", reason: "task_timeout", countsTowardReliability: true }, true)
        : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
            countsTowardReliability: false }, false);
    }
    if (terminal.kind === "budget_violation" || terminal.kind === "budget_observation_failure") {
      const cleaned = await terminateAndVerify(launched, input.terminationGraceMs);
      const failure = terminal.kind === "budget_violation"
        ? terminal.failure
        : { kind: "harness_failure" as const, reason: terminal.reason, countsTowardReliability: false };
      return cleaned
        ? failed(failure, true)
        : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
            countsTowardReliability: false }, false);
    }

    const cleanup = async (): Promise<boolean> => {
      if (!(await alive(launched))) return true;
      return terminateAndVerify(launched, input.terminationGraceMs);
    };
    const outputBytes = Buffer.byteLength(terminal.result.stdout, "utf8") +
      Buffer.byteLength(terminal.result.stderr, "utf8");
    if (terminal.result.outputLimitExceeded || outputBytes > input.maxOutputBytes) {
      const cleaned = await cleanup();
      return cleaned
        ? failed({ kind: "execution_outcome", reason: "output_budget_exceeded",
            countsTowardReliability: true }, true)
        : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
            countsTowardReliability: false }, false);
    }
    if (terminal.result.exitCode !== 0) {
      const cleaned = await cleanup();
      if (!cleaned) return failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
        countsTowardReliability: false }, false);
      const outage = classifyEvalProviderFailure({
        phase: "prelaunch",
        error: new Error(`provider exited ${terminal.result.exitCode}`),
        stderr: terminal.result.stderr,
      });
      if (["auth", "quota", "rate_limit"].includes(outage.reason) && input.observeAttemptActivity) {
        let activity: Awaited<ReturnType<NonNullable<RunEvalProviderInput["observeAttemptActivity"]>>>;
        try { activity = await input.observeAttemptActivity(); }
        catch {
          return failed({ kind: "harness_confounded", reason: "activity_observation_failed",
            countsTowardReliability: false }, true);
        }
        if (typeof activity.candidateMutation !== "boolean" ||
            typeof activity.toolActivity !== "boolean") {
          return failed({ kind: "harness_confounded", reason: "invalid_activity_observation",
            countsTowardReliability: false }, true);
        }
        if (!activity.candidateMutation && !activity.toolActivity) return failed(outage, true);
      }
      return failed(classifyEvalProviderFailure({ phase: "execution",
        error: new Error(`provider exited ${terminal.result.exitCode}`), stderr: terminal.result.stderr }), true);
    }

    let normalized: NormalizedCodexEvalResult | NormalizedGrokEvalResult;
    try {
      normalized = input.agent === "codex"
        ? normalizeCodexResult(terminal.result.stdout, {
            includeUsage: true,
            expectedEffort: input.expectedEffort,
            expectedProtocolVersion: PROTOCOL,
            pinnedModel: "gpt-5.6-sol",
          })
        : normalizeGrokResult(terminal.result.stdout, {
            expectedEffort: input.expectedEffort,
            expectedProtocolVersion: PROTOCOL,
            includeUsage: true,
            allowPlainVisibleText: true,
          });
    } catch (error) {
      const cleaned = await cleanup();
      if (!cleaned) return failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
        countsTowardReliability: false }, false);
      return failed({
        kind: "execution_outcome",
        reason: `invalid_result_protocol: ${error instanceof Error ? error.message : String(error)}`,
        countsTowardReliability: true,
      }, true);
    }
    if (normalized.model !== input.expectedModel) {
      const cleaned = await cleanup();
      return cleaned
        ? failed({ kind: "harness_confounded", reason: "model_identity_mismatch",
            countsTowardReliability: false }, true)
        : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
            countsTowardReliability: false }, false);
    }
    let terminalEvidence: Readonly<Record<string, unknown>> | undefined;
    if (input.summarizeTerminalEvidence) {
      try {
        terminalEvidence = input.summarizeTerminalEvidence(
          terminal.result.stdout,
          terminal.result.stderr,
        );
        JSON.stringify(terminalEvidence);
      } catch {
        const cleaned = await cleanup();
        return cleaned
          ? failed({ kind: "harness_confounded", reason: "terminal_evidence_invalid",
              countsTowardReliability: false }, true)
          : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
              countsTowardReliability: false }, false);
      }
    }
    if (input.budgetLimits && input.observeBudgets) {
      let observed: Awaited<ReturnType<NonNullable<RunEvalProviderInput["observeBudgets"]>>>;
      try { observed = await input.observeBudgets(); }
      catch {
        const cleaned = await cleanup();
        return cleaned
          ? failed({ kind: "harness_failure", reason: "budget_observation_failed",
              countsTowardReliability: false }, true)
          : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
              countsTowardReliability: false }, false);
      }
      if (!validBudgetObservation(observed)) {
        const cleaned = await cleanup();
        return cleaned
          ? failed({ kind: "harness_failure", reason: "invalid_budget_observation",
              countsTowardReliability: false }, true)
          : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
              countsTowardReliability: false }, false);
      }
      const violation = budgetFailure(input.budgetLimits, observed);
      if (violation) {
        const cleaned = await cleanup();
        return cleaned
          ? failed(violation, true)
          : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
              countsTowardReliability: false }, false);
      }
    }
    const cleaned = await cleanup();
    if (!cleaned) return failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
      countsTowardReliability: false }, false);
    return {
      status: "completed",
      result: normalized,
      ...(terminalEvidence ? { terminalEvidence } : {}),
      cleanup: { processGroupTerminated: true },
      oracleAllowed: true,
    };
  } catch (error) {
    const cleaned = await terminateAndVerify(launched, input.terminationGraceMs);
    if (launched.pid === undefined) {
      return cleaned
        ? failed(classifyEvalProviderFailure({ phase: "prelaunch", error }), true)
        : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
            countsTowardReliability: false }, false);
    }
    return cleaned
      ? failed(classifyEvalProviderFailure({ phase: "execution", error }), true)
      : failed({ kind: "harness_failure", reason: "process_group_cleanup_failed",
          countsTowardReliability: false }, false);
  } finally {
    stopBudgetMonitor = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
