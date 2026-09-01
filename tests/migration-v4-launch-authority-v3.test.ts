import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { installGraphV4Schema } from "./helpers/graph-schema.js";

const roots: string[] = [];

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-authority-v3-"));
  roots.push(root);
  return join(root, "state.db");
}

function buildPopulatedPreCapabilityV4(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,stage TEXT NOT NULL,
      priority INTEGER NOT NULL,status TEXT NOT NULL,artifact_hash TEXT,approval_scope TEXT,
      created_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,lease_token TEXT,
      lease_expires_at INTEGER,worker_id TEXT,launched INTEGER NOT NULL DEFAULT 0,
      launch_info TEXT,result TEXT,cancel_reason TEXT,payload TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,depends_on_run_id TEXT
    );
    CREATE TABLE collaboration_runs (
      workflow_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE collaboration_dispatch_outbox (
      dispatch_id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES collaboration_runs(workflow_id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,published_at INTEGER,terminal_reason TEXT
    );
    CREATE TABLE runtime_provider_health (
      agent TEXT PRIMARY KEY CHECK(agent IN ('grok','claude','codex')),
      health TEXT NOT NULL CHECK(health IN ('healthy','unavailable','probing','disabled')),
      retry_at INTEGER,failure_count INTEGER NOT NULL DEFAULT 0,
      attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK(attempt_claimed IN(0,1)),
      capability_verified INTEGER NOT NULL DEFAULT 0 CHECK(capability_verified IN(0,1)),updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_review_barriers (
      review_id TEXT PRIMARY KEY,stage_id TEXT NOT NULL,artifact BLOB NOT NULL,artifact_hash TEXT NOT NULL,
      approval_scope TEXT NOT NULL CHECK(approval_scope='workspace-read'),idempotency_key TEXT NOT NULL,
      run_state TEXT NOT NULL CHECK(run_state IN('FULL_CROSS_PROVIDER','DEGRADED_REVIEW_SET')),
      created_at INTEGER NOT NULL,project TEXT,requester TEXT CHECK(requester IS NULL OR requester IN('grok','codex')),
      source_fingerprint TEXT,changed_files INTEGER NOT NULL DEFAULT 0 CHECK(changed_files>=0),
      launch_authority_version INTEGER NOT NULL DEFAULT 1 CHECK(launch_authority_version IN(1,2))
    );
    CREATE TABLE runtime_review_lanes (
      review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
      agent TEXT NOT NULL CHECK(agent IN('grok','claude','codex')),role TEXT NOT NULL CHECK(role IN('auditor','critic')),
      status TEXT NOT NULL CHECK(status IN('queued','deferred','completed','failed','timed_out','stale_artifact')),
      model TEXT NOT NULL CHECK(model IN('grok-4.6','glm-5.3','gpt-5.6-sol')),
      effort TEXT NOT NULL CHECK(effort IN('high','xhigh','max')),policy_version TEXT NOT NULL CHECK(policy_version='routing-v5'),
      reasons TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,prompt TEXT NOT NULL,
      degraded INTEGER NOT NULL CHECK(degraded IN(0,1)),result TEXT,error TEXT,terminal_at INTEGER,
      PRIMARY KEY(review_id,agent,role)
    );
    CREATE TABLE runtime_review_lane_attempts (
      review_id TEXT NOT NULL,agent TEXT NOT NULL CHECK(agent IN('grok','claude','codex')),
      role TEXT NOT NULL CHECK(role IN('auditor','critic')),attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal>=0),
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),created_at INTEGER NOT NULL,
      PRIMARY KEY(review_id,agent,role,attempt_ordinal),
      FOREIGN KEY(review_id,agent,role) REFERENCES runtime_review_lanes(review_id,agent,role) ON DELETE CASCADE
    );
    CREATE TABLE approval_grants (
      reference TEXT NOT NULL,project TEXT NOT NULL,scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,max_uses INTEGER NOT NULL,used_count INTEGER NOT NULL,
      PRIMARY KEY(reference,project,scope)
    );
    CREATE TABLE approval_consumptions (
      consumer_key TEXT PRIMARY KEY,reference TEXT NOT NULL,project TEXT NOT NULL,
      scope TEXT NOT NULL,consumed_at INTEGER NOT NULL
    );
    CREATE TABLE worktree_leases (
      worktree_path TEXT PRIMARY KEY,task_id TEXT NOT NULL,lease_id TEXT NOT NULL,
      holder TEXT NOT NULL CHECK(holder IN('grok','codex')),fencing_token INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,authority_policy TEXT NOT NULL DEFAULT 'routing-v5' CHECK(authority_policy='routing-v5')
    );
    CREATE TABLE worktree_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,payload TEXT NOT NULL
    );
    CREATE TRIGGER runtime_review_attempt_v2_insert BEFORE INSERT ON runtime_review_lane_attempts
    WHEN (SELECT launch_authority_version FROM runtime_review_barriers WHERE review_id=NEW.review_id)=2
    BEGIN
      SELECT CASE WHEN NEW.attempt_ordinal<>0 THEN RAISE(ABORT,'launch authority v2 requires attempt_ordinal=0') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM runtime_review_lane_attempts WHERE review_id=NEW.review_id AND agent=NEW.agent AND role=NEW.role)
        THEN RAISE(ABORT,'launch authority v2 permits one lane attempt') END;
    END;
    CREATE TRIGGER runtime_review_attempt_v2_update BEFORE UPDATE ON runtime_review_lane_attempts
    WHEN (SELECT launch_authority_version FROM runtime_review_barriers WHERE review_id=NEW.review_id)=2
    BEGIN SELECT CASE WHEN NEW.attempt_ordinal<>0 THEN RAISE(ABORT,'launch authority v2 requires attempt_ordinal=0') END; END;
    CREATE TRIGGER runtime_review_barrier_v2_update BEFORE UPDATE OF launch_authority_version ON runtime_review_barriers
    WHEN NEW.launch_authority_version=2 AND EXISTS(
      SELECT 1 FROM runtime_review_lane_attempts WHERE review_id=NEW.review_id GROUP BY agent,role
      HAVING COUNT(*)>1 OR MIN(attempt_ordinal)<>0 OR MAX(attempt_ordinal)<>0)
    BEGIN SELECT RAISE(ABORT,'launch authority v2 requires one ordinal-zero lane attempt'); END;
    INSERT INTO runs(id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
      VALUES('legacy-run','legacy-run','review:auditor',20,'completed',1,1);
    INSERT INTO collaboration_runs VALUES('legacy-flow','{"status":"completed"}',1,2);
    INSERT INTO collaboration_dispatch_outbox VALUES('legacy-dispatch','legacy-flow','{}',3,'completed');
    INSERT INTO runtime_provider_health VALUES
      ('grok','unavailable',10,1,0,0,4),('claude','unavailable',10,1,0,0,4),('codex','healthy',NULL,0,0,1,4);
    INSERT INTO runtime_review_barriers VALUES
      ('legacy-review','stage',X'01','legacy-hash','workspace-read','legacy-key','DEGRADED_REVIEW_SET',5,'/repo','codex','source',1,2);
    INSERT INTO runtime_review_lanes VALUES
      ('legacy-review','codex','auditor','completed','gpt-5.6-sol','max','routing-v5','[]','legacy-session','legacy-lane','audit',0,'{}',NULL,6);
    INSERT INTO runtime_review_lane_attempts VALUES('legacy-review','codex','auditor',0,'legacy-run',5);
    INSERT INTO approval_grants VALUES('approval','/repo','workspace-read',100,2,1);
    INSERT INTO approval_consumptions VALUES('consumer','approval','/repo','workspace-read',8);
    INSERT INTO worktree_leases VALUES('/repo','task','lease','codex',1,100,'routing-v5');
    INSERT INTO worktree_handoffs(task_id,recorded_at,payload) VALUES('task',7,'{}');
    PRAGMA user_version=4;
  `);
  db.close();
  installGraphV4Schema(path);
}

const LEGACY_TABLES = [
  "runs", "collaboration_runs", "collaboration_dispatch_outbox", "runtime_provider_health",
  "runtime_review_barriers", "runtime_review_lanes", "runtime_review_lane_attempts",
  "approval_grants", "approval_consumptions", "worktree_leases", "worktree_handoffs",
] as const;

function legacySnapshot(db: Database.Database): Record<string, unknown> {
  const legacyColumns: Partial<Record<(typeof LEGACY_TABLES)[number], string>> = {
    runtime_review_lanes: `review_id,agent,role,status,model,effort,policy_version,reasons,
      session_id,idempotency_key,prompt,degraded,result,error,terminal_at`,
    runtime_review_lane_attempts: "review_id,agent,role,attempt_ordinal,run_id,created_at",
  };
  return {
    tables: Object.fromEntries(LEGACY_TABLES.map((table) => [
      table,
      db.prepare(`SELECT ${legacyColumns[table] ?? "*"} FROM ${table} ORDER BY rowid`).all(),
    ])),
    indexes: db.prepare(`SELECT name,tbl_name,sql FROM sqlite_master
      WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(),
    triggers: db.prepare(`SELECT name,tbl_name,sql FROM sqlite_master
      WHERE type='trigger' ORDER BY name`).all(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reviewInput = {
  reviewId: "review-v3",
  stageId: "stage-v3",
  artifact: Buffer.from("immutable candidate"),
  health: { grok: "unavailable", claude: "unavailable", codex: "healthy" } as const,
  approvalScope: "workspace-read" as const,
  idempotencyKey: "review-v3-key",
  prompts: { auditor: "audit", critic: "critic" },
  createdAt: 100,
  project: "/repo",
  requester: "codex" as const,
  sourceFingerprint: "source-v1",
  changedFiles: 3,
};

function appendInitialReceipts(
  db: Database.Database,
  reviewId = reviewInput.reviewId,
): Array<Record<string, unknown>> {
  const receipts: Array<Record<string, unknown>> = [];
  for (const role of ["auditor", "critic"] as const) {
    const activationNonce = `initial-${role}`;
    const expectedTuple = JSON.stringify({ laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null });
    const pair: Record<string, unknown> = { agent: "codex", role, activationNonce };
    for (const kind of ["source", "readiness"] as const) {
      const receiptId = `initial-${role}-${kind}`;
      const scope = `review/${reviewId}/codex/${role}/${kind}`;
      const observation = JSON.stringify(kind === "source"
        ? { sourceFingerprint: reviewInput.sourceFingerprint, valid: true }
        : { harnessReady: true, valid: true });
      const observationHash = createHash("sha256").update(observation).digest("hex");
      const canonicalBytes = JSON.stringify({ receiptId, phase: "admission", scope,
        scopeRevision: 1, activationNonce, expectedTuple, recoveryGeneration: null,
        observationHash, predecessorReceiptId: null });
      db.prepare(`INSERT INTO runtime_review_receipts
        (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
         recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
         canonical_bytes,envelope_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, "admission", scope, 1, activationNonce, expectedTuple, null, observation,
        observationHash, null, canonicalBytes,
        createHash("sha256").update(canonicalBytes).digest("hex"), 99,
      );
      db.prepare(`INSERT INTO runtime_review_receipt_heads
        (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,1,?)`)
        .run(scope, receiptId, activationNonce);
      pair[`${kind}ReceiptId`] = receiptId;
    }
    receipts.push(pair);
  }
  return receipts;
}

describe("v4 capability-gated launch authority v3", () => {
  it("keeps user_version=4 and advertises the complete review-v3 schema across reopen", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const db = new Database(path, { readonly: true });
      expect(Number(db.pragma("user_version", { simple: true }))).toBe(4);
      expect(db.prepare(`SELECT capability, capability_version
        FROM runtime_schema_capabilities ORDER BY capability`).all()).toEqual([
        { capability: "review-attempt-identity", capability_version: 1 },
        { capability: "review-launch-authority", capability_version: 3 },
        { capability: "review-prelaunch-fence", capability_version: 1 },
        { capability: "review-receipt-ledger", capability_version: 1 },
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    }
  });

  it("creates new barriers as v3 and persists exact initial authority for every active ordinal zero", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const receiptDb = new Database(path);
    const admissionReceipts = appendInitialReceipts(receiptDb);
    receiptDb.close();
    const reviews = new RunGateUnitOfWork(path);
    const create = reviews.create.bind(reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    const first = create({ ...reviewInput, admissionReceipts });
    const replay = create({ ...reviewInput, admissionReceipts });
    expect(replay).toEqual(first);
    reviews.close();

    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT launch_authority_version
      FROM runtime_review_barriers WHERE review_id=?`).pluck().get(reviewInput.reviewId)).toBe(3);

    const active = db.prepare(`SELECT l.agent,l.role,a.attempt_ordinal,a.run_id,a.attempt_id,
        a.authority_id,a.base_policy_id
      FROM runtime_review_lanes l
      JOIN runtime_review_lane_attempts a USING (review_id,agent,role)
      WHERE l.review_id=? AND l.status='queued'
      ORDER BY l.agent,l.role`).all(reviewInput.reviewId) as Array<Record<string, unknown>>;
    expect(active).toHaveLength(2);
    expect(active.every((row) => row.attempt_ordinal === 0 && typeof row.attempt_id === "string" &&
      typeof row.authority_id === "string" && typeof row.base_policy_id === "string")).toBe(true);

    const authorities = db.prepare(`SELECT authority_id,attempt_id,attempt_ordinal,authority_kind,
        recovery_generation,admission_source_receipt_id,admission_readiness_receipt_id
      FROM runtime_review_attempt_authorities WHERE review_id=? ORDER BY agent,role`)
      .all(reviewInput.reviewId) as Array<Record<string, unknown>>;
    expect(authorities).toHaveLength(2);
    for (const [index, authority] of authorities.entries()) {
      expect(authority).toMatchObject({
        authority_id: active[index]!.authority_id,
        attempt_id: active[index]!.attempt_id,
        attempt_ordinal: 0,
        authority_kind: "initial",
        recovery_generation: null,
      });
      expect(authority.admission_source_receipt_id).toBeTypeOf("string");
      expect(authority.admission_readiness_receipt_id).toBeTypeOf("string");
    }
    expect(db.prepare(`SELECT receipt_id,state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id LIKE 'initial-%' ORDER BY receipt_id`).all()).toEqual([
      { receipt_id: "initial-auditor-readiness", state: "consumed" },
      { receipt_id: "initial-auditor-source", state: "consumed" },
      { receipt_id: "initial-critic-readiness", state: "consumed" },
      { receipt_id: "initial-critic-source", state: "consumed" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_barriers WHERE review_id=?`)
      .pluck().get(reviewInput.reviewId)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts WHERE review_id=?`)
      .pluck().get(reviewInput.reviewId)).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_attempt_authorities WHERE review_id=?`)
      .pluck().get(reviewInput.reviewId)).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_receipts WHERE receipt_id LIKE 'initial-%'`)
      .pluck().get()).toBe(4);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts a
      JOIN runtime_review_lanes l USING(review_id,agent,role)
      WHERE a.review_id=? AND l.agent IN ('grok','claude')`).pluck().get(reviewInput.reviewId)).toBe(0);
    expect(db.prepare(`SELECT agent,role,status FROM runtime_review_lanes
      WHERE review_id=? ORDER BY agent,role`).all(reviewInput.reviewId)).toEqual([
      { agent: "claude", role: "auditor", status: "deferred" },
      { agent: "claude", role: "critic", status: "deferred" },
      { agent: "codex", role: "auditor", status: "queued" },
      { agent: "codex", role: "critic", status: "queued" },
      { agent: "grok", role: "auditor", status: "deferred" },
      { agent: "grok", role: "critic", status: "deferred" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_attempt_base_policies
      WHERE review_id=?`).pluck().get(reviewInput.reviewId)).toBe(6);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_attempt_authorities
      WHERE review_id=? AND agent IN ('grok','claude')`).pluck().get(reviewInput.reviewId)).toBe(0);
    db.close();
  });

  it.each([
    "after_base_policy_insert", "after_lane_insert", "after_initial_authority_insert",
    "after_run_insert", "after_attempt_link_insert", "after_projection_update", "before_create_commit",
  ])("rolls back the complete v3 create tuple at %s", (faultPoint) => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const receiptDb = new Database(path);
    const faultReviewId = `create-fault-${faultPoint}`;
    const admissionReceipts = appendInitialReceipts(receiptDb, faultReviewId);
    receiptDb.close();
    const reviews = new RunGateUnitOfWork(path);
    const create = reviews.create.bind(reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    expect(() => create({ ...reviewInput, reviewId: faultReviewId,
      idempotencyKey: faultReviewId, admissionReceipts,
      faultInjector: (point: string) => {
        if (point === faultPoint) throw new Error(`injected create fault: ${faultPoint}`);
      } })).toThrow(/injected create fault/i);
    reviews.close();
    const db = new Database(path, { readonly: true });
    for (const table of ["runtime_review_barriers", "runtime_review_lanes",
      "runtime_review_attempt_base_policies", "runtime_review_lane_attempts",
      "runtime_review_attempt_authorities", "runs"] as const) {
      const where = table === "runs" ? "payload LIKE ?" : "review_id=?";
      expect(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${where}`).pluck()
        .get(`%create-fault-${faultPoint}%`), table).toBe(0);
    }
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id LIKE 'initial-%'`).pluck().get()).toBe(0);
    db.close();
  });

  it("fails closed when an active new-v3 lane has no exact pending admission pair", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const reviews = new RunGateUnitOfWork(path);
    expect(() => reviews.create({ ...reviewInput, reviewId: "missing-create-receipts",
      idempotencyKey: "missing-create-receipts" })).toThrow(/receipt|admission|authority/i);
    reviews.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_barriers
      WHERE review_id='missing-create-receipts'`).pluck().get()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) FROM runs WHERE payload LIKE '%missing-create-receipts%'`)
      .pluck().get()).toBe(0);
    db.close();
  });

  it("preserves authority-v1/v2 rows and their one-shot v2 trigger while enabling v3", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    const barrierSql = String((db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='runtime_review_barriers'`).get() as { sql: string }).sql);
    expect(barrierSql).toMatch(/launch_authority_version[\s\S]*\b1\b[\s\S]*\b2\b[\s\S]*\b3\b/i);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name IN ('runtime_review_attempt_v2_insert','runtime_review_attempt_v2_update',
                   'runtime_review_barrier_v2_update') ORDER BY name`).pluck().all()).toHaveLength(3);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name='runtime_review_barrier_authority_version_immutable'`).pluck().get())
      .toBe("runtime_review_barrier_authority_version_immutable");
    for (const version of [1, 2, 3]) {
      db.prepare(`INSERT INTO runtime_review_barriers
        (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
         run_state,created_at,launch_authority_version)
        VALUES (?,?,?,?,? ,?,?,?,?)`).run(
        `immutable-v${version}`, "stage", Buffer.from([version]), `hash-${version}`,
        "workspace-read", `immutable-${version}`, "DEGRADED_REVIEW_SET", version, version,
      );
      expect(() => db.prepare(`UPDATE runtime_review_barriers SET launch_authority_version=?
        WHERE review_id=?`).run(version === 3 ? 1 : 3, `immutable-v${version}`))
        .toThrow(/authority.*immutable|immutable.*authority/i);
    }
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(4);
    db.close();
  });

  it("executes legacy v1 multi-attempt and v2 ordinal-zero contracts without v3 rows", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    for (const version of [1, 2] as const) {
      db.prepare(`INSERT INTO runtime_review_barriers
        (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
         run_state,created_at,launch_authority_version)
        VALUES (?,?,?,?,? ,?,?,?,?)`).run(
        `legacy-v${version}`, "stage", Buffer.from([version]), `hash-v${version}`,
        "workspace-read", `key-v${version}`, "DEGRADED_REVIEW_SET", version, version,
      );
      db.prepare(`INSERT INTO runtime_review_lanes
        (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
         idempotency_key,prompt,degraded)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `legacy-v${version}`, "codex", "auditor", "queued", "gpt-5.6-sol", "max",
        "routing-v5", "[]", `session-v${version}`, `lane-v${version}`, "audit", 0,
      );
      db.prepare(`INSERT INTO runs(id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
        VALUES (?,?,?,?,?,?,?)`).run(`run-v${version}-0`, `run-v${version}-0`, "review", 1, "queued", 1, 1);
      db.prepare(`INSERT INTO runtime_review_lane_attempts
        (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES (?,?,?,?,?,?)`).run(
        `legacy-v${version}`, "codex", "auditor", 0, `run-v${version}-0`, 1,
      );
    }
    db.prepare(`INSERT INTO runs(id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
      VALUES ('run-v1-1','run-v1-1','review',1,'queued',2,2),
             ('run-v2-1','run-v2-1','review',1,'queued',2,2)`).run();
    expect(() => db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at)
      VALUES ('legacy-v1','codex','auditor',1,'run-v1-1',2)`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at)
      VALUES ('legacy-v2','codex','auditor',1,'run-v2-1',2)`).run()).toThrow(/authority v2/i);
    db.close();
    const reviews = new RunGateUnitOfWork(path);
    expect(reviews.attempts("legacy-v1", "codex", "auditor")).toHaveLength(2);
    expect(reviews.attempts("legacy-v2", "codex", "auditor")).toHaveLength(1);
    expect(() => reviews.barrier("legacy-v1")).toThrow(/exact .*auditor\/critic topology/i);
    expect(() => reviews.barrier("legacy-v2")).toThrow(/exact .*auditor\/critic topology/i);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    for (const table of ["runtime_review_attempt_authorities", "runtime_review_receipts",
      "runtime_review_spawn_authorities", "runtime_review_no_spawn_effects"] as const) {
      expect(proof.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
    }
    proof.close();
  });

  it("upgrades an existing user_version=4 database when all v3 capability markers are absent", () => {
    const path = database();
    buildPopulatedPreCapabilityV4(path);
    const before = new Database(path);
    const legacyState = legacySnapshot(before);
    before.close();

    initializeCurrentExecutionSchema(path);

    const upgraded = new Database(path, { readonly: true });
    expect(Number(upgraded.pragma("user_version", { simple: true }))).toBe(4);
    expect(upgraded.prepare("SELECT COUNT(*) FROM runtime_schema_capabilities").pluck().get()).toBe(4);
    const upgradedState = legacySnapshot(upgraded);
    expect(upgradedState.tables).toEqual(legacyState.tables);
    const originalIndexes = (legacyState.indexes as Array<{ name: string }>).map(({ name }) => name);
    expect((upgradedState.indexes as Array<{ name: string }>).filter(({ name }) =>
      originalIndexes.includes(name))).toEqual(legacyState.indexes);
    const originalTriggers = (legacyState.triggers as Array<{ name: string }>).map(({ name }) => name);
    expect((upgradedState.triggers as Array<{ name: string }>).filter(({ name }) =>
      originalTriggers.includes(name))).toEqual(legacyState.triggers);
    upgraded.close();
  });

  it.each(["partial-marker", "marker-without-owned-schema"] as const)(
    "fails closed on partial v4 capability ownership: %s",
    (variant) => {
      const path = database();
      buildPopulatedPreCapabilityV4(path);
      const db = new Database(path);
      db.exec(`CREATE TABLE runtime_schema_capabilities(
        capability TEXT PRIMARY KEY,capability_version INTEGER NOT NULL)`);
      const insert = db.prepare("INSERT INTO runtime_schema_capabilities VALUES (?,?)");
      const rows = variant === "partial-marker"
        ? [["review-launch-authority", 3] as const]
        : [
          ["review-attempt-identity", 1], ["review-launch-authority", 3],
          ["review-prelaunch-fence", 1], ["review-receipt-ledger", 1],
        ] as const;
      for (const row of rows) insert.run(...row);
      const before = db.prepare("SELECT * FROM runtime_schema_capabilities ORDER BY capability").all();
      db.close();

      expect(() => initializeCurrentExecutionSchema(path)).toThrow(/partial|ownership|capabil.*schema|schema.*capabil/i);
      const reopened = new Database(path, { readonly: true });
      expect(reopened.prepare("SELECT * FROM runtime_schema_capabilities ORDER BY capability").all())
        .toEqual(before);
      expect(Number(reopened.pragma("user_version", { simple: true }))).toBe(4);
      reopened.close();
    },
  );

  it.each([
    "after_v4_capability_table",
    "after_v4_capability_schema",
    "before_v4_capability_commit",
  ])("rolls back the whole populated-v4 upgrade at failpoint %s", (faultPoint) => {
    const path = database();
    buildPopulatedPreCapabilityV4(path);
    const before = new Database(path, { readonly: true });
    const stateBefore = legacySnapshot(before);
    before.close();
    const initializeWithFault = initializeCurrentExecutionSchema as unknown as
      (path: string, options?: { faultInjector?: (point: string) => void }) => void;

    expect(() => initializeWithFault(path, { faultInjector: (point) => {
      if (point === faultPoint) throw new Error(`injected capability fault: ${faultPoint}`);
    } })).toThrow(/injected capability fault/i);

    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT name FROM sqlite_master WHERE name='runtime_schema_capabilities'`)
      .all()).toEqual([]);
    expect(legacySnapshot(reopened)).toEqual(stateBefore);
    expect(Number(reopened.pragma("user_version", { simple: true }))).toBe(4);
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    reopened.close();
  });
});
