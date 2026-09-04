import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { canonicalJson } from "../domain/canonical-json.js";

export interface ReviewedV4File {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly blobOid: string;
  readonly bytes: Buffer;
}

export interface ReviewedV4SourceIdentity {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly manifestSha256: string;
  readonly lastProgressEventSha256: string;
}

export interface ReviewedV4SourceInput {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly files: readonly ReviewedV4File[];
}

export interface ReviewedV4RemoteTrust {
  readonly url: string;
  readonly ref: string;
}

export interface ReviewedV4PromotionSourceSnapshot {
  readonly sourceIdentity: ReviewedV4SourceIdentity;
  readonly execution: {
    readonly mode: "tsx-source";
    readonly entrypoint: "scripts/agent-collab-launcher.mjs";
    readonly entrypointBlobOid: string;
    readonly entrypointSha256: string;
    readonly sourceRoot: "src";
    readonly distAllowed: false;
  };
}

export interface VerifiedReviewedV4Source {
  readonly status: "verified";
  readonly commitOid: string;
  readonly treeOid: string;
  readonly manifestSha256: string;
  readonly progressEventCount: 3;
  readonly lastProgressEventSha256: string;
}

const REQUIRED_ARTIFACTS = new Set([
  "package.json",
  "package-lock.json",
  "scripts/agent-collab-launcher.mjs",
  "systemd/agent-collab.service",
  "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql",
  "docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json",
  "docs/hybrid-flow-v1-r2/PLAN_LOCK.json",
  "docs/hybrid-flow-v1-r2/STATE_V4_PROGRESS_SEED.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000001-r2-stg-00-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000003-stg-02-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000004-stg-03-pass.json",
  "docs/hybrid-flow-v1-r2/amendments/AMD-0001.json",
  "docs/hybrid-flow-v1-r2/amendments/AMD-0001-authority.json",
  "docs/hybrid-flow-v1-r2/amendments/evidence/architecture-slice.md",
  "docs/hybrid-flow-v1-r2/stage-close/STG-03-source-manifest.json",
]);

const included = (path: string): boolean =>
  (path.startsWith("src/") && path.endsWith(".ts")) || REQUIRED_ARTIFACTS.has(path);

const gitBlobOid = (bytes: Buffer): string => createHash("sha1")
  .update(Buffer.from(`blob ${bytes.length}\0`))
  .update(bytes)
  .digest("hex");

export function reviewedV4ManifestSha256(files: readonly ReviewedV4File[]): string {
  const manifest = [...files]
    .map(({ path, mode, blobOid, bytes }) => ({
      path,
      mode,
      blobOid,
      bytesSha256: createHash("sha256").update(bytes).digest("hex"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function verifyReviewedV4Source(
  input: ReviewedV4SourceInput,
  expected: ReviewedV4SourceIdentity,
): VerifiedReviewedV4Source {
  if (input.commitOid !== expected.commitOid || input.treeOid !== expected.treeOid) {
    throw new Error("reviewed v4 source identity does not match the externally accepted commit and tree");
  }
  if (!Array.isArray(input.files) || input.files.length < 100) {
    throw new Error("reviewed v4 source inventory is incomplete or contains an unexpected event");
  }
  const seen = new Set<string>();
  for (const file of input.files) {
    if (!file || seen.has(file.path) || !included(file.path) ||
        (file.mode !== "100644" && file.mode !== "100755")) {
      throw new Error("reviewed v4 source manifest path inventory is not exact");
    }
    seen.add(file.path);
    if (!Buffer.isBuffer(file.bytes) || gitBlobOid(file.bytes) !== file.blobOid) {
      throw new Error(`reviewed v4 source bytes mismatch: ${file.path}`);
    }
  }
  for (const required of REQUIRED_ARTIFACTS) {
    if (!seen.has(required)) throw new Error(`reviewed v4 source manifest is missing ${required}`);
  }
  const manifestSha256 = reviewedV4ManifestSha256(input.files);
  if (manifestSha256 !== expected.manifestSha256) {
    throw new Error("reviewed v4 source manifest identity does not match the external acceptance");
  }
  return Object.freeze({
    status: "verified",
    commitOid: expected.commitOid,
    treeOid: expected.treeOid,
    manifestSha256,
    progressEventCount: 3,
    lastProgressEventSha256: expected.lastProgressEventSha256,
  });
}

function sourceFiles(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("executing reviewed v4 source contains a symbolic link");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".ts")) {
        paths.push(relative(root, path).split("\\").join("/"));
      }
    }
  };
  visit(join(root, "src"));
  return paths;
}

function assertSafeRemote(remote: ReviewedV4RemoteTrust): void {
  if (!remote.url || remote.url.startsWith("-") || /[\0\r\n]/.test(remote.url) ||
      !/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote.ref) ||
      remote.ref.includes("..") || remote.ref.endsWith("/") || remote.ref.includes("//")) {
    throw new Error("reviewed v4 remote URL or exact ref is invalid");
  }
}

