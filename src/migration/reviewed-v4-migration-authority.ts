import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../domain/canonical-json.js";
import {
  assertCanonicalStateDatabaseIdentity,
  canonicalStateDatabaseIdentity,
} from "../store/state-database-fence.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import { StateFileDurability } from "../store/state-file-durability.js";
import {
  legacyTableManifestSha256,
  observeLegacyDatabase,
  parseLegacyTableManifest,
  type LegacyDatabaseObservation,
} from "./state-v4-manifest.js";
import {
  exactMigrationAuthorityBinding as exactBinding,
  migrationAuthorityBindingSchema as migrationBindingSchema,
  parseReviewedV4MigrationCompletion as parseCompletion,
  type DurableMigrationCompletion as DurableCompletion,
  type MigrationAuthorityBinding,
} from "./reviewed-v4-migration-records.js";

export type { MigrationAuthorityBinding } from "./reviewed-v4-migration-records.js";

declare const migrationAuthorityBrand: unique symbol;
export interface MigrationAuthorityCapability { readonly [migrationAuthorityBrand]: true }

export interface MigrationAuthorityClaim {
  readonly preState: LegacyDatabaseObservation;
  readonly preHistory: LegacyDatabaseObservation;
  readonly alreadyCompleted: boolean;
  readonly completedReceipt: Readonly<Record<string, unknown>> | null;
  assertCurrent(): void;
  complete(receipt: Readonly<Record<string, unknown>>): void;
  abort(): void;
}

export interface MigrationAuthorityConsumerPort {
  claim(capability: MigrationAuthorityCapability | undefined, binding: MigrationAuthorityBinding): MigrationAuthorityClaim;
}

export interface MigrationAuthorityInspection {
  readonly authorization: "absent" | "valid" | "invalid";
  readonly completion: "absent" | "valid" | "invalid";
  readonly preState?: LegacyDatabaseObservation;
  readonly preHistory?: LegacyDatabaseObservation;
  readonly completedReceipt?: Readonly<Record<string, unknown>>;
}

