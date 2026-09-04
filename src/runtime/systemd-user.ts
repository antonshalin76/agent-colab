import { spawnSync } from "node:child_process";

export interface SystemdUserCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function systemdUserEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.(),
): NodeJS.ProcessEnv {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("systemd user manager requires a numeric OS uid");
  }
  const runtimeDirectory = `/run/user/${String(uid)}`;
  return {
    ...environment,
    XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR ?? runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS ??
      `unix:path=${runtimeDirectory}/bus`,
  };
}

export function runUserSystemctl(
  args: readonly string[],
  timeoutMs = 10_000,
): SystemdUserCommandResult {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    env: systemdUserEnvironment(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
