import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { computeBytesSha256 } from "../domain/canonical-json.js";

const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,255}$/;
const SAFE_LOCK_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SAFE_FAULT_PREFIX = /^[a-z][a-z0-9_]{0,63}$/;
const FLOCK_WAIT_SECONDS = 5;

export type StateFileFaultDetails = Readonly<Record<string, unknown>>;
export type StateFileFaultInjector = (point: string, details?: StateFileFaultDetails) => void;

export interface PinnedStateFile {
  readonly absolutePath: string;
  read(): Buffer;
  assertCurrent(): void;
  close(): void;
}

const authenticPinnedStateFiles = new WeakSet<object>();

export function assertAuthenticPinnedStateFile(file: PinnedStateFile): void {
  if (!authenticPinnedStateFiles.has(file as object)) {
    throw new Error("pinned state file handle was not issued by StateFileDurability");
  }
}

export interface StateFileLockFaultPoints {
  readonly beforeAcquire?: string;
  readonly afterContended?: string;
  readonly afterAcquired?: string;
}

export interface StateFileExclusiveLockInput {
  readonly lockBasename: string;
  readonly faultPoints?: StateFileLockFaultPoints;
  readonly faultDetails?: StateFileFaultDetails;
}

export interface StateFileDurabilityOptions {
  readonly stateRoot: string;
  readonly faultInjector?: StateFileFaultInjector;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ParentDirectory {
  readonly descriptor: number;
  readonly absolutePath: string;
  readonly ownsDescriptor: boolean;
}

interface PublicationFaultPoints {
  readonly afterTempWrite?: string;
  readonly afterFileFsync?: string;
  readonly afterRename?: string;
  readonly afterDirectoryFsync?: string;
}

class StateFileInjectedFault extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
}

