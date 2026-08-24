import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { redactSensitive } from "../security/redaction.js";

const MANIFEST_NAME = "manifest.json";
const GATE_RECEIPT = "proof/gate-receipt.json";
const DISPATCHER = "/home/anton/.local/bin/agent-collab-dispatcher";
export const V1_SYSTEMD_UNIT = [
  "[Unit]",
  "Description=Claude Code and Codex collaboration worker",
  "After=default.target",
  "",
  "[Service]",
  "Type=simple",
  "WorkingDirectory=/home/anton/.local/share/agent-collab/current",
  `ExecStart=${DISPATCHER} worker`,
  "Restart=on-failure",
  "RestartSec=3",
  "UMask=0077",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "Environment=AGENT_COLLAB_STATE_DIR=/home/anton/.local/share/agent-collab",
  "Environment=AGENT_COLLAB_CLAUDE_BIN=/home/anton/.local/bin/claude",
  "Environment=AGENT_COLLAB_CODEX_BIN=/home/anton/.local/bin/codex",
  "Environment=PATH=/home/anton/.nvm/versions/node/v24.14.1/bin:/home/anton/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_FILES = [
  "dist/cli.js",
  "mcp/registrations.json",
  "package-lock.json",
  "package.json",
  GATE_RECEIPT,
  "runtime/node.json",
  "skills/files/agent-collaboration/SKILL.md",
  "skills/manifest.json",
  "systemd/agent-collab.service",
] as const;

const proofSchema = z.object({
  source: z.literal("append-only-rollout-reconstruction"),
  sourceDigest: z.string().regex(SHA256),
  gate: z.object({ command: z.string().min(1), exitCode: z.literal(0) }).strict(),
  runtimeTreeDigest: z.string().regex(SHA256),
  gateReceiptSha256: z.string().regex(SHA256),
}).strict();

const gateReceiptSchema = z.object({
  format: z.literal("agent-collab-v1-gate-receipt/v1"),
  source: z.literal("append-only-rollout-reconstruction"),
  sourceDigest: z.string().regex(SHA256),
  gate: z.object({ command: z.string().min(1), exitCode: z.literal(0) }).strict(),
  runtimeTreeDigest: z.string().regex(SHA256),
}).strict();

const fileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative().max(0o777),
}).strict();

const manifestSchema = z.object({
  format: z.literal("agent-collab-v1-runtime/v1"),
  proof: proofSchema,
  files: z.array(fileSchema),
}).strict();

const nodeReceiptSchema = z.object({
  format: z.literal("agent-collab-node-runtime/v1"),
  identity: z.literal("node"),
  binaryRealpath: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().regex(SHA256),
  nativeAbi: z.string().min(1),
}).strict();

export interface V1RuntimeProof {
  readonly source: string;
  readonly sourceDigest: string;
  readonly gate: { readonly command: string; readonly exitCode: number };
  readonly runtimeTreeDigest: string;
  readonly gateReceiptSha256: string;
}

