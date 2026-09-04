import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dropGraphV4Schema } from "./helpers/graph-schema.js";
import {
  createTestReviewedV4Promotion,
  removeTestReviewedV4RemoteRef,
} from "./helpers/reviewed-v4-source-acceptance-fixture.js";

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
  const harness = join(bin, "review-harness");
  writeFileSync(harness, "#!/bin/sh\nprintf 'review-harness 1.0.0\\n'\n");
  chmodSync(harness, 0o755);
  const skill = join(root, ".agents", "skills", "agent-collaboration");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Agent collaboration\n");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AGENT_COLLAB_STATE_DIR: state,
    AGENT_COLLAB_GROK_BIN: harness,
    AGENT_COLLAB_CLAUDE_BIN: harness,
    AGENT_COLLAB_CODEX_BIN: harness,
  };
  const run = (command: string) => spawnSync(process.execPath, [launcher, command], {
    cwd: resolve("."), encoding: "utf8", env, timeout: 30_000,
  });
  const runWith = (command: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [launcher, command, ...args], {
      cwd: resolve("."), encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 120_000,
    });
  const start = (command: string) => spawn(process.execPath, [launcher, command], {
    cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  const initialize = () => {
    const linked = run("review-skills-link");
    if (linked.status !== 0) throw new Error(linked.stderr);
    const initialized = run("review-initialize");
    if (initialized.status !== 0) throw new Error(initialized.stderr);
  };
  return { root, state, systemctl, run, runWith, start, initialize };
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

const durableTreeSnapshot = (root: string): Array<{ path: string; sha256: string }> => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.endsWith("-shm") || entry.name.endsWith("-wal")) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort().map((path) => ({
    path: relative(root, path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
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
  dropGraphV4Schema(path);
  const db = new Database(path);
  try {
    db.exec(`
      DROP TRIGGER runtime_review_attempt_v2_insert;
      DROP TRIGGER runtime_review_attempt_v2_update;
      DROP TRIGGER runtime_review_barrier_v2_update;
      ALTER TABLE runtime_review_barriers DROP COLUMN launch_authority_version;
      PRAGMA user_version = 3;
    `);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.exec("VACUUM");
  } finally { db.close(); }
};

const stabilizeDatabaseFile = (path: string): void => {
  const db = new Database(path);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.exec("VACUUM");
  } finally { db.close(); }
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(removeTestReviewedV4RemoteRef);

describe("CLI v4 startup and offline authority extension", () => {
  it.each([
    "worker",
    "mcp",
    "review-mcp",
    "mcp-verify-session",
    "start-normal",
    "prove-normal",
    "verify-unit",
    "compatibility-runtime",
    "migrate-v4",
    "extend-review-v3-schema",
  ])("permanently rejects %s before creating the state root", (command) => {
    const fx = fixture();

    const rejected = fx.run(command);

    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}\n${rejected.stderr}`).toMatch(/permanently quarantined/i);
    expect(existsSync(fx.state)).toBe(false);
  });

  it.each(["index", "approve"])("removes obsolete command %s before creating the state root", (command) => {
    const fx = fixture();

    const rejected = fx.run(command);

    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}\n${rejected.stderr}`).toMatch(/unknown command/i);
    expect(existsSync(fx.state)).toBe(false);
  });

  it("contains no executable legacy runtime composition", () => {
    const source = readFileSync("src/cli.ts", "utf8");
    for (const forbidden of [
      "LocalCollabService",
      "startStdioCollabServer",
      "CollaborationRuntime",
      "RunGateUnitOfWork",
      "WorktreeLeaseStore",
      "workflowDispatchIdentity",
      "workflow_reconciliation_block",
    ]) expect(source).not.toContain(forbidden);
    expect(source).not.toMatch(/command === ["'](?:mcp|worker|review-mcp)["']/u);
  });

  it("requires explicit readiness-gated initialization and reopens a complete v4/v2 pair read-only", () => {
    const fx = fixture();
    const absent = fx.run("status");
    expect(absent.status).not.toBe(0);
    expect(existsSync(fx.state)).toBe(false);
    fx.initialize();
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
    fx.initialize();
    removeAuthorityExtension(statePath(fx.state));
    const before = schemaSnapshot(statePath(fx.state));

    const rejected = fx.run("status");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/offline|repair|capability|schema/i);
    expect(version(statePath(fx.state))).toBe(4);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it.each(["extend-review-v3-schema", "migrate-v4", "compatibility-runtime"])(
    "permanently rejects legacy mutator/runtime command %s without changing state",
    (command) => {
    const fx = fixture();
    fx.initialize();
    const before = schemaSnapshot(statePath(fx.state));
    const rejected = fx.run(command);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/permanently quarantined/i);
    expect(schemaSnapshot(statePath(fx.state))).toEqual(before);
  });

  it("wires signed source adoption, preflight, prepare, and read-only close status end to end", () => {
    const fx = fixture();
    fx.initialize();
    downgradeEmptyFixtureToV3(statePath(fx.state));
    stabilizeDatabaseFile(join(fx.state, "history.db"));
    const packet = createTestReviewedV4Promotion();
    const publicKey = join(fx.root, "reviewed-source-public.pem");
    writeFileSync(publicKey, packet.trust.publicKeyPem, { mode: 0o600 });
    const trustEnv = {
      AGENT_COLLAB_REVIEWED_SOURCE_PUBLIC_KEY_FILE: publicKey,
      AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_URL: packet.trust.remote.url,
      AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_REF: packet.trust.remote.ref,
    };
    try {
      const adopted = fx.runWith("reviewed-source-adopt", [packet.promotionPath], trustEnv);
      expect(adopted.status, adopted.stderr).toBe(0);
      const adoptionSha = (JSON.parse(adopted.stdout) as { receiptSha256: string }).receiptSha256;

      const preflight = fx.runWith("stg04-close-preflight", [adoptionSha], trustEnv);
      expect(preflight.status, preflight.stderr).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({ ready: true, state: { phase: "PRE_V4" } });

      const prepared = fx.runWith("stg04-close-prepare", [adoptionSha], trustEnv);
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(JSON.parse(prepared.stdout)).toMatchObject({ phase: "PROJECTION_CURRENT" });

      const beforeStatus = durableTreeSnapshot(fx.state);
      const status = fx.runWith("stg04-close-status", [adoptionSha], trustEnv);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        ready: true,
        state: { phase: "PROJECTION_CURRENT", contradictionCodes: [] },
      });
      expect(durableTreeSnapshot(fx.state)).toEqual(beforeStatus);
    } finally {
      rmSync(packet.directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("drains the production review-worker command on SIGTERM", async () => {
    const fx = fixture();
    fx.initialize();
    const child = fx.start("review-worker");
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    try {
      await new Promise<void>((resolveStarted, rejectStarted) => {
        const timeout = setTimeout(() => rejectStarted(new Error("review worker did not start")), 10_000);
        const observe = () => {
          if (!stderr.includes('"event":"review_worker_started"')) return;
          clearTimeout(timeout);
          child.stderr!.off("data", observe);
          resolveStarted();
        };
        child.stderr!.on("data", observe);
        observe();
      });
      child.kill("SIGTERM");
      let exitTimeout: ReturnType<typeof setTimeout> | undefined;
      const [code, signal] = await Promise.race([
        once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
        new Promise<never>((_resolve, reject) => {
          exitTimeout = setTimeout(() => reject(new Error("review worker did not stop")), 10_000);
        }),
      ]).finally(() => {
        if (exitTimeout) clearTimeout(exitTimeout);
      });
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(stderr).toContain('"event":"review_worker_stopped"');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
