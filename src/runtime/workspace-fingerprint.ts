import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export interface WorkspaceFingerprint {
  headSha: string;
  diffHash: string;
  changedFiles: string[];
  fingerprint: string;
}

const git = (project: string, args: string[]): string => {
  try {
    return execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return "";
  }
};

export function captureWorkspaceFingerprint(project: string): WorkspaceFingerprint {
  const headSha = git(project, ["rev-parse", "HEAD"]) || "non-git";
  if (headSha === "non-git") {
    const digest = createHash("sha256"); const changedFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && [".git", "node_modules", "dist", ".venv"].includes(entry.name)) continue;
        const path = join(directory, entry.name); const name = relative(project, path);
        if (entry.isDirectory()) { visit(path); continue; }
        changedFiles.push(name); digest.update(name).update("\0");
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { digest.update(`link:${readlinkSync(path)}`).update("\0"); continue; }
        if (!stat.isFile()) { digest.update(`special:${stat.mode}`).update("\0"); continue; }
        const fd = openSync(path, "r"); const buffer = Buffer.allocUnsafe(64 * 1024);
        try { let bytes: number; while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes)); }
        finally { closeSync(fd); }
        digest.update("\0");
      }
    };
    visit(project);
    const diffHash = digest.digest("hex");
    return { headSha, diffHash, changedFiles, fingerprint: createHash("sha256").update(JSON.stringify({ headSha, diffHash, changedFiles })).digest("hex") };
  }
  const trackedDiff = git(project, ["diff", "--binary", "HEAD"]);
  const changed = git(project, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const untracked = git(project, ["ls-files", "--others", "--exclude-standard"])
    .split("\n").filter(Boolean).sort();
  const untrackedHashes = untracked.map((path) => `${path}\0${git(project, ["hash-object", "--no-filters", "--", path])}`);
  const changedFiles = changed.split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
  const diffHash = createHash("sha256")
    .update(trackedDiff).update("\0").update(untrackedHashes.join("\0"))
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ headSha, diffHash, changedFiles }))
    .digest("hex");
  return { headSha, diffHash, changedFiles, fingerprint };
}