export interface V1RuntimeManifest {
  readonly format: "agent-collab-v1-runtime/v1";
  readonly proof: V1RuntimeProof;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly mode: number;
  }>;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} JSON is malformed: ${String(error)}`);
  }
}

function assertNoSymlinkInPath(inputPath: string): void {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
  let current = absolute.startsWith(sep) ? sep : "";
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const kind = current === absolute ? "snapshot root" : "snapshot ancestor";
      throw new Error(`${kind} must not be a symlink: ${current}`);
    }
  }
}

function assertRegularUnlinkedFile(path: string, label = "file"): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if (stat.nlink !== 1) throw new Error(`${label} hardlink/link count is not one: ${path}`);
  return stat;
}

function safeRelativePath(path: string): string {
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || path.includes("\0")) {
    throw new Error(`manifest path must be a safe relative path: ${path}`);
  }
  const normalized = relative(".", path).split(sep).join("/");
  if (normalized !== path || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`manifest path traversal or invalid relative path: ${path}`);
  }
  return path;
}

function enumerateFiles(snapshotDirectory: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(snapshotDirectory, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`snapshot contains symlink: ${path}`);
      if (entry.isDirectory()) {
        if (path === "node_modules/.bin") throw new Error("node_modules .bin shims are excluded");
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`snapshot contains unsupported file type: ${path}`);
      assertRegularUnlinkedFile(absolute);
      if (path !== MANIFEST_NAME) files.push(path);
    }
  };
  visit(snapshotDirectory);
  return files.sort();
}

export function v1RuntimeTreeDigest(snapshotDirectoryInput: string): string {
  assertNoSymlinkInPath(snapshotDirectoryInput);
  const snapshotDirectory = realpathSync(snapshotDirectoryInput);
  const entries = enumerateFiles(snapshotDirectory)
    .filter((path) => path !== GATE_RECEIPT)
    .map((path) => {
      const absolute = join(snapshotDirectory, path);
      const stat = assertRegularUnlinkedFile(absolute);
      return { path, sha256: sha256(readFileSync(absolute)), size: stat.size, mode: stat.mode & 0o777 };
    });
  return sha256(`${JSON.stringify(entries)}\n`);
}

function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function validateDependencyClosure(snapshotDirectory: string, fileSet: ReadonlySet<string>): void {
  if ([...fileSet].some((path) => path.startsWith("node_modules/.bin/"))) {
    throw new Error("node_modules .bin shims are excluded");
  }
  const pkg = parseJson(join(snapshotDirectory, "package.json"), "package") as Record<string, unknown>;
  const lock = parseJson(join(snapshotDirectory, "package-lock.json"), "package lock") as Record<string, unknown>;
  const packages = lock.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("package lock is missing the packages dependency map");
  }
  const locked = packages as Record<string, unknown>;
  const rootLock = locked[""];
  if (!rootLock || typeof rootLock !== "object" || Array.isArray(rootLock)) {
    throw new Error("package lock is missing root package metadata");
  }
  const rootMetadata = rootLock as Record<string, unknown>;
  if (rootMetadata.name !== pkg.name || rootMetadata.version !== pkg.version ||
      JSON.stringify(rootMetadata.dependencies ?? {}) !== JSON.stringify(pkg.dependencies ?? {}) ||
      JSON.stringify(rootMetadata.peerDependencies ?? {}) !== JSON.stringify(pkg.peerDependencies ?? {}) ||
      JSON.stringify(rootMetadata.peerDependenciesMeta ?? {}) !== JSON.stringify(pkg.peerDependenciesMeta ?? {})) {
    throw new Error("root package name/version/dependencies do not match the package lock");
  }
  const packageAt = (location: string): Record<string, unknown> =>
    parseJson(join(snapshotDirectory, location, "package.json"), `dependency ${location}`) as Record<string, unknown>;
  const resolveDependency = (requester: string, name: string): string | undefined => {
    let base = requester;
    while (true) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (fileSet.has(`${candidate}/package.json`)) return candidate;
      if (!base) return undefined;
      const parent = base.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/, "");
      if (parent === base) return undefined;
      base = parent;
    }
  };
  const pending = dependencyNames(pkg.dependencies).map((name) => ({ requester: "", name, optional: false }));
  pending.push(...dependencyNames(pkg.optionalDependencies).map((name) => ({ requester: "", name, optional: true })));
  const rootPeerMetadata = pkg.peerDependenciesMeta && typeof pkg.peerDependenciesMeta === "object"
    ? pkg.peerDependenciesMeta as Record<string, { optional?: boolean }> : {};
  pending.push(...dependencyNames(pkg.peerDependencies)
    .map((name) => ({ requester: "", name, optional: rootPeerMetadata[name]?.optional === true })));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const request = pending.shift()!;
    const location = resolveDependency(request.requester, request.name);
    if (!location) {
      if (request.optional) continue;
      throw new Error(`missing required production dependency for ${request.name}`);
    }
    if (visited.has(location)) continue;
    visited.add(location);
    const lockEntry = locked[location];
    if (!lockEntry || typeof lockEntry !== "object" || Array.isArray(lockEntry)) {
      throw new Error(`missing required package lock entry for ${location}`);
    }
    const installed = packageAt(location);
    const locationName = location.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
    if (!locationName || installed.name !== locationName) {
      throw new Error(`installed dependency name does not match its node_modules location: ${location}`);
    }
    const installedVersion = installed.version;
    const lockedVersion = (lockEntry as Record<string, unknown>).version;
    if (typeof installedVersion !== "string" || installedVersion !== lockedVersion) {
      throw new Error(`installed dependency version does not match lock entry for ${location}`);
    }
    if (typeof installed.main === "string") {
      const entrypoint = `${location}/${installed.main.replace(/^\.\//, "")}`;
      if (!fileSet.has(entrypoint)) throw new Error(`missing required dependency entrypoint: ${entrypoint}`);
    }
    pending.push(...dependencyNames(installed.dependencies)
      .map((name) => ({ requester: location, name, optional: false })));
    pending.push(...dependencyNames(installed.optionalDependencies)
      .map((name) => ({ requester: location, name, optional: true })));
    const peerMetadata = installed.peerDependenciesMeta && typeof installed.peerDependenciesMeta === "object"
      ? installed.peerDependenciesMeta as Record<string, { optional?: boolean }> : {};
    pending.push(...dependencyNames(installed.peerDependencies)
      .map((name) => ({ requester: location, name, optional: peerMetadata[name]?.optional === true })));
  }
  const installedPackages = [...fileSet]
    .filter((path) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path))
    .map((path) => path.slice(0, -"/package.json".length));
  for (const location of installedPackages) {
    const lockEntry = locked[location];
    if (!lockEntry || typeof lockEntry !== "object" || Array.isArray(lockEntry)) {
      throw new Error(`rogue node_modules package is absent from lock: ${location}`);
    }
    const installed = packageAt(location);
    if (installed.version !== (lockEntry as Record<string, unknown>).version) {
      throw new Error(`installed dependency version does not match lock entry for ${location}`);
    }
  }
}