interface DurableAuthorization {
  readonly schemaVersion: "reviewed-v4-migration-authorization/v2";
  readonly binding: MigrationAuthorityBinding;
  readonly rootIdentity: { readonly dev: number; readonly ino: number };
  readonly stateIdentity: { readonly dev: number; readonly ino: number };
  readonly historyIdentity: { readonly dev: number; readonly ino: number };
  readonly preState: LegacyDatabaseObservation;
  readonly preHistory: LegacyDatabaseObservation;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fileIdentitySchema = z.object({ dev: safeInteger, ino: safeInteger }).strict();
const legacyManifestSchema = z.object({
  schemaVersion: z.literal("legacy-table-digest-manifest/v1"),
  tables: z.array(z.object({
    name: z.string().min(1),
    columns: z.array(z.string().min(1)),
    rowCount: safeInteger,
    rowsSha256: z.string().regex(SHA256),
  }).strict()),
}).strict().superRefine((manifest, context) => {
  try { parseLegacyTableManifest(`${canonicalJson(manifest)}\n`); }
  catch { context.addIssue({ code: "custom", message: "legacy manifest is invalid" }); }
});
const legacyObservationSchema = (userVersion: 2 | 3) => z.object({
  userVersion: z.literal(userVersion),
  bytesSha256: z.string().regex(SHA256),
  manifest: legacyManifestSchema,
  manifestSha256: z.string().regex(SHA256),
}).strict().superRefine((observation, context) => {
  if (legacyTableManifestSha256(observation.manifest) !== observation.manifestSha256) {
    context.addIssue({ code: "custom", message: "legacy manifest digest is invalid" });
  }
});

export const reviewedV4MigrationAuthorityArtifactPaths = (
  operationId: string,
): { readonly authorization: string; readonly completion: string } => {
  if (!OPERATION_ID.test(operationId)) throw new Error("migration operation id is invalid");
  return Object.freeze({
    authorization: `migration-v4/authority/${operationId}.authorization.json`,
    completion: `migration-v4/authority/${operationId}.completion.json`,
  });
};
const durableAuthorizationSchema = z.object({
  schemaVersion: z.literal("reviewed-v4-migration-authorization/v2"),
  binding: migrationBindingSchema,
  rootIdentity: fileIdentitySchema,
  stateIdentity: fileIdentitySchema,
  historyIdentity: fileIdentitySchema,
  preState: legacyObservationSchema(3),
  preHistory: legacyObservationSchema(2),
}).strict();

function observeAuthorization(binding: MigrationAuthorityBinding): DurableAuthorization {
  if (!OPERATION_ID.test(binding.operationId) || binding.consumer !== "codex:/root:state-v4-reviewed-bootstrap" ||
      binding.scope !== "reviewed-state-v4-migration" ||
      !migrationBindingSchema.safeParse(binding).success) {
    throw new Error("migration authority binding is outside the reviewed source scope");
  }
  const root = dirname(resolve(binding.stateDatabase));
  const layout = openExistingStateLayout(root);
  if (binding.stateDatabase !== layout.database || binding.historyDatabase !== layout.historyDatabase) {
    throw new Error("migration authority requires the canonical state/history database pair");
  }
  const state = canonicalStateDatabaseIdentity(binding.stateDatabase);
  const history = canonicalStateDatabaseIdentity(binding.historyDatabase);
  if (state.root !== history.root) throw new Error("migration authority database roots differ");
  const rootStat = statSync(state.root);
  if (binding.targetIdentity.root.path !== state.root || binding.targetIdentity.root.dev !== rootStat.dev ||
      binding.targetIdentity.root.ino !== rootStat.ino || binding.targetIdentity.state.path !== state.path ||
      binding.targetIdentity.state.dev !== state.databaseIdentity.dev ||
      binding.targetIdentity.state.ino !== state.databaseIdentity.ino ||
      binding.targetIdentity.history.path !== history.path ||
      binding.targetIdentity.history.dev !== history.databaseIdentity.dev ||
      binding.targetIdentity.history.ino !== history.databaseIdentity.ino) {
    throw new Error("migration authority adoption target identity does not match the canonical database pair");
  }
  const preState = observeLegacyDatabase(state.path, "state");
  const preHistory = observeLegacyDatabase(history.path, "history");
  if (preState.userVersion !== 3 || preHistory.userVersion !== 2) {
    throw new Error("migration authority may only be issued against the exact pre-v4 database pair");
  }
  if (binding.targetIdentity.state.userVersion !== preState.userVersion ||
      binding.targetIdentity.state.bytesSha256 !== preState.bytesSha256 ||
      binding.targetIdentity.state.manifestSha256 !== preState.manifestSha256 ||
      binding.targetIdentity.history.userVersion !== preHistory.userVersion ||
      binding.targetIdentity.history.bytesSha256 !== preHistory.bytesSha256 ||
      binding.targetIdentity.history.manifestSha256 !== preHistory.manifestSha256) {
    throw new Error("migration authority database contents differ from the adopted target generation");
  }
  return {
    schemaVersion: "reviewed-v4-migration-authorization/v2",
    binding: structuredClone(binding),
    rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    stateIdentity: structuredClone(state.databaseIdentity),
    historyIdentity: structuredClone(history.databaseIdentity),
    preState,
    preHistory,
  };
}

function parseAuthorization(bytes: Buffer): DurableAuthorization {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("durable migration authority record is malformed", { cause: error }); }
  const result = durableAuthorizationSchema.safeParse(parsed);
  if (!result.success || !bytes.equals(Buffer.from(`${canonicalJson(parsed)}\n`))) {
    throw new Error("durable migration authority record is invalid or noncanonical");
  }
  return result.data as DurableAuthorization;
}

