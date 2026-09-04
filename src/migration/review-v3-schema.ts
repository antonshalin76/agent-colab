import Database from "better-sqlite3";

export type ReviewV3FaultPoint =
  | "after_v4_capability_table"
  | "after_v4_capability_schema"
  | "before_v4_capability_commit";

const capabilities = [
  ["review-attempt-identity", 1],
  ["review-launch-authority", 3],
  ["review-prelaunch-fence", 1],
  ["review-receipt-ledger", 1],
] as const;

export const REVIEW_V3_TABLE_CLASSIFICATION = Object.freeze({
  added: Object.freeze([
    "runtime_provider_recovery_generations",
    "runtime_review_attempt_authorities",
    "runtime_review_attempt_base_policies",
    "runtime_review_generation_consumptions",
    "runtime_review_no_spawn_effects",
    "runtime_review_receipt_heads",
    "runtime_review_receipt_lifecycle",
    "runtime_review_receipts",
    "runtime_review_spawn_authorities",
    "runtime_schema_capabilities",
  ] as const),
  replaced: Object.freeze([
    "runtime_review_barriers",
    "runtime_review_lane_attempts",
    "runtime_review_lanes",
  ] as const),
});

const ownedTables = REVIEW_V3_TABLE_CLASSIFICATION.added.filter(
  (table) => table !== "runtime_schema_capabilities",
);

const exactColumns: Readonly<Record<string, readonly string[]>> = {
  runtime_provider_recovery_generations: [
    "agent", "generation", "probe_claim_id", "probe_claimed_at", "verified_at",
  ],
  runtime_review_attempt_base_policies: [
    "base_policy_id", "review_id", "agent", "role", "model", "effort", "policy_version",
    "reasons_json", "legacy_session_id", "legacy_idempotency_key", "created_at",
  ],
  runtime_review_receipts: [
    "receipt_id", "phase", "scope", "scope_revision", "activation_nonce", "expected_tuple_json",
    "recovery_generation", "observation_json", "observation_hash", "predecessor_receipt_id",
    "canonical_bytes", "envelope_hash", "created_at",
  ],
  runtime_review_receipt_heads: ["scope", "receipt_id", "scope_revision", "activation_nonce"],
  runtime_review_receipt_lifecycle: [
    "receipt_id", "state", "scope_revision", "activation_nonce", "expected_tuple_json",
    "recovery_generation", "predecessor_receipt_id", "recorded_at",
  ],
  runtime_review_attempt_authorities: [
    "authority_id", "review_id", "agent", "role", "attempt_id", "attempt_ordinal",
    "authority_kind", "recovery_generation", "previous_ordinal", "previous_evidence_hash",
    "admission_source_receipt_id", "admission_readiness_receipt_id", "activation_nonce",
    "authority_hash", "created_at",
  ],
  runtime_review_generation_consumptions: [
    "generation", "review_id", "agent", "role", "authority_id",
  ],
  runtime_review_spawn_authorities: [
    "attempt_id", "attempt_authority_id", "prelaunch_receipt_id", "authority_hash", "created_at",
  ],
  runtime_review_no_spawn_effects: ["attempt_id", "reason", "prelaunch_receipt_id", "recorded_at"],
};

const immutableTriggers = [
  "runtime_review_barrier_authority_version_immutable",
  "runtime_provider_recovery_generation_update_immutable",
  "runtime_provider_recovery_generation_delete_immutable",
  "runtime_review_generation_consumption_update_immutable",
  "runtime_review_generation_consumption_delete_immutable",
  "runtime_review_base_policy_update_immutable", "runtime_review_base_policy_delete_immutable",
  "runtime_review_receipt_update_immutable", "runtime_review_receipt_delete_immutable",
  "runtime_review_receipt_lifecycle_update_immutable", "runtime_review_receipt_lifecycle_delete_immutable",
  "runtime_review_authority_update_immutable", "runtime_review_authority_delete_immutable",
  "runtime_review_attempt_update_immutable", "runtime_review_attempt_delete_immutable",
  "runtime_review_spawn_update_immutable", "runtime_review_spawn_delete_immutable",
  "runtime_review_no_spawn_update_immutable", "runtime_review_no_spawn_delete_immutable",
] as const;

