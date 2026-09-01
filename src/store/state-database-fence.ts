import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { appendStateV4GuardEvent, inspectStateV4OpenAdmission } from "../migration/state-v4-restore-authority.js";
import { acquireStateRootLease } from "./state-layout.js";

export type StateDatabaseAdmissionMode = "offline_observation" | "service_runtime" | "mutating_service";

interface LeaseState {
  readonly database: Database.Database;
  readonly canonicalPath: string;
  readonly databaseIdentity: { dev: number; ino: number };
  readonly rootIdentity: { dev: number; ino: number };
  readonly generation: string;
  readonly releaseRoot: () => void;
  borrows: number;
  ownerClosed: boolean;
  released: boolean;
}

const issuedStateDatabaseAccesses = new WeakSet<object>();
const issuanceToken = Symbol("state-database-access-issuance");

export interface StateDatabaseAccess {
  readonly database: Database.Database;
  readonly canonicalPath: string;
  readonly generation: string;
  assertUsable(): void;
  borrow(): StateDatabaseAccess;
  close(): void;
}

const releaseWhenUnused = (state: LeaseState): void => {
  if (!state.ownerClosed || state.borrows !== 0 || state.released) return;
  state.released = true;
  try { if (state.database.open) state.database.close(); }
  finally { state.releaseRoot(); }
};

const assertCanonicalDatabaseIdentity = (state: Pick<LeaseState, "canonicalPath" | "databaseIdentity">): void => {
  if (state.canonicalPath === ":memory:") return;
  if (!existsSync(state.canonicalPath)) throw new Error("state database pathname disappeared during its lease");
  const link = lstatSync(state.canonicalPath);
  const current = statSync(state.canonicalPath);
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1 ||
      current.dev !== state.databaseIdentity.dev || current.ino !== state.databaseIdentity.ino) {
    throw new Error("state database identity changed during its lease");
  }
};

const assertCanonicalRootIdentity = (
  state: Pick<LeaseState, "canonicalPath" | "rootIdentity">,
): void => {
  if (state.canonicalPath === ":memory:") return;
  const root = dirname(state.canonicalPath);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() ||
      realpathSync(root) !== root) {
    throw new Error("state database root changed during its lease");
  }
  const current = statSync(root);
  if (current.dev !== state.rootIdentity.dev || current.ino !== state.rootIdentity.ino) {
    throw new Error("state database root identity changed during its lease");
  }
};

const checkedTransaction = <T extends (...args: never[]) => unknown>(transaction: T, assertUsable: () => void): T => {
  const invoke = ((...args: never[]) => {
    assertUsable();
    return Reflect.apply(transaction, undefined, args);
  }) as T;
  const modes = invoke as unknown as Record<string, unknown>;
  for (const mode of ["default", "deferred", "immediate", "exclusive"] as const) {
    const candidate = (transaction as T & Record<string, unknown>)[mode];
    if (typeof candidate !== "function") continue;
    modes[mode] = (...args: never[]) => {
      assertUsable();
      return Reflect.apply(candidate, undefined, args);
    };
  }
  return invoke;
};

type RegisterFinalizer = (finalizer: () => void) => () => void;

const checkedIterator = <T>(
  iterator: Iterator<T>,
  assertUsable: () => void,
  registerFinalizer: RegisterFinalizer,
): Iterator<T> => {
  let finished = false;
  let unregister = () => {};
  const finish = (invokeReturn: boolean): void => {
    if (finished) return;
    finished = true;
    unregister();
    if (invokeReturn) iterator.return?.();
  };
  unregister = registerFinalizer(() => finish(true));
  return {
    next(...args: [] | [undefined]) {
      assertUsable();
      const result = iterator.next(...args);
      if (result.done) finish(false);
      return result;
    },
    return(value?: T) {
      assertUsable();
      if (finished) return { done: true, value };
      const result = iterator.return ? iterator.return(value) : { done: true as const, value };
      finish(false);
      return result;
    },
    throw(error?: unknown) {
      assertUsable();
      if (!iterator.throw) { finish(true); throw error; }
      const result = iterator.throw(error);
      if (result.done) finish(false);
      return result;
    },
  };
};

