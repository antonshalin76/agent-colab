import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface WorkspaceFingerprint {
  headSha: string;
  branchRef: string;
  upstreamRef: string;
  upstreamSha: string;
  baseSha: string;
  diffHash: string;
  changedFiles: string[];
  fingerprint: string;
}

const gitRequired = (project: string, args: string[], label: string, raw = false): string => {
  try {
    const output = execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return raw ? output : output.trim();
  } catch (error) {
    throw new Error(`${label} failed while capturing exact workspace evidence: ${String(error)}`);
  }
};

const gitWorkspace = (project: string): boolean => {
  try {
    return execFileSync("git", ["-C", project, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    }).trim() === "true";
  } catch (error) {
    if (existsSync(join(project, ".git"))) {
      throw new Error(`git repository probe failed while capturing exact workspace evidence: ${String(error)}`);
    }
    return false;
  }
};

const updatePathEvidence = (digest: ReturnType<typeof createHash>, project: string, name: string): void => {
  const path = join(project, name);
  digest.update(`${Buffer.byteLength(name, "utf8")}:${name}:`);
  if (!existsSync(path)) {
    digest.update("missing\0");
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    digest.update(`link:${readlinkSync(path)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    try {
      const topLevel = gitRequired(path, ["rev-parse", "--show-toplevel"], "nested Git root lookup");
      if (resolve(topLevel) === resolve(path)) {
        digest.update(`nested-git:${JSON.stringify(captureWorkspaceFingerprint(path))}\0`);
        return;
      }
    } catch {
      // A normal changed path is not a nested repository; its type remains part of the evidence.
    }
  }
  if (!stat.isFile()) {
    digest.update(`special:${stat.mode}\0`);
    return;
  }
  digest.update(`file:${stat.mode & 0o777}:`);
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  digest.update("\0");
};

const porcelainPaths = (status: string): string[] => {
  const records = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("git status returned malformed porcelain evidence");
    }
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
      const original = records[++index];
      if (!original) throw new Error("git status returned an incomplete rename record");
      paths.push(original);
    }
  }
  return [...new Set(paths)].sort();
};

export function captureWorkspaceFingerprint(project: string): WorkspaceFingerprint {
  if (!gitWorkspace(project)) {
    const headSha = "non-git";
    const branchRef = "non-git";
    const upstreamRef = "non-git";
    const upstreamSha = "non-git";
    const baseSha = "non-git";
    const digest = createHash("sha256"); const changedFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && [".git", "node_modules", "dist", ".venv"].includes(entry.name)) continue;
        const path = join(directory, entry.name); const name = relative(project, path);
        if (entry.isDirectory() && name === ".map/agent-collab-admin") continue;
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
    return { headSha, branchRef, upstreamRef, upstreamSha, baseSha, diffHash, changedFiles,
      fingerprint: createHash("sha256").update(JSON.stringify({
        headSha, branchRef, upstreamRef, upstreamSha, baseSha, diffHash, changedFiles,
      })).digest("hex") };
  }
  const headSha = gitRequired(project, ["rev-parse", "--verify", "HEAD"], "git HEAD lookup");
  const branchRef = gitRequired(
    project,
    ["rev-parse", "--symbolic-full-name", "HEAD"],
    "git branch identity lookup",
  );
  const upstreamRef = branchRef.startsWith("refs/heads/")
    ? gitRequired(
        project,
        ["for-each-ref", "--count=1", "--format=%(upstream)", branchRef],
        "git upstream identity lookup",
      ) || "upstream-unconfigured"
    : "detached-head";
  const upstreamSha = upstreamRef.startsWith("refs/")
    ? gitRequired(project, ["rev-parse", "--verify", upstreamRef], "git upstream tip lookup")
    : "upstream-unconfigured";
  const baseSha = upstreamRef.startsWith("refs/")
    ? gitRequired(project, ["merge-base", "HEAD", upstreamRef], "git upstream merge-base lookup")
    : "base-unconfigured";
  const status = gitRequired(
    project,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "git status",
    true,
  );
  const indexEvidence = gitRequired(
    project,
    ["ls-files", "--stage", "-z"],
    "git index lookup",
    true,
  );
  const changedFiles = porcelainPaths(`${status}\0`);
  const digest = createHash("sha256")
    .update(status).update("\0")
    .update(indexEvidence).update("\0");
  for (const path of changedFiles) updatePathEvidence(digest, project, path);
  const diffHash = digest.digest("hex");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ headSha, branchRef, upstreamRef, upstreamSha, baseSha, diffHash, changedFiles }))
    .digest("hex");
  return { headSha, branchRef, upstreamRef, upstreamSha, baseSha, diffHash, changedFiles, fingerprint };
}
