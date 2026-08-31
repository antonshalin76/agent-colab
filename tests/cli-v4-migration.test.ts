import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve("scripts/agent-collab-launcher.mjs");
const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-cli-v4-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  roots.push(root);
  mkdirSync(bin);
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\nexit 3\n");
  chmodSync(systemctl, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_COLLAB_STATE_DIR: state };
  const run = (command: string) => spawnSync(process.execPath, [launcher, command], {
    cwd: resolve("."), encoding: "utf8", env, timeout: 30_000,
  });
  return { state, systemctl, run };
};

const statePath = (root: string) => join(root, "collaboration.db");

const version = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try { return Number(db.pragma("user_version", { simple: true })); } finally { db.close(); }
};

const schemaSnapshot = (path: string): unknown[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  } finally { db.close(); }
};

const removeAuthorityExtension = (path: string): void => {
  const db = new Database(path);
  try {
    const extensionTriggers = db.prepare(`SELECT name FROM sqlite_schema
      WHERE type='trigger' AND name NOT IN (
        'runtime_review_attempt_v2_insert',
        'runtime_review_attempt_v2_update',
        'runtime_review_barrier_v2_update'
      ) AND (name LIKE 'runtime_review_%' OR name LIKE 'runtime_provider_recovery_%')`)
      .pluck().all() as string[];
    db.transaction(() => {
      for (const trigger of extensionTriggers) db.exec(`DROP TRIGGER ${trigger}`);
      for (const table of [
        "runtime_review_no_spawn_effects",
        "runtime_review_spawn_authorities",
        "runtime_review_generation_consumptions",
        "runtime_review_attempt_authorities",
        "runtime_review_receipt_lifecycle",
        "runtime_review_receipt_heads",
        "runtime_review_receipts",
        "runtime_review_attempt_base_policies",
        "runtime_provider_recovery_generations",
        "runtime_schema_capabilities",
      ]) db.exec(`DROP TABLE ${table}`);
    })();
  } finally { db.close(); }
};

const downgradeEmptyFixtureToV3 = (path: string): void => {
  removeAuthorityExtension(path);
  const db = new Database(path);
  try {
    db.exec(`
      DROP TRIGGER runtime_review_attempt_v2_insert;
      DROP TRIGGER runtime_review_attempt_v2_update;
      DROP TRIGGER runtime_review_barrier_v2_update;
      ALTER TABLE runtime_review_barriers DROP COLUMN launch_authority_version;
      PRAGMA user_version = 3;
    `);
  } finally { db.close(); }
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI v4 startup and offline authority extension", () => {
  it("creates and reopens a fresh complete v4/v2 pair without changing schema markers", () => {
    const fx = fixture();
    const created = fx.run("status");
    expect(created.status, created.stderr).toBe(0);
    expect(version(statePath(fx.state))).toBe(4);
    expect(version(join(fx.state, "history.db"))).toBe(2);
    const before = schemaSnapshot(statePath(fx.state));

    const reopened = fx.run("status");
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(version(statePath(fx.state))).toBe(4);
    expect(version(join(fx.state, "history.db"))).toBe(2);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it("fails closed without online repair when an existing v4 lacks authority ownership", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    removeAuthorityExtension(statePath(fx.state));
    const before = schemaSnapshot(statePath(fx.state));

    const rejected = fx.run("status");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/offline|repair|capability|schema/i);
    expect(version(statePath(fx.state))).toBe(4);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it("extends an existing v4 only through the stopped-service command and preserves user_version", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    removeAuthorityExtension(statePath(fx.state));

    const extended = fx.run("extend-review-v3-schema");
    expect(extended.status, extended.stderr).toBe(0);
    expect(JSON.parse(extended.stdout)).toMatchObject({ status: "extended", stateVersion: 4 });
    expect(version(statePath(fx.state))).toBe(4);

    const reopened = fx.run("status");
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(version(statePath(fx.state))).toBe(4);
  });

  it("does not extend an existing v4 while the managed service is active", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    removeAuthorityExtension(statePath(fx.state));
    const before = schemaSnapshot(statePath(fx.state));
    writeFileSync(fx.systemctl, "#!/bin/sh\nprintf 'active\\n'\nexit 0\n");
    chmodSync(fx.systemctl, 0o755);

    const rejected = fx.run("extend-review-v3-schema");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/must be confirmed inactive/i);
    expect(version(statePath(fx.state))).toBe(4);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it("keeps migrate-v4 idempotent after the authority extension is present", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const before = schemaSnapshot(statePath(fx.state));

    const migrated = fx.run("migrate-v4");
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(JSON.parse(migrated.stdout)).toEqual({ status: "already_current", fromVersion: 4, toVersion: 4 });
    expect(version(statePath(fx.state))).toBe(4);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it("migrates v3 to v4 and installs the authority extension in the same stopped-service operation", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    downgradeEmptyFixtureToV3(statePath(fx.state));

    const migrated = fx.run("migrate-v4");
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(JSON.parse(migrated.stdout)).toEqual({ status: "migrated", fromVersion: 3, toVersion: 4 });
    expect(version(statePath(fx.state))).toBe(4);
    expect(fx.run("status").status).toBe(0);
  });
});