const checkedStatement = <T extends object>(
  statement: T,
  assertUsable: () => void,
  registerFinalizer: RegisterFinalizer,
  databaseView: () => Database.Database,
): T => {
  let view: T;
  const facade = Object.create(Object.getPrototypeOf(statement)) as T;
  view = new Proxy(facade, {
    get(_target, property) {
      assertUsable();
      const value = Reflect.get(statement, property, statement) as unknown;
      if (property === "database") return databaseView();
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertUsable();
        const result = Reflect.apply(value, statement, args) as unknown;
        if (result === statement) return view;
        if (property === "iterate" && typeof result === "object" && result !== null) {
          return checkedIterator(result as Iterator<unknown>, assertUsable, registerFinalizer);
        }
        return result;
      };
    },
  });
  return view;
};

const checkedDatabase = (
  database: Database.Database,
  assertUsable: () => void,
  registerFinalizer: RegisterFinalizer,
): Database.Database => {
  let view: Database.Database;
  const facade = Object.create(Object.getPrototypeOf(database)) as Database.Database;
  view = new Proxy(facade, {
    get(_target, property) {
      assertUsable();
      if (typeof property === "symbol") return undefined;
      const value = Reflect.get(database, property, database) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertUsable();
        if (property === "close") {
          throw new Error("state database handles must close through their issued lease");
        }
        const result = Reflect.apply(value, database, args) as unknown;
        if (result === database) return view;
        if (property === "prepare" && typeof result === "object" && result !== null) {
          return checkedStatement(result, assertUsable, registerFinalizer, () => view);
        }
        if (property === "transaction" && typeof result === "function") {
          return checkedTransaction(result as (...args: never[]) => unknown, assertUsable);
        }
        return result;
      };
    },
  }) as Database.Database;
  return view;
};