const terminalXorTriggers = [
  "runtime_review_spawn_terminal_xor", "runtime_review_no_spawn_terminal_xor",
] as const;

const exists = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

const signatureError = (detail: string): never => {
  throw new Error(`review-v3 capability schema signature mismatch; offline repair required: ${detail}`);
};

const normalizedSql = (sql: string): string => sql.toLowerCase().replace(/\s+/g, "");

const objectSql = (db: Database.Database, type: "table" | "trigger", name: string): string => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
    .get(type, name) as { sql: string | null } | undefined;
  const sql = row?.sql;
  if (typeof sql === "string") return normalizedSql(sql);
  return signatureError(`missing ${type} ${name}`);
};

const columnNames = (db: Database.Database, table: string): string[] =>
  (db.pragma(`table_info('${table.replaceAll("'", "''")}')`) as Array<{ name: string }>).map(({ name }) => name);

const hasExactIndex = (
  db: Database.Database,
  table: string,
  columns: readonly string[],
  unique?: boolean,
): boolean => {
  const indexes = db.pragma(`index_list('${table.replaceAll("'", "''")}')`) as
    Array<{ name: string; unique: 0 | 1 }>;
  return indexes.some((index) => {
    if (unique !== undefined && (index.unique === 1) !== unique) return false;
    const actual = (db.pragma(`index_info('${index.name.replaceAll("'", "''")}')`) as
      Array<{ name: string }>).map(({ name }) => name);
    return actual.length === columns.length && actual.every((column, i) => column === columns[i]);
  });
};

export function assertReviewV3SchemaSignature(db: Database.Database): void {
  if (!exists(db, "runtime_schema_capabilities")) signatureError("missing capability ownership");
  const actualCapabilities = db.prepare(`SELECT capability,capability_version
    FROM runtime_schema_capabilities ORDER BY capability`).all() as
    Array<{ capability: string; capability_version: number }>;
  const expectedCapabilities = capabilities.map(([capability, capability_version]) =>
    ({ capability, capability_version })).sort((left, right) => left.capability.localeCompare(right.capability));
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)) {
    signatureError("capability marker set");
  }

  for (const [table, expected] of Object.entries(exactColumns)) {
    if (!exists(db, table)) signatureError(`missing owned table ${table}`);
    const actual = columnNames(db, table);
    if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
      signatureError(`column signature ${table}`);
    }
  }

  const attempts = objectSql(db, "table", "runtime_review_lane_attempts");
  for (const fragment of [
    "check((attempt_idisnull",
    "(authority_kind='initial'andattempt_ordinal=0andrecovery_generationisnull",
    "(authority_kind='first_admission'andattempt_ordinal=0andrecovery_generationisnotnull",
    "(authority_kind='recovery'andattempt_ordinal>0andrecovery_generationisnotnull",
  ]) {
    if (!attempts.includes(fragment)) signatureError("runtime_review_lane_attempts tagged XOR");
  }

  for (const columns of [
    ["agent", "generation"], ["agent", "probe_claim_id"], ["agent", "probe_claimed_at"],
  ] as const) {
    if (!hasExactIndex(db, "runtime_provider_recovery_generations", columns, true)) {
      signatureError(`recovery generation UNIQUE(${columns.join(",")})`);
    }
  }
  if (!hasExactIndex(db, "runtime_review_attempt_base_policies", ["review_id", "agent", "role"], true)) {
    signatureError("base policy lane unique key");
  }
  if (!hasExactIndex(db, "runtime_review_generation_consumptions",
    ["generation", "review_id", "agent", "role"], true)) {
    signatureError("generation consumption unique key");
  }
  if (!hasExactIndex(db, "runtime_review_lane_attempts",
    ["review_id", "agent", "role", "attempt_ordinal"], false)) {
    signatureError("runtime_review_attempts_lane index");
  }

  const foreignKeys = db.pragma("foreign_key_list('runtime_review_generation_consumptions')") as
    Array<{ table: string; from: string; to: string; id: number; seq: number }>;
  const generationForeignKey = foreignKeys.filter(({ table }) =>
    table === "runtime_provider_recovery_generations").sort((left, right) => left.seq - right.seq);
  if (generationForeignKey.length !== 2 || generationForeignKey[0]?.from !== "agent" ||
      generationForeignKey[0]?.to !== "agent" || generationForeignKey[1]?.from !== "generation" ||
      generationForeignKey[1]?.to !== "generation" ||
      generationForeignKey[0]?.id !== generationForeignKey[1]?.id) {
    signatureError("generation consumption foreign key");
  }

  for (const trigger of immutableTriggers) {
    const sql = objectSql(db, "trigger", trigger);
    if (!sql.includes("raise(abort") || !sql.includes("immutable")) {
      signatureError(`immutable trigger body ${trigger}`);
    }
  }
  for (const trigger of terminalXorTriggers) {
    const sql = objectSql(db, "trigger", trigger);
    if (!sql.includes("runtime_review_spawn_authorities") ||
        !sql.includes("runtime_review_no_spawn_effects") ||
        !sql.includes("raise(abort") || !sql.includes("terminal")) {
      signatureError(`terminal XOR trigger body ${trigger}`);
    }
  }
}

