import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeCurrentExecutionSchema, MigrationCoordinator } from "../src/migration/coordinator.js";
import * as reviewV3Schema from "../src/migration/review-v3-schema.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { LocalCollabService } from "../src/app/service.js";

const roots: string[] = [];

const database = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-v3-signature-"));
  roots.push(root);
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  return path;
};

const schemaSnapshot = (path: string): string => {
  const db = new Database(path, { readonly: true });
  const snapshot = JSON.stringify(db.prepare(`SELECT type,name,tbl_name,rootpage,sql
    FROM sqlite_master ORDER BY type,name`).all());
  db.close();
  return snapshot;
};

const stateSnapshot = (path: string): string => {
  const db = new Database(path, { readonly: true });
  const schema = db.prepare(`SELECT type,name,tbl_name,rootpage,sql
    FROM sqlite_master ORDER BY type,name`).all();
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .pluck().all() as string[];
  const rows = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  ]));
  db.close();
  return JSON.stringify({ schema, rows });
};

const rewriteSchema = (path: string, name: string, from: string, to: string): void => {
  const db = new Database(path);
  db.unsafeMode(true);
  db.pragma("writable_schema = ON");
  const changed = db.prepare(`UPDATE sqlite_master SET sql=replace(sql,?,?)
    WHERE name=? AND instr(sql,?)>0`).run(from, to, name, from).changes;
  db.pragma("writable_schema = OFF");
  db.unsafeMode(false);
  db.close();
  expect(changed).toBe(1);
};

const replaceSchemaSql = (path: string, name: string, sql: string): void => {
  const db = new Database(path);
  db.unsafeMode(true);
  db.pragma("writable_schema = ON");
  const changed = db.prepare("UPDATE sqlite_master SET sql=? WHERE name=?").run(sql, name).changes;
  db.pragma("writable_schema = OFF");
  db.unsafeMode(false);
  db.close();
  expect(changed).toBe(1);
};

const dropSchemaObject = (path: string, statement: string): void => {
  const db = new Database(path);
  db.exec(statement);
  db.close();
};