function validateNodeReceipt(snapshotDirectory: string): z.infer<typeof nodeReceiptSchema> {
  const parsed = nodeReceiptSchema.safeParse(parseJson(join(snapshotDirectory, "runtime/node.json"), "Node receipt"));
  if (!parsed.success) throw new Error(`invalid Node identity/binary/sha/version/ABI evidence: ${parsed.error.message}`);
  const receipt = parsed.data;
  const actualRealpath = realpathSync(process.execPath);
  if (receipt.binaryRealpath !== actualRealpath ||
      receipt.sha256 !== sha256(readFileSync(actualRealpath)) ||
      receipt.version !== process.version || receipt.nativeAbi !== process.versions.modules) {
    throw new Error("Node identity/binary/sha/version/ABI evidence does not match the attesting runtime");
  }
  return receipt;
}

function validateService(snapshotDirectory: string): void {
  const service = readFileSync(join(snapshotDirectory, "systemd/agent-collab.service"), "utf8");
  if (service !== V1_SYSTEMD_UNIT) {
    throw new Error("systemd service must exactly match the frozen stable-dispatcher unit");
  }
}

function validateMcpReceipts(snapshotDirectory: string): void {
  const path = join(snapshotDirectory, "mcp/registrations.json");
  const raw = readFileSync(path, "utf8");
  if (redactSensitive(raw) !== raw || /"(?:env|environment)"\s*:/i.test(raw)) {
    throw new Error("MCP receipt must be credential-free and sanitized without environment secrets");
  }
  const schema = z.object({
    format: z.literal("agent-collab-mcp-receipts/v1"),
    registrations: z.array(z.object({
      agent: z.enum(["codex", "grok"]), transport: z.literal("stdio"),
      command: z.literal(DISPATCHER), args: z.tuple([z.literal("mcp")]),
    }).strict()).length(2),
  }).strict();
  const parsed = schema.safeParse(parseJson(path, "MCP receipt"));
  if (!parsed.success || parsed.data.registrations.map((item) => item.agent).join(",") !== "codex,grok") {
    throw new Error(`MCP receipts must register Codex and Grok through the stable dispatcher: ${parsed.error?.message ?? "wrong agents"}`);
  }
}

