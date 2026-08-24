import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const ROLLBACK_BUNDLE_FORMAT = "agent-collab-rollback/v1" as const;
const MANIFEST = "manifest.json";
const STATE_BACKUP = "collaboration-v1.db";
const HISTORY_BACKUP = "history-v1.db";

const safeRelativePath = z.string().min(1).refine((path) => {
  if (isAbsolute(path) || path.includes("\\")) return false;
  const normalized = resolve("/bundle", path);
  return normalized.startsWith(`/bundle${sep}`) && relative("/bundle", normalized) === path;
}, "bundle file path must be a normalized relative path");

const fileEvidenceSchema = z.object({
  path: safeRelativePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777),
}).strict();

const manifestSchema = z.object({
  format: z.literal(ROLLBACK_BUNDLE_FORMAT),
  sourceVersion: z.literal(1),
  createdAt: z.string().datetime(),
  databases: z.object({
    state: z.literal(STATE_BACKUP),
    history: z.literal(HISTORY_BACKUP),
  }).strict(),
  files: z.array(fileEvidenceSchema).min(2),
}).strict().superRefine((manifest, context) => {
  const paths = manifest.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "bundle manifest contains duplicate paths" });
  }
  for (const required of [STATE_BACKUP, HISTORY_BACKUP]) {
    if (!paths.includes(required)) {
      context.addIssue({ code: "custom", message: `bundle manifest is missing ${required}` });
    }
  }
});

export type RollbackBundleManifest = z.infer<typeof manifestSchema>;

export interface RollbackArtifact {
  name: string;
  sourcePath: string;
}

export interface VerifiedBundle {
  bundleDirectory: string;
  manifest: RollbackBundleManifest;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`rollback bundle root must be a real directory: ${resolved}`);
  }
  chmodSync(resolved, 0o700);
  return resolved;
}

function assertSafeArtifactName(name: string): void {
  const parsed = safeRelativePath.safeParse(name);
  if (!parsed.success || name === MANIFEST || name.startsWith("artifacts/") ||
      name === STATE_BACKUP || name === HISTORY_BACKUP) {
    throw new Error(`invalid rollback artifact name: ${name}`);
  }
}

function assertNoSymlinks(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`rollback artifacts cannot contain symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry));
}

function filesUnder(root: string, current = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`rollback bundle contains a symlink: ${path}`);
    if (entry.isDirectory()) found.push(...filesUnder(root, path));
    else if (entry.isFile()) found.push(relative(root, path));
    else throw new Error(`rollback bundle contains an unsupported entry: ${path}`);
  }
  return found.sort();
}

function evidence(root: string, path: string) {
  const absolute = join(root, path);
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error(`rollback bundle entry is not a regular file: ${path}`);
  return {
    path,
    sha256: hashFile(absolute),
    size: stat.size,
    mode: stat.mode & 0o777,
  };
}

export function prepareRollbackBundle(input: {
  bundleDirectory: string;
  artifacts?: readonly RollbackArtifact[];
}): { bundleDirectory: string } {
  const root = ensureDirectory(input.bundleDirectory);
  for (const reserved of [MANIFEST, STATE_BACKUP, HISTORY_BACKUP]) {
    if (existsSync(join(root, reserved))) {
      throw new Error(`rollback bundle already contains reserved entry: ${reserved}`);
    }
  }
  const artifacts = input.artifacts ?? [];
  const names = new Set<string>();
  for (const artifact of artifacts) {
    assertSafeArtifactName(artifact.name);
    if (names.has(artifact.name)) throw new Error(`duplicate rollback artifact name: ${artifact.name}`);
    names.add(artifact.name);
    const source = resolve(artifact.sourcePath);
    assertNoSymlinks(source);
    const target = join(root, "artifacts", artifact.name);
    if (existsSync(target)) throw new Error(`rollback artifact already exists: ${artifact.name}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  }
  return { bundleDirectory: root };
}