const v2Triggers = `
  CREATE TRIGGER runtime_review_attempt_v2_insert
  BEFORE INSERT ON runtime_review_lane_attempts
  WHEN (SELECT launch_authority_version FROM runtime_review_barriers
        WHERE review_id = NEW.review_id) = 2
  BEGIN
    SELECT CASE WHEN NEW.attempt_ordinal <> 0
      THEN RAISE(ABORT, 'launch authority v2 requires attempt_ordinal=0') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM runtime_review_lane_attempts
      WHERE review_id = NEW.review_id AND agent = NEW.agent AND role = NEW.role
    ) THEN RAISE(ABORT, 'launch authority v2 permits one lane attempt') END;
  END;
  CREATE TRIGGER runtime_review_attempt_v2_update
  BEFORE UPDATE ON runtime_review_lane_attempts
  WHEN (SELECT launch_authority_version FROM runtime_review_barriers
        WHERE review_id = NEW.review_id) = 2
  BEGIN
    SELECT CASE WHEN NEW.attempt_ordinal <> 0
      THEN RAISE(ABORT, 'launch authority v2 requires attempt_ordinal=0') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM runtime_review_lane_attempts
      WHERE review_id = NEW.review_id AND agent = NEW.agent AND role = NEW.role
        AND rowid <> OLD.rowid
    ) THEN RAISE(ABORT, 'launch authority v2 permits one lane attempt') END;
  END;
  CREATE TRIGGER runtime_review_barrier_v2_update
  BEFORE UPDATE OF launch_authority_version ON runtime_review_barriers
  WHEN NEW.launch_authority_version = 2 AND EXISTS (
    SELECT 1 FROM runtime_review_lane_attempts
    WHERE review_id = NEW.review_id
    GROUP BY agent, role
    HAVING COUNT(*) > 1 OR MIN(attempt_ordinal) <> 0 OR MAX(attempt_ordinal) <> 0
  )
  BEGIN
    SELECT RAISE(ABORT, 'launch authority v2 requires one ordinal-zero lane attempt');
  END;
`;