function validateSkills(snapshotDirectory: string): void {
  const path = join(snapshotDirectory, "skills/manifest.json");
  const schema = z.object({
    format: z.literal("agent-collab-skills/v1"),
    root: z.literal("/home/anton/.agents/skills"),
    files: z.tuple([z.object({
      path: z.literal("agent-collaboration/SKILL.md"), sha256: z.string().regex(SHA256),
    }).strict()]),
  }).strict();
  const parsed = schema.safeParse(parseJson(path, "skills manifest"));
  if (!parsed.success) throw new Error(`invalid skill sha/hash manifest: ${parsed.error.message}`);
  const bytes = readFileSync(join(snapshotDirectory, "skills/files", parsed.data.files[0].path));
  if (sha256(bytes) !== parsed.data.files[0].sha256) throw new Error("embedded skill byte hash drift");
}

function validateSnapshotSemantics(snapshotDirectory: string, files: readonly string[], proof: V1RuntimeProof): void {
  const fileSet = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) throw new Error(`missing required v1 runtime file: ${required}`);
  }
  const proofResult = proofSchema.safeParse(proof);
  if (!proofResult.success) throw new Error(`invalid reconstruction proof source/digest/gate: ${proofResult.error.message}`);
  if (redactSensitive(proofResult.data.gate.command) !== proofResult.data.gate.command) {
    throw new Error("reconstruction proof gate command must not contain credentials or secrets");
  }
  const receiptPath = join(snapshotDirectory, GATE_RECEIPT);
  const receiptBytes = readFileSync(receiptPath);
  if (sha256(receiptBytes) !== proofResult.data.gateReceiptSha256) {
    throw new Error("reconstruction proof gate receipt hash mismatch");
  }
  const receipt = gateReceiptSchema.safeParse(parseJson(receiptPath, "gate receipt"));
  if (!receipt.success) throw new Error(`invalid reconstruction gate receipt: ${receipt.error.message}`);
  const expectedReceipt = {
    format: "agent-collab-v1-gate-receipt/v1" as const,
    source: proofResult.data.source,
    sourceDigest: proofResult.data.sourceDigest,
    gate: proofResult.data.gate,
    runtimeTreeDigest: proofResult.data.runtimeTreeDigest,
  };
  if (JSON.stringify(receipt.data) !== JSON.stringify(expectedReceipt)) {
    throw new Error("reconstruction proof does not match its detached gate receipt");
  }
  if (v1RuntimeTreeDigest(snapshotDirectory) !== proofResult.data.runtimeTreeDigest) {
    throw new Error("reconstruction gate receipt is not bound to the exact runtime tree digest");
  }
  const cli = assertRegularUnlinkedFile(join(snapshotDirectory, "dist/cli.js"), "v1 CLI");
  if ((cli.mode & 0o111) === 0) throw new Error("v1 CLI mode must be executable");
  validateDependencyClosure(snapshotDirectory, fileSet);
  validateNodeReceipt(snapshotDirectory);
  validateService(snapshotDirectory);
  validateMcpReceipts(snapshotDirectory);
  validateSkills(snapshotDirectory);
}

