import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { devNull } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

export interface SourceReceipt {
  sourceCommit: string;
  treeHash: string;
  status: string;
  trackedDiffHash: string;
  submoduleHash: string;
  fixtureManifestHash: string;
  dirty: boolean;
}

export interface SourceVerification {
  unchanged: boolean;
  mismatches: string[];
}

interface SnapshotArm {
  path: string;
  imageHash: string;
}

export type SealedPair =
  | {
    disposition: "ready";
    launchAllowed: true;
    imageHash: string;
    grok: SnapshotArm;
    codex: SnapshotArm;
    sourceReceiptBefore: SourceReceipt;
    sourceReceiptAfter: SourceReceipt;
  }
  | {
    disposition: "inconclusive";
    launchAllowed: false;
    reason:
      | "symlink"
      | "submodule"
      | "lfs_pointer"
      | "credential_path"
      | "unsafe_path"
      | "unsupported_mode"
      | "archive_tree_mismatch"
      | "snapshot_mismatch"
      | "source_mutated";
    mismatches?: string[] | undefined;
  };

interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "GIT_CONFIG_PARAMETERS" || key === "GIT_DIR" || key === "GIT_WORK_TREE" ||
        key === "GIT_INDEX_FILE" || key === "GIT_OBJECT_DIRECTORY" ||
        key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" || key === "GIT_EXTERNAL_DIFF" ||
        key === "GIT_DIFF_OPTS" || key === "GIT_PAGER" || key === "GIT_EDITOR" ||
        key === "GIT_SEQUENCE_EDITOR" || key === "GIT_ASKPASS" || key === "SSH_ASKPASS" ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_COUNT = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

export function runIsolatedGit(input: {
  cwd: string;
  args: string[];
  stdin?: string | Buffer | undefined;
  maxBuffer?: number | undefined;
}): Buffer {
  return execFileSync("git", [
    "-c",
    `core.hooksPath=${devNull}`,
    "-c",
    `core.attributesFile=${devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "tar.umask=0000",
    ...input.args,
  ], {
    cwd: input.cwd,
    env: isolatedGitEnvironment(),
    input: input.stdin,
    maxBuffer: input.maxBuffer ?? MAX_GIT_OUTPUT,
    stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function gitBytes(repo: string, args: string[]): Buffer {
  return runIsolatedGit({ cwd: repo, args });
}

function tarBytes(args: string[], archive: Buffer): Buffer {
  return execFileSync("tar", args, {
    input: archive,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function safeTreePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\0-\x1f\x7f]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function credentialLikePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  const safeEnvironmentTemplate = /^(?:\.env\.(?:example|sample|template|dist))$/.test(name);
  return name === ".env" || (name.startsWith(".env.") && !safeEnvironmentTemplate) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/.test(name) ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^(?:credentials|service-account|service_account)(?:\.[^.]+)?\.json$/.test(name);
}

export function hashSnapshotTree(root: string): string {
  const canonicalRoot = realpathSync(root);
  const files: Array<{ logical: string; mode: "100644" | "100755"; bytes: Buffer }> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(current, entry.name);
      const logical = relative(canonicalRoot, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`snapshot contains unsupported filesystem entry: ${logical}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      files.push({
        logical,
        mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
        bytes: readFileSync(path),
      });
    }
  };
  visit(canonicalRoot);
  return hashTreeFiles(files);
}

function hashTreeFiles(files: Array<{
  logical: string;
  mode: "100644" | "100755";
  bytes: Buffer;
}>): string {
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) =>
    left.logical < right.logical ? -1 : left.logical > right.logical ? 1 : 0,
  )) {
      hash.update(file.logical);
      hash.update("\0");
      hash.update(file.mode);
      hash.update("\0");
      hash.update(file.bytes);
      hash.update("\0");
  }
  return hash.digest("hex");
}

function hashGitTree(repo: string, entries: GitTreeEntry[]): string {
  return hashTreeFiles(entries.filter((entry) => entry.type === "blob").map((entry) => ({
    logical: entry.path,
    mode: entry.mode as "100644" | "100755",
    bytes: gitBytes(repo, ["cat-file", "blob", entry.object]),
  })));
}

function archiveMatchesTree(archive: Buffer, entries: GitTreeEntry[]): boolean {
  const members = tarBytes(["--list", "--file=-", "--quoting-style=literal"], archive)
    .toString("utf8").split("\n").filter(Boolean);
  if (members.some((path) => !safeTreePath(path.endsWith("/") ? path.slice(0, -1) : path))) return false;
  const archivedFiles = members.filter((path) => !path.endsWith("/")).sort();
  const expectedFiles = entries.filter((entry) => entry.type === "blob").map((entry) => entry.path).sort();
  return archivedFiles.length === expectedFiles.length &&
    archivedFiles.every((path, index) => path === expectedFiles[index]);
}

function extractArchive(archive: Buffer, destination: string): void {
  tarBytes([
    "--extract",
    "--file=-",
    "--directory",
    destination,
    "--no-same-owner",
    "--same-permissions",
    "--no-overwrite-dir",
    "--keep-directory-symlink",
  ], archive);
}

function gitText(repo: string, args: string[]): string {
  return gitBytes(repo, args).toString("utf8").trim();
}

function repositoryRoot(sourceRepo: string): string {
  const requested = realpathSync(sourceRepo);
  return realpathSync(gitText(requested, ["rev-parse", "--show-toplevel"]));
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function parseTree(repo: string, revision: string): GitTreeEntry[] {
  const output = gitBytes(repo, ["ls-tree", "-r", "-z", "--full-tree", revision]).toString("utf8");
  return output.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (!match) throw new Error("invalid git ls-tree record");
    return { mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! };
  });
}