export function extendReviewV3SchemaOffline(
  db: Database.Database,
  faultInjector?: (point: ReviewV3FaultPoint) => void,
): void {
  if (exists(db, "runtime_schema_capabilities")) {
    assertReviewV3SchemaSignature(db);
    return;
  }
  if (ownedTables.some((table) => exists(db, table))) {
    throw new Error("review-v3 schema exists without capability ownership");
  }

  const preservedV2Triggers = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name IN (
      'runtime_review_attempt_v2_insert',
      'runtime_review_attempt_v2_update',
      'runtime_review_barrier_v2_update'
    ) ORDER BY name`).all() as Array<{ sql: string }>;
  const v2TriggerSql = preservedV2Triggers.length === 3
    ? preservedV2Triggers.map(({ sql }) => sql).join(";\n")
    : v2Triggers;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE runtime_schema_capabilities(
      capability TEXT PRIMARY KEY,capability_version INTEGER NOT NULL CHECK(capability_version>0));`);
    faultInjector?.("after_v4_capability_table");
    db.exec(`
      DROP TRIGGER IF EXISTS runtime_review_attempt_v2_insert;
      DROP TRIGGER IF EXISTS runtime_review_attempt_v2_update;
      DROP TRIGGER IF EXISTS runtime_review_barrier_v2_update;
      DROP INDEX IF EXISTS runtime_review_lanes_status;
      DROP INDEX IF EXISTS runtime_review_attempts_lane;
      ALTER TABLE runtime_review_lane_attempts RENAME TO runtime_review_lane_attempts_v2_old;
      ALTER TABLE runtime_review_lanes RENAME TO runtime_review_lanes_v2_old;
      ALTER TABLE runtime_review_barriers RENAME TO runtime_review_barriers_v2_old;

      CREATE TABLE runtime_review_barriers(
        review_id TEXT PRIMARY KEY,stage_id TEXT NOT NULL,artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL,approval_scope TEXT NOT NULL CHECK(approval_scope='workspace-read'),
        idempotency_key TEXT NOT NULL,run_state TEXT NOT NULL
          CHECK(run_state IN('FULL_CROSS_PROVIDER','DEGRADED_REVIEW_SET')),
        created_at INTEGER NOT NULL,project TEXT,
        requester TEXT CHECK(requester IS NULL OR requester IN('grok','codex')),
        source_fingerprint TEXT,changed_files INTEGER NOT NULL DEFAULT 0 CHECK(changed_files>=0),
        launch_authority_version INTEGER NOT NULL DEFAULT 1 CHECK(launch_authority_version IN(1,2,3)));
      INSERT INTO runtime_review_barriers SELECT * FROM runtime_review_barriers_v2_old;

      CREATE TABLE runtime_review_lanes(
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK(agent IN('grok','claude','codex')),
        role TEXT NOT NULL CHECK(role IN('auditor','critic')),
        status TEXT NOT NULL CHECK(status IN('queued','deferred','completed','failed','timed_out',
          'stale_artifact','needs_reconciliation')),
        model TEXT NOT NULL CHECK(model IN('grok-4.6','glm-5.3','gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK(effort IN('high','xhigh','max')),
        policy_version TEXT NOT NULL CHECK(policy_version = 'routing-v5'),reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK(degraded IN(0,1)),result TEXT,error TEXT,terminal_at INTEGER,
        lane_revision INTEGER NOT NULL DEFAULT 0 CHECK(lane_revision>=0),PRIMARY KEY(review_id,agent,role));
      INSERT INTO runtime_review_lanes
        (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
         idempotency_key,prompt,degraded,result,error,terminal_at)
      SELECT review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
        idempotency_key,prompt,degraded,result,error,terminal_at FROM runtime_review_lanes_v2_old;

      CREATE TABLE runtime_review_lane_attempts(
        review_id TEXT NOT NULL,agent TEXT NOT NULL CHECK(agent IN('grok','claude','codex')),
        role TEXT NOT NULL CHECK(role IN('auditor','critic')),
        attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal>=0),
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),created_at INTEGER NOT NULL,
        attempt_id TEXT UNIQUE,authority_id TEXT,base_policy_id TEXT,authority_kind TEXT,
        model TEXT,effort TEXT,policy_version TEXT,reasons_json TEXT,session_id TEXT,idempotency_key TEXT,
        recovery_generation INTEGER,previous_ordinal INTEGER,previous_evidence_hash TEXT,
        expected_lane_revision INTEGER,expected_attempt_ordinal INTEGER,authority_receipt_id TEXT,
        PRIMARY KEY(review_id,agent,role,attempt_ordinal),
        FOREIGN KEY(review_id,agent,role) REFERENCES runtime_review_lanes(review_id,agent,role) ON DELETE CASCADE,
        CHECK((attempt_id IS NULL AND authority_id IS NULL AND base_policy_id IS NULL
          AND authority_kind IS NULL AND model IS NULL AND effort IS NULL AND policy_version IS NULL
          AND reasons_json IS NULL AND session_id IS NULL AND idempotency_key IS NULL
          AND recovery_generation IS NULL AND previous_ordinal IS NULL AND previous_evidence_hash IS NULL
          AND expected_lane_revision IS NULL AND expected_attempt_ordinal IS NULL
          AND authority_receipt_id IS NULL) OR
          (attempt_id IS NOT NULL AND authority_id IS NOT NULL AND base_policy_id IS NOT NULL
          AND authority_kind IS NOT NULL AND model IS NOT NULL AND effort IS NOT NULL
          AND policy_version IS NOT NULL AND reasons_json IS NOT NULL AND session_id IS NOT NULL
          AND idempotency_key IS NOT NULL AND expected_lane_revision IS NOT NULL
          AND expected_attempt_ordinal IS NOT NULL AND authority_receipt_id IS NOT NULL AND (
            (authority_kind = 'initial' AND attempt_ordinal = 0 AND recovery_generation IS NULL
             AND previous_ordinal IS NULL AND previous_evidence_hash IS NULL) OR
            (authority_kind = 'first_admission' AND attempt_ordinal = 0 AND recovery_generation IS NOT NULL
             AND previous_ordinal IS NULL AND previous_evidence_hash IS NULL) OR
            (authority_kind = 'recovery' AND attempt_ordinal > 0 AND recovery_generation IS NOT NULL
             AND previous_ordinal = attempt_ordinal - 1 AND previous_evidence_hash IS NOT NULL)))));
      INSERT INTO runtime_review_lane_attempts(review_id,agent,role,attempt_ordinal,run_id,created_at)
        SELECT review_id,agent,role,attempt_ordinal,run_id,created_at
        FROM runtime_review_lane_attempts_v2_old;
      DROP TABLE runtime_review_lane_attempts_v2_old;
      DROP TABLE runtime_review_lanes_v2_old;
      DROP TABLE runtime_review_barriers_v2_old;
      CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id,status);
      CREATE INDEX runtime_review_attempts_lane
        ON runtime_review_lane_attempts(review_id,agent,role,attempt_ordinal);
      CREATE TRIGGER runtime_review_barrier_authority_version_immutable
      BEFORE UPDATE OF launch_authority_version ON runtime_review_barriers
      BEGIN SELECT RAISE(ABORT,'launch authority version is immutable'); END;

      CREATE TABLE runtime_provider_recovery_generations(
        agent TEXT NOT NULL CHECK(agent IN('grok','claude','codex')),
        generation INTEGER NOT NULL CHECK(generation>0),probe_claim_id TEXT NOT NULL,
        probe_claimed_at INTEGER NOT NULL,verified_at INTEGER NOT NULL,
        PRIMARY KEY(agent,generation),UNIQUE(agent,probe_claim_id),UNIQUE(agent,probe_claimed_at));
      CREATE TRIGGER runtime_provider_recovery_generation_update_immutable
        BEFORE UPDATE ON runtime_provider_recovery_generations
        BEGIN SELECT RAISE(ABORT,'provider recovery generation is immutable'); END;
      CREATE TRIGGER runtime_provider_recovery_generation_delete_immutable
        BEFORE DELETE ON runtime_provider_recovery_generations
        BEGIN SELECT RAISE(ABORT,'provider recovery generation is immutable'); END;
      CREATE TABLE runtime_review_attempt_base_policies(
        base_policy_id TEXT PRIMARY KEY,review_id TEXT NOT NULL,agent TEXT NOT NULL,role TEXT NOT NULL,
        model TEXT NOT NULL,effort TEXT NOT NULL,policy_version TEXT NOT NULL,reasons_json TEXT NOT NULL,
        legacy_session_id TEXT NOT NULL,legacy_idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,UNIQUE(review_id,agent,role));
      CREATE TRIGGER runtime_review_base_policy_update_immutable
        BEFORE UPDATE ON runtime_review_attempt_base_policies
        BEGIN SELECT RAISE(ABORT,'review base policy is immutable'); END;
      CREATE TRIGGER runtime_review_base_policy_delete_immutable
        BEFORE DELETE ON runtime_review_attempt_base_policies
        BEGIN SELECT RAISE(ABORT,'review base policy is immutable'); END;
      CREATE TABLE runtime_review_receipts(
        receipt_id TEXT PRIMARY KEY,phase TEXT NOT NULL CHECK(phase IN('admission','prelaunch')),
        scope TEXT NOT NULL,scope_revision INTEGER NOT NULL CHECK(scope_revision>0),
        activation_nonce TEXT NOT NULL,expected_tuple_json TEXT NOT NULL,recovery_generation INTEGER,
        observation_json TEXT NOT NULL,observation_hash TEXT NOT NULL,predecessor_receipt_id TEXT,
        canonical_bytes TEXT NOT NULL,envelope_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE runtime_review_receipt_heads(
        scope TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,
        scope_revision INTEGER NOT NULL,activation_nonce TEXT NOT NULL);
      CREATE TABLE runtime_review_receipt_lifecycle(
        receipt_id TEXT PRIMARY KEY REFERENCES runtime_review_receipts(receipt_id),
        state TEXT NOT NULL CHECK(state IN('consumed','superseded','orphaned')),
        scope_revision INTEGER NOT NULL,activation_nonce TEXT NOT NULL,expected_tuple_json TEXT NOT NULL,
        recovery_generation INTEGER,predecessor_receipt_id TEXT,recorded_at INTEGER NOT NULL);
      CREATE TRIGGER runtime_review_receipt_update_immutable BEFORE UPDATE ON runtime_review_receipts
        BEGIN SELECT RAISE(ABORT,'review receipt is immutable'); END;
      CREATE TRIGGER runtime_review_receipt_delete_immutable BEFORE DELETE ON runtime_review_receipts
        BEGIN SELECT RAISE(ABORT,'review receipt is immutable'); END;
      CREATE TRIGGER runtime_review_receipt_lifecycle_update_immutable
        BEFORE UPDATE ON runtime_review_receipt_lifecycle
        BEGIN SELECT RAISE(ABORT,'review receipt lifecycle is immutable'); END;
      CREATE TRIGGER runtime_review_receipt_lifecycle_delete_immutable
        BEFORE DELETE ON runtime_review_receipt_lifecycle
        BEGIN SELECT RAISE(ABORT,'review receipt lifecycle is immutable'); END;
      CREATE TABLE runtime_review_attempt_authorities(
        authority_id TEXT PRIMARY KEY,review_id TEXT NOT NULL,agent TEXT NOT NULL,role TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,attempt_ordinal INTEGER NOT NULL,authority_kind TEXT NOT NULL,
        recovery_generation INTEGER,previous_ordinal INTEGER,previous_evidence_hash TEXT,
        admission_source_receipt_id TEXT NOT NULL,admission_readiness_receipt_id TEXT NOT NULL,
        activation_nonce TEXT NOT NULL,authority_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
        UNIQUE(review_id,agent,role,attempt_ordinal));
      CREATE TRIGGER runtime_review_authority_update_immutable
        BEFORE UPDATE ON runtime_review_attempt_authorities
        BEGIN SELECT RAISE(ABORT,'review authority is immutable'); END;
      CREATE TRIGGER runtime_review_authority_delete_immutable
        BEFORE DELETE ON runtime_review_attempt_authorities
        BEGIN SELECT RAISE(ABORT,'review authority is immutable'); END;
      CREATE TABLE runtime_review_generation_consumptions(
        generation INTEGER NOT NULL,review_id TEXT NOT NULL,agent TEXT NOT NULL,role TEXT NOT NULL,
        authority_id TEXT,UNIQUE(generation,review_id,agent,role),
        FOREIGN KEY(agent,generation) REFERENCES runtime_provider_recovery_generations(agent,generation));
      CREATE TRIGGER runtime_review_generation_consumption_update_immutable
        BEFORE UPDATE ON runtime_review_generation_consumptions
        BEGIN SELECT RAISE(ABORT,'review generation consumption is immutable'); END;
      CREATE TRIGGER runtime_review_generation_consumption_delete_immutable
        BEFORE DELETE ON runtime_review_generation_consumptions
        BEGIN SELECT RAISE(ABORT,'review generation consumption is immutable'); END;
      CREATE TABLE runtime_review_spawn_authorities(
        attempt_id TEXT PRIMARY KEY,attempt_authority_id TEXT NOT NULL,prelaunch_receipt_id TEXT NOT NULL,
        authority_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE runtime_review_no_spawn_effects(
        attempt_id TEXT PRIMARY KEY,reason TEXT NOT NULL
          CHECK(reason IN('stale_artifact','provider_unavailable','needs_reconciliation')),
        prelaunch_receipt_id TEXT,recorded_at INTEGER NOT NULL);
      CREATE TRIGGER runtime_review_spawn_terminal_xor
        BEFORE INSERT ON runtime_review_spawn_authorities
        WHEN EXISTS(SELECT 1 FROM runtime_review_no_spawn_effects WHERE attempt_id=NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT,'terminal spawn and no-spawn effects are exclusive'); END;
      CREATE TRIGGER runtime_review_no_spawn_terminal_xor
        BEFORE INSERT ON runtime_review_no_spawn_effects
        WHEN EXISTS(SELECT 1 FROM runtime_review_spawn_authorities WHERE attempt_id=NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT,'terminal spawn and no-spawn effects are exclusive'); END;
      CREATE TRIGGER runtime_review_spawn_update_immutable
        BEFORE UPDATE ON runtime_review_spawn_authorities
        BEGIN SELECT RAISE(ABORT,'review spawn authority is immutable'); END;
      CREATE TRIGGER runtime_review_spawn_delete_immutable
        BEFORE DELETE ON runtime_review_spawn_authorities
        BEGIN SELECT RAISE(ABORT,'review spawn authority is immutable'); END;
      CREATE TRIGGER runtime_review_no_spawn_update_immutable
        BEFORE UPDATE ON runtime_review_no_spawn_effects
        BEGIN SELECT RAISE(ABORT,'review no-spawn effect is immutable'); END;
      CREATE TRIGGER runtime_review_no_spawn_delete_immutable
        BEFORE DELETE ON runtime_review_no_spawn_effects
        BEGIN SELECT RAISE(ABORT,'review no-spawn effect is immutable'); END;
      CREATE TRIGGER runtime_review_attempt_update_immutable BEFORE UPDATE ON runtime_review_lane_attempts
        WHEN OLD.attempt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'review attempt is immutable'); END;
      CREATE TRIGGER runtime_review_attempt_delete_immutable BEFORE DELETE ON runtime_review_lane_attempts
        WHEN OLD.attempt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'review attempt is immutable'); END;
    `);
    db.exec(v2TriggerSql);
    faultInjector?.("after_v4_capability_schema");
    const insert = db.prepare(`INSERT INTO runtime_schema_capabilities
      (capability,capability_version) VALUES (?,?)`);
    for (const row of capabilities) insert.run(...row);
    faultInjector?.("before_v4_capability_commit");
    assertReviewV3SchemaSignature(db);
  });
  try {
    migrate.immediate();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}