export function createV1RuntimeManifest(input: {
  snapshotDirectory: string;
  proof: V1RuntimeProof;
}): V1RuntimeManifest {
  assertNoSymlinkInPath(input.snapshotDirectory);
  const snapshotDirectory = realpathSync(input.snapshotDirectory);
  const files = enumerateFiles(snapshotDirectory);
  validateSnapshotSemantics(snapshotDirectory, files, input.proof);
  const manifest: V1RuntimeManifest = {
    format: "agent-collab-v1-runtime/v1",
    proof: proofSchema.parse(input.proof),
    files: files.map((path) => {
      safeRelativePath(path);
      const absolute = join(snapshotDirectory, path);
      const stat = assertRegularUnlinkedFile(absolute);
      return { path, sha256: sha256(readFileSync(absolute)), size: stat.size, mode: stat.mode & 0o777 };
    }),
  };
  writeFileSync(join(snapshotDirectory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function verifyV1RuntimeSnapshot(snapshotDirectoryInput: string): {
  snapshotDirectory: string;
  manifest: V1RuntimeManifest;
} {
  assertNoSymlinkInPath(snapshotDirectoryInput);
  const snapshotDirectory = realpathSync(snapshotDirectoryInput);
  const manifestPath = join(snapshotDirectory, MANIFEST_NAME);
  assertRegularUnlinkedFile(manifestPath, "manifest");
  const parsed = manifestSchema.safeParse(parseJson(manifestPath, "manifest"));
  if (!parsed.success) throw new Error(`invalid runtime manifest: ${parsed.error.message}`);
  const manifest = parsed.data;
  const paths = manifest.files.map((file) => safeRelativePath(file.path));
  if (new Set(paths).size !== paths.length || paths.join("\n") !== [...paths].sort().join("\n")) {
    throw new Error("manifest file set must be unique and sorted");
  }
  const actualFiles = enumerateFiles(snapshotDirectory);
  if (actualFiles.join("\n") !== paths.join("\n")) {
    throw new Error("snapshot file set contains missing or undeclared files");
  }
  for (const expected of manifest.files) {
    const absolute = join(snapshotDirectory, expected.path);
    const stat = assertRegularUnlinkedFile(absolute);
    if (stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode) {
      throw new Error(`file metadata/mode drift: ${expected.path}`);
    }
    if (sha256(readFileSync(absolute)) !== expected.sha256) throw new Error(`file hash drift: ${expected.path}`);
  }
  validateSnapshotSemantics(snapshotDirectory, paths, manifest.proof);
  return { snapshotDirectory, manifest };
}

export function runtimeSnapshotDigest(snapshotDirectory: string): string {
  const verified = verifyV1RuntimeSnapshot(snapshotDirectory);
  return sha256(readFileSync(join(verified.snapshotDirectory, MANIFEST_NAME)));
}

function stageVerifiedRuntime(verified: ReturnType<typeof verifyV1RuntimeSnapshot>): string {
  const stage = mkdtempSync(join(tmpdir(), "agent-collab-v1-runtime-stage-"));
  for (const file of verified.manifest.files) {
    const source = join(verified.snapshotDirectory, file.path);
    const destination = join(stage, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, file.mode);
  }
  copyFileSync(join(verified.snapshotDirectory, MANIFEST_NAME), join(stage, MANIFEST_NAME), constants.COPYFILE_EXCL);
  chmodSync(join(stage, MANIFEST_NAME), 0o600);
  verifyV1RuntimeSnapshot(stage);
  return stage;
}

function validateNodeBinary(nodeBinary: string, receipt: z.infer<typeof nodeReceiptSchema>): string {
  let stat: Stats;
  try {
    stat = assertRegularUnlinkedFile(nodeBinary, "Node binary");
    accessSync(nodeBinary, constants.X_OK);
  } catch (error) {
    throw new Error(`Node binary is missing, non-regular, or not executable: ${String(error)}`);
  }
  if ((stat.mode & 0o111) === 0) throw new Error("Node binary mode is not executable");
  const realpath = realpathSync(nodeBinary);
  if (realpath !== receipt.binaryRealpath || sha256(readFileSync(realpath)) !== receipt.sha256) {
    throw new Error("Node binary identity/sha does not match attested runtime");
  }
  const identity = spawnSync(realpath, ["-p", "JSON.stringify({version:process.version,nativeAbi:process.versions.modules})"], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024,
  });
  if (identity.status !== 0) throw new Error("Node binary identity/version/ABI probe failed");
  let decoded: { version?: string; nativeAbi?: string };
  try { decoded = JSON.parse(identity.stdout.trim()) as typeof decoded; }
  catch { throw new Error("Node binary identity/version/ABI probe returned malformed JSON"); }
  if (decoded.version !== receipt.version || decoded.nativeAbi !== receipt.nativeAbi) {
    throw new Error("Node binary version/ABI does not match attested runtime");
  }
  return realpath;
}

async function backupDatabase(source: string, destination: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try { await database.backup(destination); }
  finally { database.close(); }
}

class ProcessGroupReapError extends Error {}

const SEALED_RUNTIME_RUNNER = String.raw`
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
const [nodeBinary, seed, sealed, expectedManifestDigest, ready, release] = process.argv.slice(1);
const fail = (message) => {
  process.stderr.write("V1_SEALED_RUNTIME_INTEGRITY: " + message + "\n");
  process.exit(97);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePath = (path) => {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      relative(".", path).split(sep).join("/") !== path) fail("unsafe manifest path");
  return path;
};
const enumerate = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) fail("symlink in runtime seed");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = lstatSync(absolute);
        if (stat.nlink !== 1) fail("hardlink in runtime seed");
        if (path !== "manifest.json") files.push(path);
      } else fail("unsupported runtime seed file type");
    }
  };
  visit(root);
  return files.sort();
};
if (ready && release) {
  writeFileSync(ready, "ready\n", { mode: 0o600 });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}
try {
  const mounted = spawnSync("/usr/bin/mount", [
    "-t", "tmpfs", "-o", "mode=0700,nosuid,nodev", "tmpfs", sealed,
  ], { encoding: "utf8" });
  if (mounted.status !== 0) fail("private tmpfs mount failed: " + (mounted.stderr || "unknown error").trim());
  const manifestBytes = readFileSync(join(seed, "manifest.json"));
  if (sha256(manifestBytes) !== expectedManifestDigest) fail("trusted manifest digest mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.format !== "agent-collab-v1-runtime/v1" || !Array.isArray(manifest.files)) {
    fail("malformed trusted manifest");
  }
  const paths = manifest.files.map((file) => safePath(file?.path));
  if (new Set(paths).size !== paths.length || paths.join("\n") !== [...paths].sort().join("\n")) {
    fail("manifest file set is not unique and sorted");
  }
  if (enumerate(seed).join("\n") !== paths.join("\n")) fail("runtime seed file set mismatch");
  for (const file of manifest.files) {
    const source = join(seed, file.path);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
      fail("runtime seed file is not a single-link regular file: " + file.path);
    }
    const destination = join(sealed, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, file.mode);
    const finalStat = lstatSync(destination);
    if (!Number.isInteger(file.size) || !Number.isInteger(file.mode) || typeof file.sha256 !== "string" ||
        !finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink !== 1 ||
        finalStat.size !== file.size || (finalStat.mode & 0o777) !== file.mode ||
        sha256(readFileSync(destination)) !== file.sha256) {
      fail("sealed runtime file mismatch: " + file.path);
    }
  }
  writeFileSync(join(sealed, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
  if (enumerate(sealed).join("\n") !== paths.join("\n")) fail("sealed runtime file set mismatch");
  const bound = spawnSync("/usr/bin/mount", ["--bind", sealed, sealed], { encoding: "utf8" });
  if (bound.status !== 0) fail("sealed bind mount failed: " + (bound.stderr || "unknown error").trim());
  const remounted = spawnSync("/usr/bin/mount", [
    "-o", "remount,bind,ro,nosuid,nodev", sealed, sealed,
  ], { encoding: "utf8" });
  if (remounted.status !== 0) fail("read-only remount failed: " + (remounted.stderr || "unknown error").trim());
  const result = spawnSync(nodeBinary, [join(sealed, "dist/cli.js"), "status"], {
    cwd: sealed,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;

async function runStatus(input: {
  nodeBinary: string;
  runtimeSeed: string;
  expectedRuntimeDigest: string;
  stateRoot: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  testing?: {
    forceReapTimeout?: boolean;
    afterChildRunnerStarted?: (runtime: string) => void;
  };
}): Promise<string> {
  const rawEnvironment = JSON.stringify(input.env ?? {});
  if (redactSensitive(rawEnvironment) !== rawEnvironment) {
    throw new Error("v1 status environment must not contain credentials or secrets");
  }
  const allowedEnvironment = new Set([
    "V1_FIXTURE_LOG", "V1_PROVIDER_LOG", "V1_LATE_SIDE_EFFECT", "V1_NETWORK_URL", "V1_SEAL_PROBE_LOG",
    "AGENT_COLLAB_CLAUDE_BIN", "AGENT_COLLAB_CODEX_BIN", "AGENT_COLLAB_GROK_BIN",
  ]);
  const suppliedEnvironment = Object.fromEntries(Object.entries(input.env ?? {}).filter(([key, value]) => {
    if (!allowedEnvironment.has(key)) throw new Error(`v1 status environment variable is not allowlisted: ${key}`);
    return value !== undefined;
  })) as NodeJS.ProcessEnv;
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const sealedRuntime = join(input.stateRoot, "sealed-runtime");
    mkdirSync(sealedRuntime, { mode: 0o700 });
    const ready = input.testing?.afterChildRunnerStarted ? join(input.stateRoot, "runner.ready") : "";
    const release = input.testing?.afterChildRunnerStarted ? join(input.stateRoot, "runner.release") : "";
    const child = spawn("/usr/bin/unshare", [
      "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--kill-child=KILL",
      "--mount-proc", "--", input.nodeBinary, "--input-type=module", "-e", SEALED_RUNTIME_RUNNER,
      input.nodeBinary, input.runtimeSeed, sealedRuntime, input.expectedRuntimeDigest, ready, release,
    ], {
      cwd: input.runtimeSeed,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        LANG: "C.UTF-8",
        HOME: input.stateRoot,
        XDG_CACHE_HOME: join(input.stateRoot, "cache"),
        XDG_CONFIG_HOME: join(input.stateRoot, "config"),
        ...suppliedEnvironment,
        AGENT_COLLAB_STATE_DIR: input.stateRoot,
      },
    });
    const limit = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    let reapTimer: NodeJS.Timeout | undefined;
    let barrierTimer: NodeJS.Timeout | undefined;
    let terminalError: Error | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer) clearTimeout(reapTimer);
      if (barrierTimer) clearInterval(barrierTimer);
      if (error) rejectPromise(error); else resolvePromise(stdout);
    };
    const terminate = (error: Error): void => {
      if (terminalError) return;
      terminalError = error;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      reapTimer = setTimeout(() => finish(new ProcessGroupReapError(
        `${error.message}; process group reap timed out and containment roots were retained`)),
      input.testing?.forceReapTimeout ? 10 : 2_000);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) {
        terminate(new Error("v1 status output exceeded limit"));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => finish(new Error(`v1 status launch failed: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (terminalError && input.testing?.forceReapTimeout) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) finish(new Error(`v1 status failed with exit ${String(code)} signal ${String(signal)}: ${stderr.trim()}`));
      else finish();
    });
    if (input.testing?.afterChildRunnerStarted) {
      barrierTimer = setInterval(() => {
        if (!existsSync(ready) || existsSync(release)) return;
        try {
          input.testing!.afterChildRunnerStarted!(input.runtimeSeed);
          writeFileSync(release, "release\n", { mode: 0o600 });
        } catch (error) {
          writeFileSync(release, "release\n", { mode: 0o600 });
          terminate(error instanceof Error ? error : new Error(String(error)));
        }
      }, 5);
    }
    const effectiveTimeoutMs = Math.max(input.timeoutMs, 100);
    timer = setTimeout(() => {
      terminate(new Error(`v1 status timed out after ${input.timeoutMs}ms`));
    }, effectiveTimeoutMs);
  });
}

