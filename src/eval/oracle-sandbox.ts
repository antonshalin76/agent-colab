import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  OracleExecutionRequest,
  OracleExecutionResult,
} from "./oracle-registry.js";

const CONTAINER_ROOTS = Object.freeze({
  workspace: "/workspace",
  oracle: "/oracle",
  scratch: "/scratch",
  python: "/oracle-python",
});
const RUNTIME_ROOTS = ["/usr", "/bin", "/lib", "/lib64"] as const;
const ALLOWED_ENVIRONMENT = new Set(["PYTHONPATH"]);

export const ORACLE_SANDBOX_POLICY_IDENTITY = Object.freeze({
  protocolVersion: "agent-collab/oracle-sandbox/v1",
  namespaces: "unshare-all",
  network: "isolated",
  environment: "clearenv-allowlisted",
  workspace: "per-command-read-only-or-read-write",
  oracle: "conditional-read-only",
  scratch: "isolated-read-write",
  processCleanup: "detached-group-term-kill-verify",
  resourceLimits: "wall-output-core-file-fd-address-space-32TiB-cpu",
  pythonRuntime: "optional-read-only-fingerprinted-venv",
});

export interface OracleSandboxCommand {
  readonly file: "/usr/bin/bwrap";
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface OracleSandboxConfig {
  readonly workspaceRoot: string;
  readonly oracleRoot: string;
  readonly scratchRoot: string;
  readonly maxOutputBytes: number;
  readonly terminationGraceMs: number;
  readonly maxTimeoutMs?: number;
  readonly maxAddressSpaceBytes?: number;
  readonly maxFileBytes?: number;
  readonly tmpfsBytes?: number;
  readonly pythonRuntimeRoot?: string;
}

interface OracleSandboxBuildInput {
  readonly workspaceRoot: string;
  readonly oracleRoot: string;
  readonly scratchRoot: string;
  readonly request: OracleExecutionRequest;
  readonly maxOutputBytes: number;
  readonly maxAddressSpaceBytes: number;
  readonly maxFileBytes: number;
  readonly tmpfsBytes?: number;
  readonly pythonRuntimeRoot?: string;
}

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
};