function unsupportedTree(repo: string, entries: GitTreeEntry[]): SealedPair | undefined {
  if (entries.some((entry) => !safeTreePath(entry.path))) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "unsafe_path" };
  }
  if (entries.some((entry) => entry.mode === "120000")) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "symlink" };
  }
  if (entries.some((entry) => entry.mode === "160000" || entry.type === "commit")) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "submodule" };
  }
  if (entries.some((entry) => entry.type === "blob" &&
      entry.mode !== "100644" && entry.mode !== "100755")) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "unsupported_mode" };
  }
  if (entries.some((entry) => credentialLikePath(entry.path))) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "credential_path" };
  }
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const size = Number(gitText(repo, ["cat-file", "-s", entry.object]));
    if (!Number.isSafeInteger(size) || size < 0 || size > 1024) continue;
    const content = gitBytes(repo, ["cat-file", "blob", entry.object]).toString("utf8");
    if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(content) &&
        /\noid sha256:[a-f0-9]{64}\r?\n/.test(content) && /\nsize \d+\r?\n?$/.test(content)) {
      return { disposition: "inconclusive", launchAllowed: false, reason: "lfs_pointer" };
    }
  }
  return undefined;
}

export function captureSourceReceipt(sourceRepo: string): SourceReceipt {
  const repo = repositoryRoot(sourceRepo);
  const sourceCommit = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const treeHash = gitText(repo, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const status = gitBytes(repo, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]).toString("utf8");
  const trackedDiff = gitBytes(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
  const submodules = gitBytes(repo, ["submodule", "status", "--recursive"]);
  const fixtureManifest = gitBytes(repo, ["ls-files", "-s", "-z"]);
  return {
    sourceCommit,
    treeHash,
    status,
    trackedDiffHash: sha256(trackedDiff),
    submoduleHash: sha256(submodules),
    fixtureManifestHash: sha256(fixtureManifest),
    dirty: status.length > 0,
  };
}

export function verifySourceReceipt(sourceRepo: string, expected: SourceReceipt): SourceVerification {
  const actual = captureSourceReceipt(sourceRepo);
  const fields: Array<keyof SourceReceipt> = [
    "sourceCommit",
    "treeHash",
    "status",
    "trackedDiffHash",
    "submoduleHash",
    "fixtureManifestHash",
    "dirty",
  ];
  const mismatches = fields.filter((field) => actual[field] !== expected[field]);
  return { unchanged: mismatches.length === 0, mismatches };
}

export function createSealedPair(input: {
  sourceRepo: string;
  revision: string;
  destinationRoot: string;
}): SealedPair {
  const sourceRepo = repositoryRoot(input.sourceRepo);
  const destinationRoot = realpathSync(input.destinationRoot);
  if (inside(sourceRepo, destinationRoot)) {
    throw new Error("snapshot destination must be outside the source repository");
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(input.revision)) {
    throw new Error("snapshot revision must be a full Git object id");
  }
  const revision = gitText(sourceRepo, ["rev-parse", "--verify", `${input.revision}^{commit}`]);
  const entries = parseTree(sourceRepo, revision);
  const unsupported = unsupportedTree(sourceRepo, entries);
  if (unsupported) return unsupported;

  const sourceReceiptBefore = captureSourceReceipt(sourceRepo);
  const expectedImageHash = hashGitTree(sourceRepo, entries);
  const archive = gitBytes(sourceRepo, ["archive", "--format=tar", revision]);
  if (!archiveMatchesTree(archive, entries)) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "archive_tree_mismatch" };
  }
  const grokPath = join(destinationRoot, `arm-${randomUUID()}`);
  const codexPath = join(destinationRoot, `arm-${randomUUID()}`);
  mkdirSync(grokPath);
  mkdirSync(codexPath);
  try {
    for (const path of [grokPath, codexPath]) extractArchive(archive, path);
    const grokImageHash = hashSnapshotTree(grokPath);
    const codexImageHash = hashSnapshotTree(codexPath);
    if (grokImageHash !== codexImageHash) {
      rmSync(grokPath, { recursive: true, force: true });
      rmSync(codexPath, { recursive: true, force: true });
      return { disposition: "inconclusive", launchAllowed: false, reason: "snapshot_mismatch" };
    }
    if (grokImageHash !== expectedImageHash) {
      rmSync(grokPath, { recursive: true, force: true });
      rmSync(codexPath, { recursive: true, force: true });
      return { disposition: "inconclusive", launchAllowed: false, reason: "archive_tree_mismatch" };
    }
    const sourceReceiptAfter = captureSourceReceipt(sourceRepo);
    const verification = verifySourceReceipt(sourceRepo, sourceReceiptBefore);
    if (!verification.unchanged) {
      rmSync(grokPath, { recursive: true, force: true });
      rmSync(codexPath, { recursive: true, force: true });
      return {
        disposition: "inconclusive",
        launchAllowed: false,
        reason: "source_mutated",
        mismatches: verification.mismatches,
      };
    }
    return {
      disposition: "ready",
      launchAllowed: true,
      imageHash: grokImageHash,
      grok: { path: grokPath, imageHash: grokImageHash },
      codex: { path: codexPath, imageHash: codexImageHash },
      sourceReceiptBefore,
      sourceReceiptAfter,
    };
  } catch (error) {
    rmSync(grokPath, { recursive: true, force: true });
    rmSync(codexPath, { recursive: true, force: true });
    throw error;
  }
}
