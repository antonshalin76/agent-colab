import { appendFileSync, existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

interface BootstrapConfig {
  path: string;
  exactBefore: string;
  exactAfter: string;
}

interface BootstrapInput {
  configs: BootstrapConfig[];
  legacyPids: number[];
  databaseFiles: string[];
  actionLog: string;
  mutationMarker: string;
  systemdUnit?: string;
}

interface BootstrapAction {
  action: string;
  configBytes?: Record<string, string>;
  pid?: number;
  openFiles?: string[];
}

function appendAction(path: string, action: BootstrapAction): void {
  appendFileSync(path, `${JSON.stringify(action)}\n`);
}

function switchManagedConfigs(configs: BootstrapConfig[]): Record<string, string> {
  const bytes: Record<string, string> = {};
  for (const config of configs) {
    const current = readFileSync(config.path, "utf8");
    let next = current;
    if (current.includes(config.exactBefore)) {
      next = current.replace(config.exactBefore, config.exactAfter);
      writeFileSync(config.path, next);
    } else if (!current.includes(config.exactAfter)) {
      throw new Error(`managed config does not contain expected bytes: ${config.path}`);
    }
    bytes[config.path] = next;
  }
  return bytes;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false;
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!isRunning(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) {
      process.kill(pid, "SIGKILL");
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function assertSystemdInactive(unit?: string): Promise<void> {
  if (!unit) return;
  const result = await execa("systemctl", ["is-active", unit], { reject: false });
  if (result.exitCode === 0 || result.stdout.trim() === "active") {
    throw new Error(`systemd unit is still active: ${unit}`);
  }
}

function scanOpenDatabaseFiles(databaseFiles: string[]): string[] {
  const targets = new Set(databaseFiles.map((path) => resolve(path)));
  const open = new Set<string>();
  for (const procEntry of readdirSync("/proc", { withFileTypes: true })) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const fdRoot = `/proc/${procEntry.name}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdRoot);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const linked = readlinkSync(`${fdRoot}/${fd}`).replace(/ \(deleted\)$/, "");
        const absolute = resolve(linked);
        if (targets.has(absolute)) open.add(absolute);
      } catch {
        // Processes can close descriptors while /proc is being scanned.
      }
    }
  }
  return [...open].sort();
}

export async function bootstrapOperationalHost(input: BootstrapInput): Promise<void> {
  const configBytes = switchManagedConfigs(input.configs);
  appendAction(input.actionLog, { action: "dispatcher_config_switched", configBytes });

  for (const pid of input.legacyPids) {
    await terminateProcess(pid);
    appendAction(input.actionLog, { action: "legacy_pid_terminated", pid });
  }

  await assertSystemdInactive(input.systemdUnit);
  appendAction(input.actionLog, { action: "systemd_inactive" });

  const openFiles = scanOpenDatabaseFiles(input.databaseFiles);
  if (openFiles.length > 0) {
    appendAction(input.actionLog, { action: "pid_fd_scan_blocked", openFiles });
    throw new Error(`database descriptors are still open: ${openFiles.join(", ")}`);
  }
  appendAction(input.actionLog, { action: "pid_fd_scan_clear" });
  writeFileSync(input.mutationMarker, "mutation-authorized-after-zero-fds\n");
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "bootstrap") throw new Error("expected bootstrap command");
  const inputPath = option(args, "--input");
  if (!existsSync(inputPath)) throw new Error(`bootstrap input is missing: ${inputPath}`);
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as BootstrapInput;
  await bootstrapOperationalHost(input);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
