import { spawnSync } from "node:child_process";

export type VersionProbe = (
  file: string,
  args: readonly string[],
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export function discoverProviderVersion(
  binaryPath: string,
  probe: VersionProbe = (file, args) => spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
  }),
): string {
  const result = probe(binaryPath, ["--version"]);
  if (result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || `version probe failed: ${binaryPath}`);
  }
  const version = result.stdout.trim();
  if (!version) throw new Error(`version probe returned empty output: ${binaryPath}`);
  return version;
}