class IssuedStateDatabaseBorrow implements StateDatabaseAccess {
  #closed = false;
  readonly #view: Database.Database;
  readonly #finalizers = new Set<() => void>();
  readonly #state: LeaseState;
  constructor(state: LeaseState, token: symbol) {
    if (token !== issuanceToken) throw new Error("state database borrow construction is private");
    if (state.ownerClosed || state.released || !state.database.open) throw new Error("state database lease is not borrowable");
    this.#state = state;
    state.borrows += 1;
    this.#view = checkedDatabase(state.database, () => this.assertUsable(), (finalizer) => {
      this.#finalizers.add(finalizer);
      return () => this.#finalizers.delete(finalizer);
    });
    issuedStateDatabaseAccesses.add(this);
    Object.freeze(this);
  }
  get database(): Database.Database { this.assertUsable(); return this.#view; }
  get canonicalPath(): string { return this.#state.canonicalPath; }
  get generation(): string { return this.#state.generation; }
  assertUsable(): void {
    this.assertLive();
    assertCanonicalRootIdentity(this.#state);
    assertCanonicalDatabaseIdentity(this.#state);
  }
  private assertLive(): void {
    if (this.#closed || this.#state.released || !this.#state.database.open) throw new Error("state database borrow is closed or revoked");
  }
  borrow(): StateDatabaseAccess { this.assertUsable(); return new IssuedStateDatabaseBorrow(this.#state, issuanceToken); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { for (const finalize of [...this.#finalizers]) finalize(); }
    finally {
      this.#finalizers.clear();
      this.#state.borrows -= 1;
      releaseWhenUnused(this.#state);
    }
  }
}

class IssuedStateDatabaseLease implements StateDatabaseAccess {
  readonly #view: Database.Database;
  readonly #finalizers = new Set<() => void>();
  readonly #state: LeaseState;
  constructor(state: LeaseState, token: symbol) {
    if (token !== issuanceToken) throw new Error("state database lease construction is private");
    this.#state = state;
    this.#view = checkedDatabase(state.database, () => this.assertUsable(), (finalizer) => {
      this.#finalizers.add(finalizer);
      return () => this.#finalizers.delete(finalizer);
    });
    issuedStateDatabaseAccesses.add(this);
    Object.freeze(this);
  }
  get database(): Database.Database { this.assertUsable(); return this.#view; }
  get canonicalPath(): string { return this.#state.canonicalPath; }
  get generation(): string { return this.#state.generation; }
  assertUsable(): void {
    this.assertLive();
    assertCanonicalRootIdentity(this.#state);
    assertCanonicalDatabaseIdentity(this.#state);
  }
  private assertLive(): void {
    if (this.#state.ownerClosed || this.#state.released || !this.#state.database.open) throw new Error("state database owner lease is closed");
  }
  borrow(): StateDatabaseAccess { this.assertUsable(); return new IssuedStateDatabaseBorrow(this.#state, issuanceToken); }
  close(): void {
    if (this.#state.ownerClosed) return;
    this.#state.ownerClosed = true;
    try { for (const finalize of [...this.#finalizers]) finalize(); }
    finally {
      this.#finalizers.clear();
      releaseWhenUnused(this.#state);
    }
  }
}

export interface CanonicalStateDatabaseIdentity {
  path: string;
  root: string;
  databaseIdentity: { dev: number; ino: number };
  rootIdentity: { dev: number; ino: number };
}

export const canonicalStateDatabaseIdentity = (databasePath: string): CanonicalStateDatabaseIdentity => {
  const requested = resolve(databasePath);
  const requestedRoot = dirname(requested);
  if (realpathSync(requestedRoot) !== requestedRoot) throw new Error("state database root aliases are forbidden");
  const link = lstatSync(requested);
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) {
    throw new Error("state database must be a regular non-symlink file without hard-link aliases");
  }
  const path = realpathSync(requested);
  if (path !== requested) throw new Error("state database path aliases are forbidden");
  const identity = statSync(path);
  const rootIdentity = statSync(requestedRoot);
  return { path, root: requestedRoot, databaseIdentity: { dev: identity.dev, ino: identity.ino },
    rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino } };
};

export const assertCanonicalStateDatabaseIdentity = (identity: CanonicalStateDatabaseIdentity): void => {
  assertCanonicalRootIdentity({ canonicalPath: identity.path, rootIdentity: identity.rootIdentity });
  assertCanonicalDatabaseIdentity({ canonicalPath: identity.path, databaseIdentity: identity.databaseIdentity });
};

const admitOpen = (root: string, operationRoot: string, mode: StateDatabaseAdmissionMode): void => {
  if (mode === "offline_observation") {
    if (inspectStateV4OpenAdmission(root, operationRoot) === "restore_consumed") {
      throw new Error("state database cannot be observed while physical restore consumption is incomplete");
    }
    return;
  }
  const open = appendStateV4GuardEvent(root, "service_reopened", Date.now(), operationRoot);
  if (open === "restore_consumed") throw new Error("state database cannot reopen while physical restore consumption is incomplete");
  if (mode === "mutating_service") {
    const write = appendStateV4GuardEvent(root, "mutable_write_admitted", Date.now(), operationRoot);
    if (write === "restore_consumed") throw new Error("state database write admission raced consumed restore");
  }
};

export function openStateDatabaseLease(
  databasePath: string,
  mode: StateDatabaseAdmissionMode,
  options?: Database.Options,
  faultInjector?: (point: "after_root_fence" | "after_identity_recheck") => void,
): StateDatabaseAccess {
  if (databasePath === ":memory:") {
    const database = new Database(databasePath, options);
    return new IssuedStateDatabaseLease({ database, canonicalPath: databasePath, databaseIdentity: { dev: 0, ino: 0 },
      rootIdentity: { dev: 0, ino: 0 }, generation: randomUUID(), releaseRoot: () => {}, borrows: 0,
      ownerClosed: false, released: false }, issuanceToken);
  }
  const canonical = canonicalStateDatabaseIdentity(databasePath);
  const rootLease = acquireStateRootLease(canonical.root, "shared");
  try {
    faultInjector?.("after_root_fence");
    const current = statSync(canonical.path);
    if (current.dev !== canonical.databaseIdentity.dev || current.ino !== canonical.databaseIdentity.ino || current.nlink !== 1) {
      throw new Error("state database identity changed during admission");
    }
    faultInjector?.("after_identity_recheck");
    admitOpen(canonical.root, rootLease.pinnedRoot, mode);
    const pinnedDatabase = join(rootLease.pinnedRoot, basename(canonical.path));
    const pinnedIdentity = statSync(pinnedDatabase);
    if (pinnedIdentity.dev !== canonical.databaseIdentity.dev || pinnedIdentity.ino !== canonical.databaseIdentity.ino) {
      throw new Error("pinned state database identity changed during admission");
    }
    const database = new Database(pinnedDatabase, options);
    const state: LeaseState = { database, canonicalPath: canonical.path,
      databaseIdentity: canonical.databaseIdentity, rootIdentity: canonical.rootIdentity,
      generation: randomUUID(), releaseRoot: rootLease.release,
      borrows: 0, ownerClosed: false, released: false };
    try {
      rootLease.assertCurrent();
      assertCanonicalDatabaseIdentity(state);
    }
    catch (error) { database.close(); throw error; }
    return new IssuedStateDatabaseLease(state, issuanceToken);
  } catch (error) {
    rootLease.release();
    throw error;
  }
}

export function openStandaloneStateAccess(
  input: string | StateDatabaseAccess,
  mode: StateDatabaseAdmissionMode = "mutating_service",
): { access: StateDatabaseAccess; close: () => void } {
  if (typeof input === "string") {
    const lease = openStateDatabaseLease(input, mode);
    return { access: lease, close: () => lease.close() };
  }
  input.assertUsable();
  return { access: input, close: () => input.close() };
}

function memoryDatabaseAccess(database: Database.Database): StateDatabaseAccess {
  const descriptors = Object.getOwnPropertyDescriptors(database) as Record<string, PropertyDescriptor>;
  const actualName = descriptors.name?.get?.call(database) as unknown;
  const actualMemory = descriptors.memory?.get?.call(database) as unknown;
  const databases = Database.prototype.pragma.call(database, "database_list") as Array<{ name: string; file: string }>;
  if (actualName !== ":memory:" || actualMemory !== true ||
      databases.length !== 1 || databases[0]?.name !== "main" || databases[0].file !== "") {
    throw new Error("raw file-backed SQLite handles are unsupported; spoofed handles are unsupported");
  }
  const assertUsable = () => { if (!database.open) throw new Error("memory database is closed"); };
  const access: StateDatabaseAccess = Object.freeze({
    get database() { assertUsable(); return database; },
    canonicalPath: ":memory:" as const,
    generation: `memory:${randomUUID()}`,
    assertUsable,
    borrow: (): StateDatabaseAccess => access,
    close: () => {},
  }) satisfies StateDatabaseAccess;
  issuedStateDatabaseAccesses.add(access);
  return access;
}

export type StateStoreInput = string | StateDatabaseAccess | Database.Database;
export type StateDatabaseLease = StateDatabaseAccess;

export function openStateStoreAccess(input: StateStoreInput): {
  access: StateDatabaseAccess;
  close: () => void;
} {
  if (typeof input === "string") return openStandaloneStateAccess(input);
  if ("assertUsable" in input) {
    if (!issuedStateDatabaseAccesses.has(input)) {
      throw new Error("state database access capability was not issued by the state fence");
    }
    input.assertUsable();
    return { access: input, close: () => input.close() };
  }
  return { access: memoryDatabaseAccess(input), close: () => {} };
}