const terminalXorTriggers = (path: string): Array<{ name: string; sql: string }> => {
  const db = new Database(path, { readonly: true });
  const rows = db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='trigger'
      AND lower(sql) LIKE '%runtime_review_spawn_authorities%'
      AND lower(sql) LIKE '%runtime_review_no_spawn_effects%'
    ORDER BY name`).all() as Array<{ name: string; sql: string }>;
  db.close();
  expect(rows.length, "valid review-v3 schema must own terminal spawn XOR triggers").toBeGreaterThan(0);
  return rows;
};

const assertIntegrity = (path: string): void => {
  const db = new Database(path, { readonly: true });
  expect(String(db.pragma("integrity_check", { simple: true }))).toBe("ok");
  db.close();
};

type ReadOnlySchemaAssertion = (db: Database.Database) => void;

const readOnlyAssertion = (): ReadOnlySchemaAssertion => {
  const candidate = (reviewV3Schema as unknown as Record<string, unknown>).assertReviewV3SchemaSignature;
  expect(candidate, "review-v3 must export a read-only schema assertion").toBeTypeOf("function");
  return candidate as ReadOnlySchemaAssertion;
};

const expectReadOnlyRejection = (path: string): void => {
  assertIntegrity(path);
  const before = schemaSnapshot(path);
  const assertion = readOnlyAssertion();
  const db = new Database(path, { readonly: true });
  let failure: unknown;
  try {
    assertion(db);
  } catch (error) {
    failure = error;
  } finally {
    db.close();
  }
  expect(String(failure)).toMatch(/review-v3|schema|signature|malformed|offline/i);
  expect(schemaSnapshot(path)).toBe(before);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("review-v3 exact schema signature", () => {
  it("accepts a valid capability-complete schema through a read-only reopen", () => {
    const path = database();
    const before = schemaSnapshot(path);
    const db = new Database(path, { readonly: true });
    expect(() => readOnlyAssertion()(db)).not.toThrow();
    db.close();
    expect(schemaSnapshot(path)).toBe(before);
  });

  it.each([
    {
      defect: "missing immutable trigger",
      mutate: (path: string) => dropSchemaObject(path,
        "DROP TRIGGER runtime_review_receipt_update_immutable"),
    },
    {
      defect: "name-preserving wrong immutable trigger body",
      mutate: (path: string) => rewriteSchema(path, "runtime_review_receipt_update_immutable",
        "RAISE(ABORT,'review receipt is immutable')", "RAISE(IGNORE)"),
    },
    {
      defect: "missing recovery-generation immutable trigger",
      mutate: (path: string) => dropSchemaObject(path,
        "DROP TRIGGER runtime_provider_recovery_generation_delete_immutable"),
    },
    {
      defect: "missing generation-consumption immutable trigger",
      mutate: (path: string) => dropSchemaObject(path,
        "DROP TRIGGER runtime_review_generation_consumption_update_immutable"),
    },
    {
      defect: "name-preserving wrong base-policy immutable trigger body",
      mutate: (path: string) => rewriteSchema(path, "runtime_review_base_policy_delete_immutable",
        "RAISE(ABORT,'review base policy is immutable')", "RAISE(IGNORE)"),
    },
    {
      defect: "missing owned table",
      mutate: (path: string) => dropSchemaObject(path,
        "DROP TABLE runtime_review_attempt_authorities"),
    },
    {
      defect: "missing tagged XOR constraint",
      mutate: (path: string) => rewriteSchema(path, "runtime_review_lane_attempts",
        "CHECK((attempt_id IS NULL", "CHECK((1=1) OR (attempt_id IS NULL"),
    },
    {
      defect: "wrong column",
      mutate: (path: string) => rewriteSchema(path, "runtime_review_attempt_base_policies",
        "created_at INTEGER", "created_on INTEGER"),
    },
    {
      defect: "wrong unique key",
      mutate: (path: string) => rewriteSchema(path, "runtime_provider_recovery_generations",
        "UNIQUE(agent,probe_claim_id)", "UNIQUE(probe_claim_id)"),
    },
    {
      defect: "wrong foreign key",
      mutate: (path: string) => rewriteSchema(path, "runtime_review_generation_consumptions",
        "REFERENCES runtime_provider_recovery_generations(agent,generation)",
        "REFERENCES runtime_provider_recovery_generations(generation,agent)"),
    },
    {
      defect: "missing required index",
      mutate: (path: string) => dropSchemaObject(path, "DROP INDEX runtime_review_attempts_lane"),
    },
    {
      defect: "wrong capability version",
      mutate: (path: string) => {
        const db = new Database(path);
        db.prepare(`UPDATE runtime_schema_capabilities SET capability_version=99
          WHERE capability='review-launch-authority'`).run();
        db.close();
      },
    },
  ])("rejects $defect without repairing sqlite_master", ({ mutate }) => {
    const path = database();
    mutate(path);
    expectReadOnlyRejection(path);
  });

  it("rejects a missing terminal spawn XOR trigger without repair", () => {
    const path = database();
    const [trigger] = terminalXorTriggers(path);
    dropSchemaObject(path, `DROP TRIGGER "${trigger!.name}"`);
    expectReadOnlyRejection(path);
  });

  it("rejects a name-preserving wrong terminal spawn XOR trigger body without repair", () => {
    const path = database();
    const [trigger] = terminalXorTriggers(path);
    const weakened = trigger!.sql.replace(/BEGIN[\s\S]*END\s*$/i, "BEGIN SELECT 1; END");
    expect(weakened).not.toBe(trigger!.sql);
    replaceSchemaSql(path, trigger!.name, weakened);
    expectReadOnlyRejection(path);
  });

  it("prevents recovery-generation ABA and immutable-ledger history deletion", () => {
    const path = database();
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO runtime_provider_recovery_generations
      (agent,generation,probe_claim_id,probe_claimed_at,verified_at)
      VALUES ('claude',1,'claude:10',10,11)`).run();

    expect(() => db.prepare(`UPDATE runtime_provider_recovery_generations
      SET probe_claim_id='claude:replacement' WHERE agent='claude' AND generation=1`).run())
      .toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM runtime_provider_recovery_generations
      WHERE agent='claude' AND generation=1`).run()).toThrow(/immutable/i);

    db.prepare(`INSERT INTO runtime_review_attempt_base_policies
      (base_policy_id,review_id,agent,role,model,effort,policy_version,reasons_json,
       legacy_session_id,legacy_idempotency_key,created_at)
      VALUES ('base-1','review-1','claude','auditor','glm-5.3','max','routing-v5','[]',
              'session-1','idempotency-1',12)`).run();
    expect(() => db.prepare(`UPDATE runtime_review_attempt_base_policies
      SET effort='high' WHERE base_policy_id='base-1'`).run()).toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM runtime_review_attempt_base_policies
      WHERE base_policy_id='base-1'`).run()).toThrow(/immutable/i);

    db.prepare(`INSERT INTO runtime_review_generation_consumptions
      (generation,review_id,agent,role,authority_id)
      VALUES (1,'review-1','claude','auditor','authority-1')`).run();
    expect(() => db.prepare(`UPDATE runtime_review_generation_consumptions
      SET authority_id='authority-replacement'
      WHERE generation=1 AND review_id='review-1' AND agent='claude' AND role='auditor'`).run())
      .toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM runtime_review_generation_consumptions
      WHERE generation=1 AND review_id='review-1' AND agent='claude' AND role='auditor'`).run())
      .toThrow(/immutable/i);

    expect(db.prepare(`SELECT agent,generation,probe_claim_id FROM runtime_provider_recovery_generations`)
      .all()).toEqual([{ agent: "claude", generation: 1, probe_claim_id: "claude:10" }]);
    expect(db.prepare(`SELECT base_policy_id,effort FROM runtime_review_attempt_base_policies`).all())
      .toEqual([{ base_policy_id: "base-1", effort: "max" }]);
    expect(db.prepare(`SELECT generation,authority_id FROM runtime_review_generation_consumptions`).all())
      .toEqual([{ generation: 1, authority_id: "authority-1" }]);
    db.close();
  });

  it("makes runtime construction fail before accepting a malformed capability-complete schema", () => {
    const path = database();
    dropSchemaObject(path, "DROP TRIGGER runtime_review_authority_delete_immutable");
    const before = schemaSnapshot(path);
    let runtime: RunGateUnitOfWork | undefined;
    expect(() => { runtime = new RunGateUnitOfWork(path); })
      .toThrow(/review-v3|schema|signature|offline|repair/i);
    runtime?.close();
    expect(schemaSnapshot(path)).toBe(before);
  });

  it("makes production initialization and service startup reject before any state-data mutation", () => {
    const path = database();
    const historyPath = join(dirname(path), "startup-history.db");
    dropSchemaObject(path, "DROP TRIGGER runtime_review_receipt_lifecycle_delete_immutable");
    const before = stateSnapshot(path);

    let initializationFailure: unknown;
    try {
      initializeCurrentExecutionSchema(path);
    } catch (error) {
      initializationFailure = error;
    }

    let service: LocalCollabService | undefined;
    let startupFailure: unknown;
    try {
      service = new LocalCollabService(path, {
        allowedRoots: [dirname(path)],
        historyDatabase: historyPath,
        agentSkillRoots: {
          grok: join(dirname(path), "grok-skills"),
          claude: join(dirname(path), "claude-skills"),
          codex: join(dirname(path), "codex-skills"),
        },
      });
    } catch (error) {
      startupFailure = error;
    } finally {
      service?.close();
    }

    expect(stateSnapshot(path)).toBe(before);

    if (existsSync(historyPath)) {
      const history = new Database(historyPath, { readonly: true });
      for (const table of ["pending_tools", "history_rows"] as const) {
        const exists = history.prepare(`SELECT 1 FROM sqlite_master
          WHERE type='table' AND name=?`).get(table);
        if (exists !== undefined) {
          expect(history.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
        }
      }
      history.close();
    }
    expect([String(initializationFailure), String(startupFailure)]).toEqual([
      expect.stringMatching(/review-v3|schema|signature|offline|repair/i),
      expect.stringMatching(/review-v3|schema|signature|offline|repair/i),
    ]);
  });

  it("keeps read-only assertion separate from the stopped-only MigrationCoordinator writer", () => {
    const assertion = readOnlyAssertion();
    const writer = (MigrationCoordinator.prototype as unknown as Record<string, unknown>)
      .extendReviewV3SchemaOffline;
    expect(writer).toBeTypeOf("function");
    expect(assertion).not.toBe(writer);

    const path = database();
    dropSchemaObject(path, "DROP TRIGGER runtime_review_authority_update_immutable");
    const before = schemaSnapshot(path);
    const coordinator = new MigrationCoordinator({ stateDatabase: path,
      historyDatabase: join(dirname(path), "history.db") });
    expect(() => (writer as () => unknown).call(coordinator))
      .toThrow(/schema|signature|offline|repair/i);
    expect(schemaSnapshot(path)).toBe(before);
  });
});