export async function preflightV1Runtime(input: {
  snapshotDirectory: string;
  stateDatabase: string;
  historyDatabase: string;
  nodeBinary: string;
  expectedRuntimeDigest: string;
  expectedGateReceiptSha256: string;
  expectedSourceDigest: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  testing?: {
    beforeRuntimeStage?: () => void;
    forceReapTimeout?: boolean;
    onContainmentRoots?: (roots: { runtime: string; state: string }) => void;
    afterChildRunnerStarted?: (runtime: string) => void;
  };
}): Promise<{ protocol: string; runtimeDigest: string }> {
  const verified = verifyV1RuntimeSnapshot(input.snapshotDirectory);
  const runtimeDigest = sha256(readFileSync(join(verified.snapshotDirectory, MANIFEST_NAME)));
  if (runtimeDigest !== input.expectedRuntimeDigest) throw new Error("v1 runtime digest/hash mismatch");
  if (verified.manifest.proof.gateReceiptSha256 !== input.expectedGateReceiptSha256 ||
      verified.manifest.proof.sourceDigest !== input.expectedSourceDigest) {
    throw new Error("v1 runtime external gate receipt/source trust anchor mismatch");
  }
  const receiptParsed = nodeReceiptSchema.safeParse(parseJson(join(verified.snapshotDirectory, "runtime/node.json"), "Node receipt"));
  if (!receiptParsed.success) throw new Error("invalid Node runtime receipt");
  const nodeBinary = validateNodeBinary(input.nodeBinary, receiptParsed.data);
  input.testing?.beforeRuntimeStage?.();
  const stagedRuntime = stageVerifiedRuntime(verified);
  if (runtimeSnapshotDigest(stagedRuntime) !== runtimeDigest) {
    rmSync(stagedRuntime, { recursive: true, force: true });
    throw new Error("staged v1 runtime digest differs from the caller-attested runtime");
  }
  const stateRoot = mkdtempSync(join(tmpdir(), "agent-collab-v1-preflight-"));
  input.testing?.onContainmentRoots?.({ runtime: stagedRuntime, state: stateRoot });
  let retainContainmentRoots = false;
  try {
    await backupDatabase(input.stateDatabase, join(stateRoot, "collaboration.db"));
    await backupDatabase(input.historyDatabase, join(stateRoot, "history.db"));
    const stdout = await runStatus({
      nodeBinary,
      runtimeSeed: stagedRuntime,
      expectedRuntimeDigest: runtimeDigest,
      stateRoot,
      timeoutMs: input.timeoutMs ?? 5_000,
      ...(input.env ? { env: input.env } : {}),
      ...(input.testing?.forceReapTimeout || input.testing?.afterChildRunnerStarted
        ? { testing: {
          ...(input.testing.forceReapTimeout ? { forceReapTimeout: true } : {}),
          ...(input.testing.afterChildRunnerStarted
            ? { afterChildRunnerStarted: input.testing.afterChildRunnerStarted } : {}),
        } } : {}),
    });
    let status: { protocol?: unknown };
    try { status = JSON.parse(stdout.trim()) as typeof status; }
    catch (error) { throw new Error(`v1 status JSON is malformed: ${String(error)}`); }
    if (status.protocol !== "agent-collab/v1") throw new Error("v1 status protocol mismatch");
    return { protocol: status.protocol, runtimeDigest };
  } catch (error) {
    if (error instanceof ProcessGroupReapError) retainContainmentRoots = true;
    throw error;
  } finally {
    if (!retainContainmentRoots) {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(stagedRuntime, { recursive: true, force: true });
    }
  }
}