function requireRegularFile(stat: Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} is not a regular no-follow file`);
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function closeParent(parent: ParentDirectory): void {
  if (parent.ownsDescriptor) closeSync(parent.descriptor);
}

class PinnedStateFileHandle implements PinnedStateFile {
  #closed = false;

  constructor(
    readonly absolutePath: string,
    private readonly descriptor: number,
    private readonly parent: ParentDirectory,
    private readonly fileBasename: string,
    private readonly expectedIdentity: FileIdentity,
    private readonly assertOwnerCurrent: () => void,
    private readonly onClose: () => void,
  ) {}

  assertCurrent(): void {
    if (this.#closed) throw new Error("pinned state file lease is closed");
    this.assertOwnerCurrent();
    const parentDescriptor = fstatSync(this.parent.descriptor);
    const parentPath = lstatSync(this.parent.absolutePath);
    requireDirectory(parentDescriptor, "pinned state file parent descriptor");
    requireDirectory(parentPath, "pinned state file parent path");
    if (parentDescriptor.dev !== parentPath.dev || parentDescriptor.ino !== parentPath.ino) {
      throw new Error("pinned state file parent identity changed");
    }
    const descriptorStat = fstatSync(this.descriptor);
    const pinnedPath = `/proc/self/fd/${this.parent.descriptor}/${this.fileBasename}`;
    const pinnedStat = lstatSync(pinnedPath);
    const absoluteStat = lstatSync(this.absolutePath);
    requireRegularFile(descriptorStat, "pinned state file descriptor");
    requireRegularFile(pinnedStat, "pinned state file path");
    requireRegularFile(absoluteStat, "state file path");
    if (!sameIdentity(this.expectedIdentity, descriptorStat) ||
        !sameIdentity(this.expectedIdentity, pinnedStat) ||
        !sameIdentity(this.expectedIdentity, absoluteStat)) {
      throw new Error("pinned state file identity changed");
    }
  }

  read(): Buffer {
    this.assertCurrent();
    const before = fstatSync(this.descriptor);
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error("pinned state file size is invalid");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(this.descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("pinned state file was truncated during reread");
      offset += count;
    }
    const after = fstatSync(this.descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("pinned state file changed during reread");
    }
    this.assertCurrent();
    return bytes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      closeSync(this.descriptor);
    } finally {
      try {
        closeParent(this.parent);
      } finally {
        this.onClose();
      }
    }
  }
}

Object.freeze(PinnedStateFileHandle.prototype);

export class StateFileDurability {
  readonly #rootPath: string;
  readonly #rootDescriptor: number;
  readonly #rootIdentity: FileIdentity;
  readonly #faultInjector: StateFileFaultInjector | undefined;
  readonly #handles = new Set<PinnedStateFileHandle>();
  #closed = false;

  constructor(input: StateFileDurabilityOptions) {
    const requestedRoot = resolve(input.stateRoot);
    const rootStat = lstatSync(requestedRoot);
    requireDirectory(rootStat, "state file root");
    if (realpathSync(requestedRoot) !== requestedRoot) {
      throw new Error("state file root must be a canonical non-symlink path");
    }
    const descriptor = openSync(
      requestedRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const descriptorStat = fstatSync(descriptor);
      requireDirectory(descriptorStat, "state file root descriptor");
      if (descriptorStat.dev !== rootStat.dev || descriptorStat.ino !== rootStat.ino) {
        throw new Error("state file root identity changed while opening");
      }
      this.#rootPath = requestedRoot;
      this.#rootDescriptor = descriptor;
      this.#rootIdentity = identity(descriptorStat);
      this.#faultInjector = input.faultInjector;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("state file durability adapter is closed");
  }

  #assertRootCurrent(): void {
    this.#assertOpen();
    const descriptorStat = fstatSync(this.#rootDescriptor);
    const pathStat = lstatSync(this.#rootPath);
    requireDirectory(descriptorStat, "state file root descriptor");
    requireDirectory(pathStat, "state file root path");
    if (!sameIdentity(this.#rootIdentity, descriptorStat) || !sameIdentity(this.#rootIdentity, pathStat) ||
        realpathSync(this.#rootPath) !== this.#rootPath) {
      throw new Error("state file root identity changed");
    }
  }

  #fault(point: string | undefined, details?: StateFileFaultDetails): void {
    if (point === undefined || this.#faultInjector === undefined) return;
    try {
      this.#faultInjector(point, details);
    } catch (error) {
      throw new StateFileInjectedFault(error);
    }
  }

  #relativeParts(relativePath: string): string[] {
    if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath) ||
        relativePath.includes("\\") || relativePath.includes("\0")) {
      throw new Error("state file path must be a confined relative path");
    }
    const parts = relativePath.split("/");
    if (parts.join("/") !== relativePath || parts.some((part) =>
      part === "." || part === ".." || !SAFE_COMPONENT.test(part))) {
      throw new Error("state file path contains an unsafe component");
    }
    const absolute = resolve(this.#rootPath, ...parts);
    const rel = relative(this.#rootPath, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("state file path escapes its confined root");
    }
    return parts;
  }

  #openParent(relativePath: string, create: boolean): { parent: ParentDirectory; basename: string } {
    const parts = this.#relativeParts(relativePath);
    const basename = parts.at(-1)!;
    const directories = parts.slice(0, -1);
    this.#assertRootCurrent();
    let descriptor = this.#rootDescriptor;
    let ownsDescriptor = false;
    let absolutePath = this.#rootPath;
    try {
      for (const component of directories) {
        const childPath = `/proc/self/fd/${descriptor}/${component}`;
        const childAbsolutePath = resolve(absolutePath, component);
        if (lstatIfPresent(childPath) === undefined) {
          if (!create) throw new Error("state file parent directory does not exist");
          try {
            mkdirSync(childPath, { mode: 0o700 });
            fsyncSync(descriptor);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        const childDescriptor = openSync(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const descriptorStat = fstatSync(childDescriptor);
          const childStat = lstatSync(childPath);
          const absoluteStat = lstatSync(childAbsolutePath);
          requireDirectory(descriptorStat, "state file directory descriptor");
          requireDirectory(childStat, "state file directory");
          requireDirectory(absoluteStat, "state file absolute directory");
          if (descriptorStat.dev !== childStat.dev || descriptorStat.ino !== childStat.ino ||
              descriptorStat.dev !== absoluteStat.dev || descriptorStat.ino !== absoluteStat.ino) {
            throw new Error("state file directory identity changed while opening");
          }
        } catch (error) {
          closeSync(childDescriptor);
          throw error;
        }
        if (ownsDescriptor) closeSync(descriptor);
        descriptor = childDescriptor;
        ownsDescriptor = true;
        absolutePath = childAbsolutePath;
      }
      return {
        parent: { descriptor, absolutePath, ownsDescriptor },
        basename,
      };
    } catch (error) {
      if (ownsDescriptor) closeSync(descriptor);
      if (error instanceof Error && /state file|symlink|no-follow/i.test(error.message)) throw error;
      throw new Error("state file path is not a confined no-follow path", { cause: error });
    }
  }

  #assertDirectFile(
    descriptor: number,
    parent: ParentDirectory,
    basename: string,
    absolutePath: string,
  ): FileIdentity {
    const descriptorStat = fstatSync(descriptor);
    const pinnedStat = lstatSync(`/proc/self/fd/${parent.descriptor}/${basename}`);
    const absoluteStat = lstatSync(absolutePath);
    requireRegularFile(descriptorStat, "state file descriptor");
    requireRegularFile(pinnedStat, "state file pinned path");
    requireRegularFile(absoluteStat, "state file absolute path");
    if (descriptorStat.dev !== pinnedStat.dev || descriptorStat.ino !== pinnedStat.ino ||
        descriptorStat.dev !== absoluteStat.dev || descriptorStat.ino !== absoluteStat.ino) {
      throw new Error("state file identity changed while opening");
    }
    return identity(descriptorStat);
  }

  #lease(parent: ParentDirectory, basename: string, relativePath: string, descriptor: number): PinnedStateFile {
    const absolutePath = resolve(this.#rootPath, ...relativePath.split("/"));
    const expectedIdentity = this.#assertDirectFile(descriptor, parent, basename, absolutePath);
    let handle: PinnedStateFileHandle;
    handle = new PinnedStateFileHandle(
      absolutePath,
      descriptor,
      parent,
      basename,
      expectedIdentity,
      () => this.#assertRootCurrent(),
      () => this.#handles.delete(handle),
    );
    Object.freeze(handle);
    authenticPinnedStateFiles.add(handle);
    this.#handles.add(handle);
    return handle;
  }

  #openAt(parent: ParentDirectory, basename: string, relativePath: string): PinnedStateFile {
    const descriptor = openSync(
      `/proc/self/fd/${parent.descriptor}/${basename}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return this.#lease(parent, basename, relativePath, descriptor);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  openPinned(relativePath: string): PinnedStateFile {
    const { parent, basename } = this.#openParent(relativePath, false);
    try {
      return this.#openAt(parent, basename, relativePath);
    } catch (error) {
      closeParent(parent);
      if (error instanceof Error && /state file|symlink|no-follow|pinned/i.test(error.message)) throw error;
      throw new Error("state file cannot be opened as a pinned regular file", { cause: error });
    }
  }

  withExclusiveLock<T>(input: StateFileExclusiveLockInput, operation: () => T): T {
    this.#assertRootCurrent();
    if (!SAFE_LOCK_BASENAME.test(input.lockBasename)) {
      throw new Error("state file lock basename is unsafe");
    }
    const details = input.faultDetails;
    this.#fault(input.faultPoints?.beforeAcquire, details);
    const absolutePath = resolve(this.#rootPath, input.lockBasename);
    const pinnedPath = `/proc/self/fd/${this.#rootDescriptor}/${input.lockBasename}`;
    const descriptor = openSync(
      pinnedPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      this.#assertDirectFile(
        descriptor,
        { descriptor: this.#rootDescriptor, absolutePath: this.#rootPath, ownsDescriptor: false },
        input.lockBasename,
        absolutePath,
      );
      const attempt = spawnSync("/usr/bin/flock", ["-n", "-x", "3"], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe", descriptor],
      });
      if (attempt.error || (attempt.status !== 0 && attempt.status !== 1)) {
        throw new Error(`state file flock failed: ${attempt.error?.message ?? attempt.stderr ?? "unknown error"}`);
      }
      if (attempt.status === 1) {
        this.#fault(input.faultPoints?.afterContended, details);
        const waited = spawnSync(
          "/usr/bin/flock",
          ["-w", String(FLOCK_WAIT_SECONDS), "-x", "3"],
          { encoding: "utf8", stdio: ["ignore", "ignore", "pipe", descriptor] },
        );
        if (waited.error || waited.status !== 0) {
          throw new Error(`state file lock remained contended: ${waited.error?.message ?? waited.stderr ?? "timeout"}`);
        }
      }
      this.#assertDirectFile(
        descriptor,
        { descriptor: this.#rootDescriptor, absolutePath: this.#rootPath, ownsDescriptor: false },
        input.lockBasename,
        absolutePath,
      );
      this.#fault(input.faultPoints?.afterAcquired, details);
      return operation();
    } finally {
      closeSync(descriptor);
    }
  }

  withFlowLock<T>(flowId: string, operation: () => T): T {
    if (typeof flowId !== "string" || flowId.length === 0) throw new Error("archive flowId is required for locking");
    const lockKey = computeBytesSha256(flowId);
    const lockBasename = `${lockKey}.lock`;
    return this.withExclusiveLock({
      lockBasename,
      faultPoints: {
        beforeAcquire: "before_lock_acquire",
        afterContended: "after_lock_contended",
        afterAcquired: "after_lock_acquired",
      },
      faultDetails: { lockBasename, lockKey },
    }, operation);
  }

  #publish(input: {
    readonly relativePath: string;
    readonly bytes: Buffer;
    readonly replace: boolean;
    readonly faultPoints: PublicationFaultPoints;
  }): { file: PinnedStateFile; created: boolean } {
    this.#assertRootCurrent();
    if (!Buffer.isBuffer(input.bytes)) throw new Error("state file publication requires Buffer bytes");
    const { parent, basename } = this.#openParent(input.relativePath, true);
    const finalPinnedPath = `/proc/self/fd/${parent.descriptor}/${basename}`;
    const finalAbsolutePath = resolve(this.#rootPath, ...input.relativePath.split("/"));
    let parentTransferred = false;
    let descriptor: number | undefined;
    let temporaryPath: string | undefined;
    let temporaryExists = false;
    try {
      const existing = lstatIfPresent(finalPinnedPath);
      if (existing !== undefined) {
        requireRegularFile(existing, "existing state file");
        if (!input.replace) {
          const file = this.#openAt(parent, basename, input.relativePath);
          parentTransferred = true;
          return { file, created: false };
        }
        const existingDescriptor = openSync(finalPinnedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          this.#assertDirectFile(existingDescriptor, parent, basename, finalAbsolutePath);
        } finally {
          closeSync(existingDescriptor);
        }
      }

      const temporaryBasename = `.${basename}.${process.pid}.${randomUUID()}.tmp`;
      temporaryPath = `/proc/self/fd/${parent.descriptor}/${temporaryBasename}`;
      descriptor = openSync(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      let offset = 0;
      while (offset < input.bytes.length) {
        const written = writeSync(descriptor, input.bytes, offset, input.bytes.length - offset, offset);
        if (written === 0) throw new Error("state file temp write made no progress");
        offset += written;
      }
      this.#fault(input.faultPoints.afterTempWrite);
      fsyncSync(descriptor);
      this.#fault(input.faultPoints.afterFileFsync);

      if (!input.replace && lstatIfPresent(finalPinnedPath) !== undefined) {
        unlinkSync(temporaryPath);
        temporaryExists = false;
        fsyncSync(parent.descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        const file = this.#openAt(parent, basename, input.relativePath);
        parentTransferred = true;
        return { file, created: false };
      }
      renameSync(temporaryPath, finalPinnedPath);
      temporaryExists = false;
      this.#fault(input.faultPoints.afterRename);
      fsyncSync(parent.descriptor);
      this.#fault(input.faultPoints.afterDirectoryFsync);

      const file = this.#lease(parent, basename, input.relativePath, descriptor);
      descriptor = undefined;
      parentTransferred = true;
      return { file, created: true };
    } catch (error) {
      if (error instanceof StateFileInjectedFault ||
          (error instanceof Error && /state file|archive|projection/i.test(error.message))) throw error;
      throw new Error("state file no-follow atomic publication failed", { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporaryExists && temporaryPath !== undefined && existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
        fsyncSync(parent.descriptor);
      }
      if (!parentTransferred) closeParent(parent);
    }
  }

  atomicReplace(input: {
    readonly relativePath: string;
    readonly bytes: Buffer;
    readonly faultPointPrefix: string;
  }): PinnedStateFile {
    if (!SAFE_FAULT_PREFIX.test(input.faultPointPrefix)) {
      throw new Error("state file fault-point prefix is unsafe");
    }
    return this.#publish({
      relativePath: input.relativePath,
      bytes: input.bytes,
      replace: true,
      faultPoints: {
        afterTempWrite: `after_${input.faultPointPrefix}_temp_write`,
        afterFileFsync: `after_${input.faultPointPrefix}_file_fsync`,
        afterRename: `after_${input.faultPointPrefix}_rename`,
        afterDirectoryFsync: `after_${input.faultPointPrefix}_directory_fsync`,
      },
    }).file;
  }

  publishImmutable(input: {
    readonly relativePath: string;
    readonly bytes: Buffer;
  }): { file: PinnedStateFile; created: boolean } {
    return this.#publish({
      relativePath: input.relativePath,
      bytes: input.bytes,
      replace: false,
      faultPoints: {
        afterFileFsync: "after_file_fsync",
        afterRename: "after_rename",
        afterDirectoryFsync: "after_directory_fsync",
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    for (const handle of [...this.#handles]) handle.close();
    this.#closed = true;
    closeSync(this.#rootDescriptor);
  }
}