export function finalizeRollbackBundle(bundleDirectory: string): VerifiedBundle {
  const root = ensureDirectory(bundleDirectory);
  if (existsSync(join(root, MANIFEST))) throw new Error("rollback bundle manifest already exists");
  for (const required of [STATE_BACKUP, HISTORY_BACKUP]) {
    if (!existsSync(join(root, required))) throw new Error(`rollback bundle is missing ${required}`);
  }
  const paths = filesUnder(root).filter((path) => path !== MANIFEST);
  const allowed = paths.every((path) =>
    path === STATE_BACKUP || path === HISTORY_BACKUP || path.startsWith(`artifacts${sep}`));
  if (!allowed) throw new Error("rollback bundle contains files outside its declared layout");
  const manifest: RollbackBundleManifest = {
    format: ROLLBACK_BUNDLE_FORMAT,
    sourceVersion: 1,
    createdAt: new Date().toISOString(),
    databases: { state: STATE_BACKUP, history: HISTORY_BACKUP },
    files: paths.map((path) => evidence(root, path)),
  };
  manifestSchema.parse(manifest);
  const temporary = join(root, `.manifest-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(root, MANIFEST));
  return verifyBundle(root);
}

export function verifyBundle(bundleDirectory: string): VerifiedBundle {
  const root = ensureDirectory(bundleDirectory);
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new Error("rollback bundle manifest is missing or invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("rollback bundle manifest is malformed", { cause: error });
  }
  const manifest = manifestSchema.parse(decoded);
  const actualPaths = filesUnder(root).filter((path) => path !== MANIFEST);
  const declaredPaths = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error("rollback bundle file set does not match its manifest");
  }
  for (const declared of manifest.files) {
    const actual = evidence(root, declared.path);
    if (actual.sha256 !== declared.sha256) {
      throw new Error(`rollback bundle hash mismatch: ${declared.path}`);
    }
    if (actual.size !== declared.size || actual.mode !== declared.mode) {
      throw new Error(`rollback bundle metadata mismatch: ${declared.path}`);
    }
  }
  return { bundleDirectory: root, manifest };
}

export function restoreV1Bundle(input: {
  bundleDirectory: string;
  stateDatabase: string;
  historyDatabase: string;
  faultInjector?: (point: "after_state_replace") => void;
}): { restored: true; manifest: RollbackBundleManifest } {
  const verified = verifyBundle(input.bundleDirectory);
  const stateDestination = resolve(input.stateDatabase);
  const historyDestination = resolve(input.historyDatabase);
  if (stateDestination === historyDestination) throw new Error("state and history databases must be distinct");

  const nonce = randomUUID();
  const stateStage = `${stateDestination}.restore-${nonce}`;
  const historyStage = `${historyDestination}.restore-${nonce}`;
  const statePrevious = `${stateDestination}.pre-restore-${nonce}`;
  const historyPrevious = `${historyDestination}.pre-restore-${nonce}`;
  const stateExisted = existsSync(stateDestination);
  const historyExisted = existsSync(historyDestination);
  let replacementStarted = false;
  try {
    copyFileSync(join(verified.bundleDirectory, verified.manifest.databases.state), stateStage);
    copyFileSync(join(verified.bundleDirectory, verified.manifest.databases.history), historyStage);
    const expected = Object.fromEntries(verified.manifest.files.map((file) => [file.path, file.sha256]));
    if (hashFile(stateStage) !== expected[STATE_BACKUP] ||
        hashFile(historyStage) !== expected[HISTORY_BACKUP]) {
      throw new Error("staged rollback database hash mismatch");
    }
    for (const destination of [stateDestination, historyDestination]) {
      rmSync(`${destination}-wal`, { force: true });
      rmSync(`${destination}-shm`, { force: true });
    }
    if (stateExisted) copyFileSync(stateDestination, statePrevious);
    if (historyExisted) copyFileSync(historyDestination, historyPrevious);
    replacementStarted = true;
    renameSync(stateStage, stateDestination);
    input.faultInjector?.("after_state_replace");
    renameSync(historyStage, historyDestination);
  } catch (error) {
    if (replacementStarted) {
      const restoreErrors: unknown[] = [];
      for (const [destination, previous, existed] of [
        [stateDestination, statePrevious, stateExisted],
        [historyDestination, historyPrevious, historyExisted],
      ] as const) {
        try {
          if (existed) copyFileSync(previous, destination);
          else rmSync(destination, { force: true });
        } catch (restoreError) { restoreErrors.push(restoreError); }
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError([error, ...restoreErrors], "rollback replacement and compensation failed");
      }
    }
    throw error;
  } finally {
    rmSync(stateStage, { force: true });
    rmSync(historyStage, { force: true });
    rmSync(statePrevious, { force: true });
    rmSync(historyPrevious, { force: true });
  }
  return { restored: true, manifest: verified.manifest };
}