const canonicalDirectory = (path: string, label: string, create = false): string => {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} must be a directory`);
  return realpathSync.native(path);
};

const contained = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const assertDisjointRoots = (roots: readonly string[]): void => {
  for (let index = 0; index < roots.length; index += 1) {
    for (let peer = index + 1; peer < roots.length; peer += 1) {
      if (contained(roots[index]!, roots[peer]!) || contained(roots[peer]!, roots[index]!)) {
        throw new Error("workspace, oracle, and scratch roots must not overlap");
      }
    }
  }
};

type Roots = Readonly<{ workspace: string; oracle: string; scratch: string }>;

const mapPath = (path: string, roots: Roots): string | null => {
  if (path === CONTAINER_ROOTS.scratch || path.startsWith(`${CONTAINER_ROOTS.scratch}/`)) return path;
  const absolute = resolve(path);
  for (const [name, root] of Object.entries(roots) as [keyof Roots, string][]) {
    if (contained(root, absolute)) {
      const suffix = relative(root, absolute);
      return suffix ? `${CONTAINER_ROOTS[name]}/${suffix.split(sep).join("/")}` : CONTAINER_ROOTS[name];
    }
  }
  if (RUNTIME_ROOTS.some((root) => contained(root, absolute))) return absolute;
  return null;
};

const mapArgument = (argument: string, roots: Roots): string => {
  if (!isAbsolute(argument)) return argument;
  const mapped = mapPath(argument, roots);
  if (mapped === null) throw new Error(`oracle argument path is outside allowed roots: ${argument}`);
  return mapped;
};

const mapEnvironment = (
  environment: Readonly<Record<string, string>> | undefined,
  roots: Roots,
): Readonly<Record<string, string>> => {
  const mapped: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (!ALLOWED_ENVIRONMENT.has(name)) throw new Error(`oracle environment variable is not allowed: ${name}`);
    const components = value.split(":");
    mapped[name] = components.map((component) => {
      if (component === "" || component === "." || component.split("/").includes("..")) {
        throw new Error(`oracle environment path is not allowed: ${value}`);
      }
      return isAbsolute(component) ? mapArgument(component, roots) : component;
    }).join(":");
  }
  return mapped;
};

const requestUsesOracle = (request: OracleExecutionRequest, oracleRoot: string): boolean => {
  if (contained(oracleRoot, resolve(request.cwd)) || contained(oracleRoot, resolve(request.file))) return true;
  return request.args.some((argument) => isAbsolute(argument) && contained(oracleRoot, resolve(argument)));
};

export function buildOracleSandboxCommand(input: OracleSandboxBuildInput): OracleSandboxCommand {
  positiveInteger(input.request.timeoutMs, "oracle timeout");
  positiveInteger(input.maxOutputBytes, "oracle output limit");
  positiveInteger(input.maxAddressSpaceBytes, "oracle address-space limit");
  positiveInteger(input.maxFileBytes, "oracle file limit");
  positiveInteger(input.tmpfsBytes ?? 512 * 1024 * 1024, "oracle tmpfs limit");
  if (input.request.workspaceAccess !== "read_only" && input.request.workspaceAccess !== "read_write") {
    throw new Error("oracle workspace access must be explicit");
  }

  const roots: Roots = {
    workspace: canonicalDirectory(input.workspaceRoot, "candidate workspace"),
    oracle: canonicalDirectory(input.oracleRoot, "private oracle root"),
    scratch: canonicalDirectory(input.scratchRoot, "oracle scratch root", true),
  };
  assertDisjointRoots(Object.values(roots));
  const cwd = mapPath(input.request.cwd, roots);
  if (cwd === null || RUNTIME_ROOTS.some((root) => contained(root, cwd))) {
    throw new Error("oracle cwd is outside workspace, oracle, and scratch roots");
  }
  const executable = mapPath(input.request.file, roots);
  if (executable === null || (!RUNTIME_ROOTS.some((root) => contained(root, executable)) &&
      !contained(CONTAINER_ROOTS.scratch, executable))) {
    throw new Error("oracle executable is outside runtime and scratch roots");
  }
  const mappedEnvironment = mapEnvironment(input.request.env, roots);
  const pythonRuntime = input.pythonRuntimeRoot === undefined
    ? null
    : canonicalDirectory(input.pythonRuntimeRoot, "oracle Python runtime");
  const needsOracle = requestUsesOracle(input.request, roots.oracle);
  const workspaceMount = input.request.workspaceAccess === "read_write" ? "--bind" : "--ro-bind";
  const cpuSeconds = Math.max(1, Math.ceil(input.request.timeoutMs / 1000) + 5);
  const args: string[] = [
    "--unshare-all", "--unshare-user", "--disable-userns",
    "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dir", "/etc",
    "--ro-bind", "/etc/alternatives", "/etc/alternatives",
  ];
  if (existsSync("/etc/ld.so.cache")) {
    args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  }
  args.push(
    "--proc", "/proc", "--dev", "/dev",
    "--size", String(input.tmpfsBytes ?? 512 * 1024 * 1024), "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    workspaceMount, roots.workspace, CONTAINER_ROOTS.workspace,
  );
  if (needsOracle) args.push("--ro-bind", roots.oracle, CONTAINER_ROOTS.oracle);
  if (pythonRuntime !== null) {
    args.push("--ro-bind", pythonRuntime, CONTAINER_ROOTS.python);
  }
  args.push(
    "--bind", roots.scratch, CONTAINER_ROOTS.scratch,
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/home/eval",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "TZ", "UTC",
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--setenv", "PYTEST_ADDOPTS", "-p no:cacheprovider",
  );
  if (pythonRuntime !== null) {
    args.push(
      "--setenv", "VIRTUAL_ENV", CONTAINER_ROOTS.python,
      "--setenv", "PATH", `${CONTAINER_ROOTS.python}/bin:/usr/bin:/bin`,
    );
  }
  for (const [name, value] of Object.entries(mappedEnvironment)) args.push("--setenv", name, value);
  args.push(
    "--chdir", cwd, "--",
    "/usr/bin/prlimit",
    "--core=0", `--fsize=${input.maxFileBytes}`, "--nofile=256",
    `--as=${input.maxAddressSpaceBytes}`, `--cpu=${cpuSeconds}`,
    "--",
    pythonRuntime !== null && input.request.file === "/usr/bin/python3"
      ? `${CONTAINER_ROOTS.python}/bin/python`
      : executable,
    ...input.request.args.map((argument) => mapArgument(argument, roots)),
  );
  return Object.freeze({ file: "/usr/bin/bwrap", args: Object.freeze(args), cwd: roots.scratch });
}

const processGroupAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const signalProcessGroup = (pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

async function executeOracleSandbox(
  command: OracleSandboxCommand,
  timeoutMs: number,
  maxOutputBytes: number,
  terminationGraceMs: number,
): Promise<OracleExecutionResult> {
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    detached: true,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let retainedBytes = 0;
  let outputLimitExceeded = false;
  let stop: (() => void) | undefined;
  const stopped = new Promise<"output_limit">((resolveStop) => { stop = () => resolveStop("output_limit"); });
  const capture = (target: Buffer[], chunk: Buffer): void => {
    const remaining = Math.max(0, maxOutputBytes - retainedBytes);
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      target.push(retained);
      retainedBytes += retained.length;
    }
    if (chunk.length > remaining && !outputLimitExceeded) {
      outputLimitExceeded = true;
      stop!();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
  const closed = new Promise<{ exitCode: number; error?: Error }>((resolveClosed) => {
    let settled = false;
    const settle = (value: { exitCode: number; error?: Error }): void => {
      if (!settled) {
        settled = true;
        resolveClosed(value);
      }
    };
    child.once("error", (error) => settle({ exitCode: 1, error }));
    child.once("close", (code, signal) => settle({ exitCode: code ?? (signal ? 128 : 1) }));
  });
  const terminal = await Promise.race([
    closed.then((result) => ({ kind: "closed" as const, result })),
    delay(timeoutMs).then(() => ({ kind: "timeout" as const })),
    stopped.then(() => ({ kind: "output_limit" as const })),
  ]);
  const interrupted = terminal.kind !== "closed";
  if (interrupted || processGroupAlive(child.pid)) {
    signalProcessGroup(child.pid, "SIGTERM");
    await delay(terminationGraceMs);
    if (processGroupAlive(child.pid)) signalProcessGroup(child.pid, "SIGKILL");
    await delay(terminationGraceMs);
  }
  const final = terminal.kind === "closed"
    ? terminal.result
    : await Promise.race([
      closed,
      delay(terminationGraceMs).then(() => ({ exitCode: 137 })),
    ]);
  const cleanupVerified = !processGroupAlive(child.pid);
  if (!cleanupVerified) signalProcessGroup(child.pid, "SIGKILL");
  const caughtError = "error" in final && final.error instanceof Error ? final.error : undefined;
  if (caughtError) stderr.push(Buffer.from(caughtError.message));
  return Object.freeze({
    exitCode: interrupted && final.exitCode === 0 ? 1 : final.exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    ...(terminal.kind === "timeout" ? { timedOut: true } : {}),
    ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
    cleanupVerified,
  });
}

export function createOracleSandboxExecutor(
  config: OracleSandboxConfig,
): (request: OracleExecutionRequest) => Promise<OracleExecutionResult> {
  positiveInteger(config.maxOutputBytes, "oracle output limit");
  positiveInteger(config.terminationGraceMs, "oracle termination grace");
  const maxTimeoutMs = config.maxTimeoutMs ?? 10 * 60_000;
  const maxAddressSpaceBytes = config.maxAddressSpaceBytes ?? 32 * 1024 * 1024 * 1024 * 1024;
  const maxFileBytes = config.maxFileBytes ?? 1024 * 1024 * 1024;
  positiveInteger(maxTimeoutMs, "maximum oracle timeout");
  return async (request) => {
    if (request.timeoutMs > maxTimeoutMs) throw new Error("oracle timeout exceeds the configured limit");
    const command = buildOracleSandboxCommand({
      workspaceRoot: config.workspaceRoot,
      oracleRoot: config.oracleRoot,
      scratchRoot: config.scratchRoot,
      request,
      maxOutputBytes: config.maxOutputBytes,
      maxAddressSpaceBytes,
      maxFileBytes,
      ...(config.tmpfsBytes === undefined ? {} : { tmpfsBytes: config.tmpfsBytes }),
      ...(config.pythonRuntimeRoot === undefined
        ? {}
        : { pythonRuntimeRoot: config.pythonRuntimeRoot }),
    });
    return executeOracleSandbox(command, request.timeoutMs, config.maxOutputBytes, config.terminationGraceMs);
  };
}
