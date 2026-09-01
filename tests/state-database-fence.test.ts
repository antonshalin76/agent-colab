import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabaseLease, openStateStoreAccess } from "../src/store/state-database-fence.js";
import * as stateFenceModule from "../src/store/state-database-fence.js";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { FlowEvidenceLedger } from "../src/flow/evidence-ledger.js";
import { ConfiguredMapControlPlane } from "../src/flow/map-admin.js";
import { LocalCollabService } from "../src/app/service.js";
import { initializeCurrentExecutionSchema, MigrationCoordinator } from "../src/migration/coordinator.js";

const roots: string[] = [];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const stateDatabase = (): { root: string; path: string } => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-state-fence-"));
  roots.push(root);
  const path = join(root, "collaboration.db");
  const db = new Database(path);
  db.exec("CREATE TABLE marker(id TEXT PRIMARY KEY); INSERT INTO marker VALUES ('initial')");
  db.close();
  return { root, path };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("state database lifetime fence", () => {
  it("B1 observes state without creating migration artifacts or changing SQLite bytes", () => {
    const { root, path } = stateDatabase();
    const before = sha256(path);
    const lease = openStateDatabaseLease(path, "offline_observation", { readonly: true });
    expect(lease.database.prepare("SELECT id FROM marker").pluck().all()).toEqual(["initial"]);
    expect(existsSync(join(root, "migration-v4"))).toBe(false);
    expect(existsSync(join(root, "migration-guard"))).toBe(false);
    expect(["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${path}${suffix}`))).toBe(false);
    lease.close();
    expect(sha256(path)).toBe(before);
  });

  it("B2 holds a cross-process root flock until the last live borrow closes", () => {
    const { root, path } = stateDatabase();
    const owner = openStateDatabaseLease(path, "mutating_service");
    const child = owner.borrow();
    owner.close();
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).not.toBe(0);
    child.database.prepare("INSERT INTO marker VALUES (?)").run("child-commit");
    child.close();
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
    const verify = new Database(path, { readonly: true });
    expect(verify.prepare("SELECT id FROM marker ORDER BY id").pluck().all()).toEqual(["child-commit", "initial"]);
    verify.close();
  });

  it("B9 revokes a closed child without releasing a sibling's root lease", () => {
    const { root, path } = stateDatabase();
    const owner = openStateDatabaseLease(path, "mutating_service");
    const first = owner.borrow();
    const second = owner.borrow();
    const firstView = first.database;
    owner.close();
    first.close();
    expect(() => firstView.prepare("SELECT 1").get()).toThrow(/borrow is closed or revoked/i);
    expect(second.database.prepare("SELECT id FROM marker").pluck().all()).toEqual(["initial"]);
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).not.toBe(0);
    second.close();
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
  });

  it("B9 revokes cached statement chains and iterators while the owner remains live", () => {
    const { root, path } = stateDatabase();
    const owner = openStateDatabaseLease(path, "mutating_service");
    const child = owner.borrow();
    const mutation = child.database.prepare("INSERT INTO marker VALUES (?)").bind("escaped");
    const iterator = child.database.prepare("SELECT id FROM marker ORDER BY id").iterate();
    child.close();
    expect(() => mutation.run()).toThrow(/borrow is closed or revoked/i);
    expect(() => iterator.next()).toThrow(/borrow is closed or revoked/i);
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).not.toBe(0);
    expect(owner.database.prepare("SELECT id FROM marker").pluck().all()).toEqual(["initial"]);
    owner.close();
  });

  it("B9 never exposes raw SQLite authority through statements or fluent database methods", () => {
    const { path } = stateDatabase();
    const owner = openStateDatabaseLease(path, "mutating_service");
    const child = owner.borrow();
    const statementDatabase = child.database.prepare("SELECT 1").database;
    const fluentDatabase = child.database.exec("SELECT 1");
    expect(statementDatabase).toBe(child.database);
    expect(fluentDatabase).toBe(child.database);
    expect(() => child.database.close()).toThrow(/must close through their issued lease/i);
    const rawMemory = new Database(":memory:");
    const privateSymbol = Reflect.ownKeys(rawMemory).find((key) => typeof key === "symbol");
    expect(privateSymbol).toBeDefined();
    expect(Reflect.ownKeys(child.database).filter((key) => typeof key === "symbol")).toEqual([]);
    expect((child.database as unknown as Record<symbol, unknown>)[privateSymbol as symbol]).toBeUndefined();
    rawMemory.close();
    child.close();
    expect(() => statementDatabase.prepare("SELECT 1").get()).toThrow(/borrow is closed or revoked/i);
    expect(() => fluentDatabase.prepare("SELECT 1").get()).toThrow(/borrow is closed or revoked/i);
    owner.close();
  });

  it("B3b rejects a structurally forged wrapper around a raw file database", () => {
    const { path } = stateDatabase();
    const raw = new Database(path);
    const forged = {
      database: raw,
      canonicalPath: path,
      generation: "forged",
      assertUsable: () => {},
      borrow() { return this; },
      close: () => {},
    };
    expect(() => openStateStoreAccess(forged)).toThrow(/not issued by the state fence/i);
    raw.close();
  });

  it("B3b exposes no constructible lease classes and rejects a proxy-spoofed file database", () => {
    expect("StateDatabaseLease" in stateFenceModule).toBe(false);
    expect("StateDatabaseBorrow" in stateFenceModule).toBe(false);
    const { path } = stateDatabase();
    const raw = new Database(path);
    const spoofed = new Proxy(raw, {
      get(target, property, receiver) {
        if (property === "name") return ":memory:";
        if (property === "memory") return true;
        if (property === "pragma") return () => [{ seq: 0, name: "main", file: "" }];
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => openStateStoreAccess(spoofed)).toThrow(/spoofed handles/i);
    raw.close();
  });

  it("B8 revokes the lease when the root path is replaced around the same database inode", () => {
    const { root, path } = stateDatabase();
    const lease = openStateDatabaseLease(path, "mutating_service");
    const cached = lease.database;
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    renameSync(root, displaced);
    mkdirSync(root, { mode: 0o700 });
    renameSync(join(displaced, "collaboration.db"), path);
    expect(() => cached.prepare("SELECT 1").get()).toThrow(/root identity changed/i);
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
    lease.close();
  });

  it("B3b releases every acquired root lease when a composite constructor fails", () => {
    const cases: Array<(path: string, root: string) => unknown> = [
      (path) => new CollaborationRuntime(path),
      (path) => new FlowEvidenceLedger(path, { claimLeaseMs: 0 }),
      (path, root) => new ConfiguredMapControlPlane(path, { controlRoot: join(root, "missing") }),
      (path) => new LocalCollabService(path, { historyDatabase: ":memory:" }),
    ];
    for (const construct of cases) {
      const { root, path } = stateDatabase();
      expect(() => construct(path, root)).toThrow();
      expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
    }
  });

  it("B3b closes a successful file-backed MAP control plane through capabilities", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-state-map-close-"));
    roots.push(root);
    const path = join(root, "collaboration.db");
    initializeCurrentExecutionSchema(path);
    const control = new ConfiguredMapControlPlane(path, { controlRoot: process.cwd() });
    expect(() => control.close()).not.toThrow();
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
  });

  it("B3b releases an unreturned child borrow when persisted collaboration JSON is corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-state-fence-corrupt-"));
    roots.push(root);
    const path = join(root, "collaboration.db");
    initializeCurrentExecutionSchema(path);
    const raw = new Database(path);
    raw.prepare(`INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at)
      VALUES ('corrupt','{',1,1)`).run();
    raw.close();
    expect(() => new CollaborationRuntime(path)).toThrow(/JSON|Unexpected|position/i);
    expect(spawnSync("flock", ["-n", "-x", root, "true"]).status).toBe(0);
  });

  it("B5 rejects a hard-linked state alias before an exclusive coordinator can lock it", () => {
    const { root, path } = stateDatabase();
    const history = join(root, "history.db");
    const historyDb = new Database(history);
    historyDb.close();
    const alias = join(root, "state-alias.db");
    linkSync(path, alias);
    expect(() => new MigrationCoordinator({ stateDatabase: alias, historyDatabase: history }))
      .toThrow(/hard-link aliases/i);
  });

  it("B8 rejects pathname replacement before a leased store can mutate the replacement", () => {
    const original = stateDatabase();
    const foreign = stateDatabase();
    const lease = openStateDatabaseLease(original.path, "mutating_service");
    renameSync(foreign.path, original.path);
    expect(() => lease.database).toThrow(/identity changed during its lease/i);
    lease.close();
    const verify = new Database(original.path, { readonly: true });
    expect(verify.prepare("SELECT id FROM marker").pluck().all()).toEqual(["initial"]);
    verify.close();
  });

  it("B3a pins admission and SQLite open to the locked root generation", () => {
    const { root, path } = stateDatabase();
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    let replacementHash = "";
    expect(() => openStateDatabaseLease(path, "mutating_service", undefined, (point) => {
      if (point !== "after_identity_recheck") return;
      renameSync(root, displaced);
      mkdirSync(root, { mode: 0o700 });
      const replacement = new Database(path);
      replacement.exec("CREATE TABLE replacement(value TEXT)");
      replacement.close();
      replacementHash = sha256(path);
    })).toThrow(/state root identity changed while its fence was held/i);
    expect(sha256(path)).toBe(replacementHash);
    const replacement = new Database(path, { readonly: true });
    expect(replacement.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all())
      .toEqual(["replacement"]);
    replacement.close();
  });

  it("B6 creates a fresh schema only below the exclusively pinned root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-state-init-fence-"));
    roots.push(root);
    const path = join(root, "collaboration.db");
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    expect(() => initializeCurrentExecutionSchema(path, { faultInjector: (point) => {
      if (point !== "after_state_root_fence") return;
      renameSync(root, displaced);
      mkdirSync(root, { mode: 0o700 });
    } })).toThrow(/state root identity changed while its fence was held/i);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(displaced, "collaboration.db"))).toBe(true);
  });
});