export function createReviewedV4MigrationAuthority(input: { readonly stateRoot: string }): {
  readonly issuer: { issue(binding: MigrationAuthorityBinding): MigrationAuthorityCapability };
  readonly consumer: MigrationAuthorityConsumerPort;
  readonly inspect: (binding: MigrationAuthorityBinding) => MigrationAuthorityInspection;
  close(): void;
} {
  const durability = new StateFileDurability({ stateRoot: input.stateRoot });
  const capabilities = new WeakMap<object, DurableAuthorization>();
  const lockPathFor = (operationId: string): string =>
    resolve(input.stateRoot, "migration-v4", "authority", `${operationId}.lock`);
  const openOperationLock = (operationId: string, create: boolean): number => {
    const descriptor = openSync(
      lockPathFor(operationId),
      constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
      0o600,
    );
    try {
      const descriptorStat = fstatSync(descriptor);
      const pathStat = lstatSync(lockPathFor(operationId));
      if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 ||
          descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
        throw new Error("migration authority lock identity is invalid");
      }
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  };
  const acquireOperationLock = (operationId: string): (() => void) => {
    const descriptor = openOperationLock(operationId, false);
    try {
      const locked = spawnSync("/usr/bin/flock", ["-n", "-x", "3"], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe", descriptor],
      });
      if (locked.error || locked.status !== 0) {
        throw new Error("migration operation already has a concurrent active claim");
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        closeSync(descriptor);
      };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  };
  const pathFor = (operationId: string, suffix: "authorization" | "completion"): string =>
    reviewedV4MigrationAuthorityArtifactPaths(operationId)[suffix];

  const issuer = Object.freeze({
    issue(binding: MigrationAuthorityBinding): MigrationAuthorityCapability {
      if (!OPERATION_ID.test(binding.operationId)) throw new Error("migration operation id is invalid");
      const path = pathFor(binding.operationId, "authorization");
      let authorization: DurableAuthorization;
      try {
        const pinned = durability.openPinned(path);
        try { authorization = parseAuthorization(pinned.read()); }
        finally { pinned.close(); }
        if (!exactBinding(authorization.binding, binding)) {
          throw new Error("migration operation identity was already bound to another authority");
        }
      } catch (error) {
        if (!(error instanceof Error) || !/does not exist|cannot be opened|parent directory/i.test(error.message)) throw error;
        authorization = observeAuthorization(binding);
        const published = durability.publishImmutable({
          relativePath: path,
          bytes: Buffer.from(`${canonicalJson(authorization)}\n`),
        });
        try {
          const persisted = parseAuthorization(published.file.read());
          if (!exactBinding(persisted.binding, binding)) throw new Error("durable migration authority publication raced");
          authorization = persisted;
        } finally { published.file.close(); }
      }
      const lockDescriptor = openOperationLock(binding.operationId, true);
      closeSync(lockDescriptor);
      const token = Object.freeze({}) as MigrationAuthorityCapability;
      capabilities.set(token, authorization);
      return token;
    },
  });

  const consumer: MigrationAuthorityConsumerPort = Object.freeze({
    claim(capability: MigrationAuthorityCapability | undefined, binding: MigrationAuthorityBinding) {
      const authorization = capability ? capabilities.get(capability as object) : undefined;
      if (!authorization || !exactBinding(authorization.binding, binding)) {
        throw new Error("issued durable migration authority capability is required for the exact operation");
      }
      const releaseOperationLock = acquireOperationLock(binding.operationId);
      let ownsOperationLock = true;
      const releaseLock = (): void => {
        if (!ownsOperationLock) return;
        ownsOperationLock = false;
        releaseOperationLock();
      };
      try {
      const assertCurrent = (): void => {
        const state = canonicalStateDatabaseIdentity(binding.stateDatabase);
        const history = canonicalStateDatabaseIdentity(binding.historyDatabase);
        assertCanonicalStateDatabaseIdentity(state);
        assertCanonicalStateDatabaseIdentity(history);
        const rootStat = statSync(state.root);
        if (rootStat.dev !== authorization.rootIdentity.dev || rootStat.ino !== authorization.rootIdentity.ino ||
            state.databaseIdentity.dev !== authorization.stateIdentity.dev || state.databaseIdentity.ino !== authorization.stateIdentity.ino ||
            history.databaseIdentity.dev !== authorization.historyIdentity.dev || history.databaseIdentity.ino !== authorization.historyIdentity.ino) {
          throw new Error("migration authority database or canonical root identity drifted");
        }
        const currentState = observeLegacyDatabase(state.path, "state");
        if (currentState.userVersion === 3 &&
            (currentState.bytesSha256 !== authorization.preState.bytesSha256 ||
             currentState.manifestSha256 !== authorization.preState.manifestSha256)) {
          throw new Error("migration authority state bytes or manifest drifted after issuance");
        }
        if (currentState.userVersion !== 3 && currentState.userVersion !== 4) {
          throw new Error("migration authority state schema version drifted");
        }
        const currentHistory = observeLegacyDatabase(history.path, "history", authorization.preHistory.manifest);
        if (currentHistory.bytesSha256 !== authorization.preHistory.bytesSha256 ||
            currentHistory.manifestSha256 !== authorization.preHistory.manifestSha256) {
          throw new Error("migration authority history digest drifted");
        }
      };
      assertCurrent();
      const completionPath = pathFor(binding.operationId, "completion");
      let persistedCompletion: DurableCompletion | undefined;
      try {
        const completed = durability.openPinned(completionPath);
        try { persistedCompletion = parseCompletion(completed.read(), binding); }
        finally { completed.close(); }
      } catch (error) {
        if (!(error instanceof Error) || !/does not exist|cannot be opened|parent directory/i.test(error.message)) throw error;
      }
      const alreadyCompleted = persistedCompletion !== undefined;
      let settled = false;
      return Object.freeze({
        preState: authorization.preState,
        preHistory: authorization.preHistory,
        alreadyCompleted,
        completedReceipt: persistedCompletion === undefined
          ? null
          : Object.freeze(structuredClone(persistedCompletion.receipt)),
        assertCurrent() {
          if (settled) throw new Error("migration authority claim is no longer active");
          assertCurrent();
        },
        complete(receipt: Readonly<Record<string, unknown>>) {
          if (settled) throw new Error("migration authority claim is no longer active");
          if (alreadyCompleted) {
            if (canonicalJson(persistedCompletion!.receipt) !== canonicalJson(receipt)) {
              throw new Error("migration completion replay conflicts with the persisted exact receipt");
            }
            settled = true;
            releaseLock();
            return;
          }
          const bytes = Buffer.from(`${canonicalJson({
            schemaVersion: "reviewed-v4-migration-completion/v2",
            operationId: binding.operationId,
            binding,
            receipt,
          })}\n`);
          const published = durability.publishImmutable({ relativePath: completionPath, bytes });
          try {
            if (!published.file.read().equals(bytes)) throw new Error("migration completion replay conflicts with durable authority");
          } finally { published.file.close(); }
          settled = true;
          releaseLock();
        },
        abort() {
          if (settled) return;
          settled = true;
          releaseLock();
        },
      });
      } catch (error) {
        releaseLock();
        throw error;
      }
    },
  });
  const inspect = (binding: MigrationAuthorityBinding): MigrationAuthorityInspection => {
    if (!migrationBindingSchema.safeParse(binding).success) {
      return { authorization: "invalid", completion: "invalid" };
    }
    const read = <T>(relativePath: string, parse: (bytes: Buffer) => T):
      { readonly status: "absent" | "invalid"; readonly value?: never } |
      { readonly status: "valid"; readonly value: T } => {
      if (!existsSync(resolve(input.stateRoot, relativePath))) return { status: "absent" };
      try {
        const pinned = durability.openPinned(relativePath);
        let value: T;
        try { value = parse(pinned.read()); }
        finally { pinned.close(); }
        return { status: "valid", value };
      } catch {
        return { status: "invalid" };
      }
    };
    const authorizationRecord = read(pathFor(binding.operationId, "authorization"), (bytes) => {
      const persisted = parseAuthorization(bytes);
      if (!exactBinding(persisted.binding, binding)) throw new Error("migration authorization binding mismatch");
      return persisted;
    });
    if (authorizationRecord.status !== "valid") {
      return { authorization: authorizationRecord.status, completion: "absent" };
    }
    const completionRecord = read(
      pathFor(binding.operationId, "completion"),
      (bytes) => parseCompletion(bytes, binding),
    );
    return {
      authorization: "valid",
      completion: completionRecord.status,
      preState: authorizationRecord.value.preState,
      preHistory: authorizationRecord.value.preHistory,
      ...(completionRecord.status === "valid"
        ? { completedReceipt: Object.freeze(structuredClone(completionRecord.value.receipt)) }
        : {}),
    };
  };
  return Object.freeze({ issuer, consumer, inspect, close: () => durability.close() });
}