function assertRemoteAdvertises(remote: ReviewedV4RemoteTrust, commitOid: string): void {
  assertSafeRemote(remote);
  let output: string;
  try {
    output = execFileSync("git", ["ls-remote", "--exit-code", "--refs", remote.url, remote.ref], {
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error("reviewed v4 commit is not advertised by the allowlisted remote ref", { cause: error });
  }
  const rows = output.trim().split("\n").filter(Boolean);
  if (rows.length !== 1 || rows[0] !== `${commitOid}\t${remote.ref}`) {
    throw new Error("reviewed v4 commit is not the exact allowlisted remote ref target");
  }
}

function readCanonicalWorktreeFile(
  repositoryRoot: string,
  path: string,
  mode: ReviewedV4File["mode"],
): Buffer {
  const target = resolve(repositoryRoot, path);
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(target);
    const executable = (opened.mode & 0o111) !== 0;
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
        opened.nlink !== 1 || current.nlink !== 1 || realpathSync(target) !== target ||
        opened.dev !== current.dev || opened.ino !== current.ino ||
        executable !== (mode === "100755")) {
      throw new Error(`reviewed v4 source path mode or canonical identity is invalid: ${path}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function inspectReviewedV4ExecutionSource(input: {
  readonly repositoryRoot: string;
  readonly expected: ReviewedV4SourceIdentity;
  readonly remote: ReviewedV4RemoteTrust;
}): ReviewedV4SourceInput {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (realpathSync(repositoryRoot) !== repositoryRoot) {
    throw new Error("reviewed v4 repository root must be canonical");
  }
  const treeOid = execFileSync("git", ["-C", repositoryRoot, "rev-parse", `${input.expected.commitOid}^{tree}`], {
    encoding: "utf8",
  }).trim();
  if (treeOid !== input.expected.treeOid) {
    throw new Error("externally accepted reviewed v4 commit tree identity is invalid");
  }
  assertRemoteAdvertises(input.remote, input.expected.commitOid);
  const rows = execFileSync("git", ["-C", repositoryRoot, "ls-tree", "-r", input.expected.commitOid], {
    encoding: "utf8",
  }).trim().split("\n").map((row) => {
    const match = row.match(/^(100644|100755)\s+blob\s+([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("externally accepted reviewed v4 tree inventory is malformed");
    return { mode: match[1] as ReviewedV4File["mode"], blobOid: match[2]!, path: match[3]! };
  }).filter(({ path }) => included(path));
  const acceptedPaths = new Set(rows.map(({ path }) => path));
  const currentPaths = new Set([
    ...sourceFiles(repositoryRoot),
    ...[...REQUIRED_ARTIFACTS].filter((path) => {
      try { readFileSync(resolve(repositoryRoot, path)); return true; } catch { return false; }
    }),
  ]);
  if (acceptedPaths.size !== currentPaths.size ||
      [...acceptedPaths].some((path) => !currentPaths.has(path))) {
    throw new Error("executing reviewed v4 source inventory differs from the externally accepted tree");
  }
  return {
    commitOid: input.expected.commitOid,
    treeOid,
    files: rows.map(({ path, mode, blobOid }) => ({
      path,
      blobOid,
      mode,
      bytes: readCanonicalWorktreeFile(repositoryRoot, path, mode),
    })),
  };
}

export function captureReviewedV4PromotionSource(input: {
  readonly repositoryRoot: string;
  readonly remote: ReviewedV4RemoteTrust;
}): ReviewedV4PromotionSourceSnapshot {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (realpathSync(repositoryRoot) !== repositoryRoot) {
    throw new Error("reviewed v4 repository root must be canonical");
  }
  const commitOid = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD^{commit}"], {
    encoding: "utf8",
  }).trim();
  const treeOid = execFileSync("git", ["-C", repositoryRoot, "rev-parse", `${commitOid}^{tree}`], {
    encoding: "utf8",
  }).trim();
  const rows = execFileSync("git", ["-C", repositoryRoot, "ls-tree", "-r", commitOid], {
    encoding: "utf8",
  }).trim().split("\n").map((row) => {
    const match = row.match(/^(100644|100755)\s+blob\s+([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("reviewed v4 promotion source tree inventory is malformed");
    return { mode: match[1] as ReviewedV4File["mode"], blobOid: match[2]!, path: match[3]! };
  }).filter(({ path }) => included(path));
  const seedBytes = execFileSync("git", ["-C", repositoryRoot, "show",
    `${commitOid}:docs/hybrid-flow-v1-r2/STATE_V4_PROGRESS_SEED.json`]);
  const seed = JSON.parse(seedBytes.toString("utf8")) as { lastEventSha256?: unknown };
  if (typeof seed.lastEventSha256 !== "string" || !/^[a-f0-9]{64}$/.test(seed.lastEventSha256)) {
    throw new Error("reviewed v4 progress seed has no terminal event identity");
  }
  const currentFiles = rows.map(({ path, mode, blobOid }) => ({
    path,
    mode,
    blobOid,
    bytes: readCanonicalWorktreeFile(repositoryRoot, path, mode),
  }));
  const sourceIdentity = {
    commitOid,
    treeOid,
    manifestSha256: reviewedV4ManifestSha256(currentFiles),
    lastProgressEventSha256: seed.lastEventSha256,
  };
  verifyReviewedV4Source(inspectReviewedV4ExecutionSource({
    repositoryRoot,
    expected: sourceIdentity,
    remote: input.remote,
  }), sourceIdentity);
  const entrypoint = rows.find(({ path }) => path === "scripts/agent-collab-launcher.mjs");
  if (!entrypoint) throw new Error("reviewed v4 promotion source has no launcher entrypoint");
  const entrypointBytes = execFileSync("git", ["-C", repositoryRoot, "show", `${commitOid}:${entrypoint.path}`]);
  return Object.freeze({
    sourceIdentity: Object.freeze(sourceIdentity),
    execution: Object.freeze({
      mode: "tsx-source" as const,
      entrypoint: "scripts/agent-collab-launcher.mjs" as const,
      entrypointBlobOid: entrypoint.blobOid,
      entrypointSha256: createHash("sha256").update(entrypointBytes).digest("hex"),
      sourceRoot: "src" as const,
      distAllowed: false as const,
    }),
  });
}
