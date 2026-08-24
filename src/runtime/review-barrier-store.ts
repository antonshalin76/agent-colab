import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createReviewPlan,
  reviewDecisionFor,
  type ReviewRole,
} from "../domain/review.js";
import { ROUTING_POLICY_VERSION } from "../domain/routing.js";
import type {
  AgentId,
  ApprovalScope,
  EffortDecision,
  EffortReason,
  ProviderHealthSnapshot,
} from "../domain/routing.js";
import { sanitizeResult } from "../security/redaction.js";
import type { ProviderHealthStore } from "./provider-health-store.js";

export type ReviewLaneStatus =
  | "queued"
  | "deferred"
  | "completed"
  | "failed"
  | "timed_out"
  | "stale_artifact";
export type ReviewTerminalStatus = "completed" | "failed" | "timed_out";
export type ReviewRunState = "FULL_CROSS_PROVIDER" | "DEGRADED_SINGLE_PROVIDER";
export type PersistedRoutingPolicyVersion = "routing-v2" | typeof ROUTING_POLICY_VERSION;

export interface ReviewLaneSnapshot {
  agent: AgentId;
  role: ReviewRole;
  status: ReviewLaneStatus;
  model: EffortDecision["model"];
  effort: "high" | "xhigh";
  policyVersion: PersistedRoutingPolicyVersion;
  reasons: readonly EffortReason[];
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  degraded: boolean;
  result?: unknown;
  error?: unknown;
  terminalAt: number | null;
  attempts: ReviewAttemptSnapshot[];
}

export interface ReviewAttemptSnapshot {
  attemptId: string;
  attemptOrdinal: number;
  status: "scheduled" | "completed" | "provider_unavailable" | "failed" | "timed_out" | "needs_reconciliation";
  model: EffortDecision["model"];
  effort: "high" | "xhigh";
  policyVersion: PersistedRoutingPolicyVersion;
  reasons: readonly EffortReason[];
  sessionId: string;
  idempotencyKey: string;
  result?: unknown;
  error?: unknown;
  createdAt: number;
  terminalAt: number | null;
}

export interface ReviewBarrierSnapshot {
  reviewId: string;
  stageId: string;
  artifact: Buffer;
  artifactHash: string;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  runState: ReviewRunState;
  createdAt: number;
  lanes: ReviewLaneSnapshot[];
  project?: string | undefined;
  requester?: AgentId | undefined;
  sourceFingerprint?: string | undefined;
  changedFiles: number;
}

export interface LaneEnqueueDescriptor {
  reviewId: string;
  stageId: string;
  agent: AgentId;
  role: ReviewRole;
  artifact: Buffer;
  artifactHash: string;
  approvalScope: ApprovalScope;
  model: EffortDecision["model"];
  effort: "high" | "xhigh";
  policyVersion: EffortDecision["policyVersion"];
  reasons: readonly EffortReason[];
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  degraded: boolean;
  attemptId: string;
  attemptOrdinal: number;
  project?: string | undefined;
  requester?: AgentId | undefined;
  sourceFingerprint?: string | undefined;
}

interface ReviewRow {
  review_id: string;
  stage_id: string;
  artifact: Buffer;
  artifact_hash: string;
  approval_scope: ApprovalScope;
  idempotency_key: string;
  run_state: ReviewRunState;
  created_at: number;
  project: string | null;
  requester: AgentId | null;
  source_fingerprint: string | null;
  changed_files: number;
}

interface LaneRow {
  review_id: string;
  agent: AgentId;
  role: ReviewRole;
  status: ReviewLaneStatus;
  model: EffortDecision["model"];
  effort: "high" | "xhigh";
  policy_version: PersistedRoutingPolicyVersion;
  reasons: string;
  session_id: string;
  idempotency_key: string;
  prompt: string;
  degraded: 0 | 1;
  result: string | null;
  error: string | null;
  terminal_at: number | null;
}

interface AttemptRow {
  review_id: string;
  agent: AgentId;
  role: ReviewRole;
  attempt_ordinal: number;
  attempt_id: string;
  status: ReviewAttemptSnapshot["status"];
  model: EffortDecision["model"];
  effort: "high" | "xhigh";
  policy_version: PersistedRoutingPolicyVersion;
  reasons: string;
  session_id: string;
  idempotency_key: string;
  result: string | null;
  error: string | null;
  created_at: number;
  terminal_at: number | null;
}

export interface CreateReviewBarrierInput {
  reviewId: string;
  stageId: string;
  artifact: Buffer;
  health: ProviderHealthSnapshot;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  prompts: Record<ReviewRole, string>;
  createdAt: number;
  project?: string;
  requester?: AgentId;
  sourceFingerprint?: string;
  changedFiles?: number;
}

interface RecordTerminalInput {
  reviewId: string;
  agent: AgentId;
  role: ReviewRole;
  attemptId: string;
  status: ReviewTerminalStatus;
  result?: unknown;
  error?: unknown;
  terminalAt: number;
}

const TERMINAL: ReadonlySet<ReviewLaneStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
  "stale_artifact",
]);

const parseJson = (value: string | null): unknown | undefined =>
  value === null ? undefined : JSON.parse(value);

const parseReasons = (value: string): readonly EffortReason[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((reason) => typeof reason === "string")) {
    throw new Error("Invalid persisted review decision reasons");
  }
  return parsed as EffortReason[];
};

const tableSchema = (db: Database.Database, table: string): string => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string } | undefined;
  return row?.sql.toLowerCase() ?? "";
};

const assertDatabaseIntegrity = (db: Database.Database): void => {
  const quick = db.pragma("quick_check") as Array<Record<string, unknown>>;
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
    throw new Error("review database integrity check failed");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new Error("review database foreign key check failed");
};

const migrateRoutingV2ReviewSchema = (db: Database.Database): void => {
  const lanes = tableSchema(db, "runtime_review_lanes");
  if (!lanes.includes("'routing-v2'") || lanes.includes("'routing-v3'")) return;
  assertDatabaseIntegrity(db);
  db.pragma("foreign_keys = OFF");
  try {
    const migrate = db.transaction(() => {
      db.exec(`
      CREATE TABLE runtime_review_lanes_v3 (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
        policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT,
        error TEXT,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      INSERT INTO runtime_review_lanes_v3
        SELECT * FROM runtime_review_lanes;
      CREATE TABLE runtime_review_lane_attempts_v3 (
        review_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
        attempt_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'provider_unavailable', 'failed', 'timed_out', 'needs_reconciliation')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
        policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role, attempt_ordinal),
        FOREIGN KEY (review_id, agent, role)
          REFERENCES runtime_review_lanes_v3(review_id, agent, role) ON DELETE CASCADE
      );
      INSERT INTO runtime_review_lane_attempts_v3
        SELECT * FROM runtime_review_lane_attempts;
      UPDATE runtime_review_lane_attempts_v3
         SET status = 'needs_reconciliation',
             error = COALESCE(error, '{"kind":"routing_policy_migration","from":"routing-v2"}'),
             terminal_at = COALESCE(terminal_at, 0)
       WHERE policy_version = 'routing-v2' AND status = 'scheduled';
      UPDATE runtime_review_lanes_v3
         SET status = 'failed',
             error = COALESCE(error, '{"kind":"routing_policy_migration","from":"routing-v2"}'),
             terminal_at = COALESCE(terminal_at, 0)
       WHERE policy_version = 'routing-v2' AND status IN ('queued', 'deferred');
      DROP INDEX IF EXISTS runtime_review_attempts_status;
      DROP INDEX IF EXISTS runtime_review_lanes_status;
      DROP TABLE runtime_review_lane_attempts;
      DROP TABLE runtime_review_lanes;
      ALTER TABLE runtime_review_lanes_v3 RENAME TO runtime_review_lanes;
      ALTER TABLE runtime_review_lane_attempts_v3 RENAME TO runtime_review_lane_attempts;
      CREATE INDEX runtime_review_lanes_status
        ON runtime_review_lanes(review_id, status);
      CREATE INDEX runtime_review_attempts_status
        ON runtime_review_lane_attempts(review_id, agent, role, status);
      `);
      assertDatabaseIntegrity(db);
    });
    migrate.immediate();
  } catch (error) {
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
  assertDatabaseIntegrity(db);
};

const assertFreshV3Schema = (db: Database.Database): void => {
  const schema = (table: string): string => {
    return tableSchema(db, table);
  };
  const barriers = schema("runtime_review_barriers");
  const lanes = schema("runtime_review_lanes");
  const attempts = schema("runtime_review_lane_attempts");
  if (
    !barriers.includes("'grok'") ||
    barriers.includes("'claude'") ||
    !lanes.includes("'grok'") ||
    lanes.includes("'claude'") ||
    !lanes.includes("policy_version") ||
    !lanes.includes("'routing-v3'") ||
    !lanes.includes("reasons") ||
    !attempts.includes("attempt_ordinal") ||
    !attempts.includes("policy_version")
  ) {
    throw new Error("runtime review tables require offline v1-to-v3 migration");
  }
};

const attemptSnapshot = (row: AttemptRow): ReviewAttemptSnapshot => ({
  attemptId: row.attempt_id,
  attemptOrdinal: row.attempt_ordinal,
  status: row.status,
  model: row.model,
  effort: row.effort,
  policyVersion: row.policy_version,
  reasons: parseReasons(row.reasons),
  sessionId: row.session_id,
  idempotencyKey: row.idempotency_key,
  ...(row.result === null ? {} : { result: parseJson(row.result) }),
  ...(row.error === null ? {} : { error: parseJson(row.error) }),
  createdAt: row.created_at,
  terminalAt: row.terminal_at,
});

const laneSnapshot = (row: LaneRow, attempts: ReviewAttemptSnapshot[] = []): ReviewLaneSnapshot => ({
  agent: row.agent,
  role: row.role,
  status: row.status,
  model: row.model,
  effort: row.effort,
  policyVersion: row.policy_version,
  reasons: parseReasons(row.reasons),
  sessionId: row.session_id,
  idempotencyKey: row.idempotency_key,
  prompt: row.prompt,
  degraded: row.degraded === 1,
  ...(row.result === null ? {} : { result: parseJson(row.result) }),
  ...(row.error === null ? {} : { error: parseJson(row.error) }),
  terminalAt: row.terminal_at,
  attempts,
});

export class ReviewBarrierStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    const existing = this.db.prepare(`
      SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name IN ('runtime_review_barriers', 'runtime_review_lanes')
       LIMIT 1
    `).get();
    if (existing !== undefined) {
      try {
        assertDatabaseIntegrity(this.db);
        migrateRoutingV2ReviewSchema(this.db);
        assertFreshV3Schema(this.db);
        assertDatabaseIntegrity(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_review_barriers (
        review_id TEXT PRIMARY KEY,
        stage_id TEXT NOT NULL,
        artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL,
        approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
        idempotency_key TEXT NOT NULL,
        run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_SINGLE_PROVIDER')),
        created_at INTEGER NOT NULL,
        project TEXT,
        requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
        source_fingerprint TEXT
        ,changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0)
      );
      CREATE TABLE IF NOT EXISTS runtime_review_lanes (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
        policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT,
        error TEXT,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      CREATE INDEX IF NOT EXISTS runtime_review_lanes_status
        ON runtime_review_lanes(review_id, status);
      CREATE TABLE IF NOT EXISTS runtime_review_lane_attempts (
        review_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
        attempt_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'provider_unavailable', 'failed', 'timed_out', 'needs_reconciliation')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
        policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role, attempt_ordinal),
        FOREIGN KEY (review_id, agent, role)
          REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS runtime_review_attempts_status
        ON runtime_review_lane_attempts(review_id, agent, role, status);
    `);
    try {
      assertFreshV3Schema(this.db);
      assertDatabaseIntegrity(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private reviewRow(reviewId: string): ReviewRow | undefined {
    return this.db.prepare(`
      SELECT review_id, stage_id, artifact, artifact_hash, approval_scope,
             idempotency_key, run_state, created_at, project, requester, source_fingerprint, changed_files
        FROM runtime_review_barriers
       WHERE review_id = ?
    `).get(reviewId) as ReviewRow | undefined;
  }

  private laneRows(reviewId: string): LaneRow[] {
    return this.db.prepare(`
      SELECT review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
             idempotency_key, prompt, degraded, result, error, terminal_at
        FROM runtime_review_lanes
       WHERE review_id = ?
       ORDER BY CASE agent WHEN 'grok' THEN 0 ELSE 1 END,
                CASE role WHEN 'auditor' THEN 0 ELSE 1 END
    `).all(reviewId) as LaneRow[];
  }

  private attemptRows(reviewId: string, agent?: AgentId, role?: ReviewRole): AttemptRow[] {
    return this.db.prepare(`
      SELECT review_id,agent,role,attempt_ordinal,attempt_id,status,model,effort,policy_version,
             reasons,session_id,idempotency_key,result,error,created_at,terminal_at
        FROM runtime_review_lane_attempts
       WHERE review_id=? AND (? IS NULL OR agent=?) AND (? IS NULL OR role=?)
       ORDER BY agent,role,attempt_ordinal
    `).all(reviewId, agent ?? null, agent ?? null, role ?? null, role ?? null) as AttemptRow[];
  }

  private snapshot(row: ReviewRow): ReviewBarrierSnapshot {
    return {
      reviewId: row.review_id,
      stageId: row.stage_id,
      artifact: Buffer.from(row.artifact),
      artifactHash: row.artifact_hash,
      approvalScope: row.approval_scope,
      idempotencyKey: row.idempotency_key,
      runState: row.run_state,
      createdAt: row.created_at,
      lanes: this.laneRows(row.review_id).map((lane) => laneSnapshot(
        lane,
        this.attemptRows(row.review_id, lane.agent, lane.role).map(attemptSnapshot),
      )),
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.requester === null ? {} : { requester: row.requester }),
      ...(row.source_fingerprint === null ? {} : { sourceFingerprint: row.source_fingerprint }),
      changedFiles: row.changed_files,
    };
  }

  get(reviewId: string): ReviewBarrierSnapshot | null {
    const row = this.reviewRow(reviewId);
    return row === undefined ? null : this.snapshot(row);
  }

  create(input: CreateReviewBarrierInput): ReviewBarrierSnapshot {
    const artifact = Buffer.from(input.artifact);
    const artifactHash = createHash("sha256").update(artifact).digest("hex");
    const create = this.db.transaction(() => {
      const existing = this.reviewRow(input.reviewId);
      if (existing !== undefined) {
        const snapshot = this.snapshot(existing);
        const promptsMatch = snapshot.lanes.every(
          (lane) => lane.prompt === input.prompts[lane.role],
        );
        if (
          existing.stage_id !== input.stageId ||
          existing.artifact_hash !== artifactHash ||
          existing.approval_scope !== input.approvalScope ||
          existing.idempotency_key !== input.idempotencyKey ||
          (existing.project ?? undefined) !== input.project ||
          (existing.requester ?? undefined) !== input.requester ||
          (existing.source_fingerprint ?? undefined) !== input.sourceFingerprint ||
          existing.changed_files !== (input.changedFiles ?? 0) ||
          !promptsMatch
        ) {
          throw new Error(`Immutable review conflict: ${input.reviewId}`);
        }
        return snapshot;
      }

      const plan = createReviewPlan({
        stageId: input.stageId,
        artifact,
        health: input.health,
        approvalScope: input.approvalScope,
        idempotencyKey: input.idempotencyKey,
        prompts: input.prompts,
        changedFiles: input.changedFiles ?? 0,
      });
      this.db.prepare(`
        INSERT INTO runtime_review_barriers
          (review_id, stage_id, artifact, artifact_hash, approval_scope,
           idempotency_key, run_state, created_at, project, requester, source_fingerprint, changed_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.reviewId,
        input.stageId,
        artifact,
        artifactHash,
        input.approvalScope,
        input.idempotencyKey,
        plan.runState,
        input.createdAt,
        input.project ?? null,
        input.requester ?? null,
        input.sourceFingerprint ?? null,
        input.changedFiles ?? 0,
      );

      const activeKeys = new Set(plan.activeLanes.map((lane) => lane.idempotencyKey));
      const insertLane = this.db.prepare(`
        INSERT INTO runtime_review_lanes
          (review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
           idempotency_key, prompt, degraded, result, error, terminal_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `);
      const insertAttempt = this.db.prepare(`
        INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,attempt_id,status,model,effort,policy_version,
           reasons,session_id,idempotency_key,result,error,created_at,terminal_at)
        VALUES (?,?,?,?,?,'scheduled',?,?,?,?,?,?,NULL,NULL,?,NULL)
      `);
      for (const lane of [...plan.activeLanes, ...plan.deferredLanes]) {
        const active = activeKeys.has(lane.idempotencyKey);
        insertLane.run(
          input.reviewId,
          lane.agent,
          lane.role,
          active ? "queued" : "deferred",
          lane.model,
          lane.effort,
          lane.policyVersion,
          JSON.stringify(lane.reasons),
          lane.sessionId,
          lane.idempotencyKey,
          lane.prompt,
          lane.degraded ? 1 : 0,
        );
        if (active) {
          insertAttempt.run(
            input.reviewId,
            lane.agent,
            lane.role,
            0,
            randomUUID(),
            lane.model,
            lane.effort,
            lane.policyVersion,
            JSON.stringify(lane.reasons),
            lane.sessionId,
            lane.idempotencyKey,
            input.createdAt,
          );
        }
      }
      const created = this.reviewRow(input.reviewId);
      if (created === undefined) throw new Error("Review barrier was not persisted");
      return this.snapshot(created);
    });
    return create.immediate();
  }

  private descriptor(review: ReviewRow, lane: ReviewLaneSnapshot): LaneEnqueueDescriptor {
    const attempt = lane.attempts.at(-1);
    if (!attempt || attempt.status !== "scheduled") {
      throw new Error("Review lane has no scheduled attempt");
    }
    if (attempt.policyVersion !== ROUTING_POLICY_VERSION) {
      throw new Error("Historical review attempt requires reconciliation before enqueue");
    }
    return {
      reviewId: review.review_id,
      stageId: review.stage_id,
      agent: lane.agent,
      role: lane.role,
      artifact: Buffer.from(review.artifact),
      artifactHash: review.artifact_hash,
      approvalScope: review.approval_scope,
      model: attempt.model,
      effort: attempt.effort,
      policyVersion: attempt.policyVersion,
      reasons: attempt.reasons,
      sessionId: attempt.sessionId,
      idempotencyKey: attempt.idempotencyKey,
      prompt: lane.prompt,
      degraded: lane.degraded,
      attemptId: attempt.attemptId,
      attemptOrdinal: attempt.attemptOrdinal,
      ...(review.project === null ? {} : { project: review.project }),
      ...(review.requester === null ? {} : { requester: review.requester }),
      ...(review.source_fingerprint === null ? {} : { sourceFingerprint: review.source_fingerprint }),
    };
  }

  enqueueDescriptors(reviewId: string): LaneEnqueueDescriptor[] {
    const review = this.reviewRow(reviewId);
    if (review === undefined) throw new Error(`Unknown review: ${reviewId}`);
    return this.snapshot(review).lanes
      .filter((lane) => lane.status === "queued")
      .map((lane) => this.descriptor(review, lane));
  }

  recordTerminal(input: RecordTerminalInput): ReviewLaneSnapshot {
    const result = input.result === undefined
      ? null
      : JSON.stringify(sanitizeResult(input.result));
    const error = input.error === undefined
      ? null
      : JSON.stringify(sanitizeResult(input.error));
    const update = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
               idempotency_key, prompt, degraded, result, error, terminal_at
          FROM runtime_review_lanes
         WHERE review_id = ? AND agent = ? AND role = ?
      `).get(input.reviewId, input.agent, input.role) as LaneRow | undefined;
      if (existing === undefined) throw new Error("Unknown review lane");
      const attempts = this.attemptRows(input.reviewId, input.agent, input.role);
      const activeAttempt = attempts.at(-1);
      if (!activeAttempt || activeAttempt.attempt_id !== input.attemptId) {
        throw new Error("Review result does not match the active attempt");
      }
      if (TERMINAL.has(existing.status)) {
        if (
          existing.status !== input.status ||
          existing.result !== result ||
          existing.error !== error ||
          existing.terminal_at !== input.terminalAt
        ) {
          throw new Error("Review lane terminal state conflict");
        }
        return laneSnapshot(existing);
      }
      if (existing.status !== "queued") throw new Error("Deferred review lane is not active");
      if (activeAttempt.status !== "scheduled") {
        throw new Error("Review result does not match the active attempt");
      }
      const changed = this.db.prepare(`
        UPDATE runtime_review_lanes
           SET status = ?, result = ?, error = ?, terminal_at = ?
         WHERE review_id = ? AND agent = ? AND role = ? AND status = 'queued'
      `).run(
        input.status,
        result,
        error,
        input.terminalAt,
        input.reviewId,
        input.agent,
        input.role,
      ).changes;
      if (changed !== 1) throw new Error("Review lane terminal CAS failed");
      this.db.prepare(`UPDATE runtime_review_lane_attempts
        SET status=?,result=?,error=?,terminal_at=?
        WHERE attempt_id=? AND status='scheduled'`).run(
          input.status, result, error, input.terminalAt, input.attemptId,
        );
      const updated = this.db.prepare(`
        SELECT review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
               idempotency_key, prompt, degraded, result, error, terminal_at
          FROM runtime_review_lanes
         WHERE review_id = ? AND agent = ? AND role = ?
      `).get(input.reviewId, input.agent, input.role) as LaneRow;
      return laneSnapshot(updated, this.attemptRows(input.reviewId, input.agent, input.role).map(attemptSnapshot));
    });
    return update.immediate();
  }

  recordProviderUnavailable(input: {
    reviewId: string;
    agent: AgentId;
    role: ReviewRole;
    attemptId: string;
    error: unknown;
    terminalAt: number;
  }): ReviewLaneSnapshot {
    const error = JSON.stringify(sanitizeResult(input.error));
    return this.db.transaction(() => {
      const lane = this.laneRows(input.reviewId).find(
        (candidate) => candidate.agent === input.agent && candidate.role === input.role,
      );
      if (!lane) throw new Error("Unknown review lane");
      const attempt = this.attemptRows(input.reviewId, input.agent, input.role)
        .find((candidate) => candidate.attempt_id === input.attemptId);
      if (!attempt) throw new Error("Unknown review attempt");
      if (attempt.status === "provider_unavailable") {
        return laneSnapshot(lane, this.attemptRows(input.reviewId, input.agent, input.role).map(attemptSnapshot));
      }
      if (lane.status !== "queued" || attempt.status !== "scheduled") {
        throw new Error("Review attempt is not active");
      }
      const changed = this.db.prepare(`UPDATE runtime_review_lane_attempts
        SET status='provider_unavailable',error=?,terminal_at=?
        WHERE attempt_id=? AND status='scheduled'`).run(error, input.terminalAt, input.attemptId).changes;
      if (changed !== 1) throw new Error("Review attempt terminal CAS failed");
      this.db.prepare(`UPDATE runtime_review_lanes
        SET status='deferred',result=NULL,error=NULL,terminal_at=NULL
        WHERE review_id=? AND agent=? AND role=? AND status='queued'`)
        .run(input.reviewId, input.agent, input.role);
      const updated = this.laneRows(input.reviewId).find(
        (candidate) => candidate.agent === input.agent && candidate.role === input.role,
      )!;
      return laneSnapshot(updated, this.attemptRows(input.reviewId, input.agent, input.role).map(attemptSnapshot));
    }).immediate();
  }

  attempts(reviewId: string, agent: AgentId, role: ReviewRole): ReviewAttemptSnapshot[] {
    return this.attemptRows(reviewId, agent, role).map(attemptSnapshot);
  }

  markAttemptNeedsReconciliation(input: {
    reviewId: string;
    agent: AgentId;
    role: ReviewRole;
    attemptId: string;
    at: number;
  }): ReviewAttemptSnapshot {
    const changed = this.db.prepare(`UPDATE runtime_review_lane_attempts
      SET status='needs_reconciliation',terminal_at=?
      WHERE review_id=? AND agent=? AND role=? AND attempt_id=? AND status='scheduled'`).run(
        input.at, input.reviewId, input.agent, input.role, input.attemptId,
      ).changes;
    const attempt = this.attemptRows(input.reviewId, input.agent, input.role)
      .find((row) => row.attempt_id === input.attemptId);
    if (!attempt || (changed !== 1 && attempt.status !== "needs_reconciliation")) {
      throw new Error("review attempt cannot enter reconciliation");
    }
    return attemptSnapshot(attempt);
  }

  resolveAttemptReconciliation(input: {
    reviewId: string;
    agent: AgentId;
    role: ReviewRole;
    attemptId: string;
    status: "completed" | "failed";
    evidence: unknown;
    at: number;
  }): ReviewLaneSnapshot {
    const encoded = JSON.stringify(sanitizeResult(input.evidence));
    return this.db.transaction(() => {
      const latest = this.attemptRows(input.reviewId, input.agent, input.role).at(-1);
      if (!latest || latest.attempt_id !== input.attemptId || latest.status !== "needs_reconciliation") {
        throw new Error("review attempt is not awaiting reconciliation");
      }
      const result = input.status === "completed" ? encoded : null;
      const error = input.status === "failed" ? encoded : null;
      const attemptChanged = this.db.prepare(`UPDATE runtime_review_lane_attempts
        SET status=?,result=?,error=?,terminal_at=?
        WHERE attempt_id=? AND status='needs_reconciliation'`).run(
          input.status, result, error, input.at, input.attemptId,
        ).changes;
      const laneChanged = this.db.prepare(`UPDATE runtime_review_lanes
        SET status=?,result=?,error=?,terminal_at=?
        WHERE review_id=? AND agent=? AND role=? AND status='queued'`).run(
          input.status, result, error, input.at, input.reviewId, input.agent, input.role,
        ).changes;
      if (attemptChanged !== 1 || laneChanged !== 1) throw new Error("review reconciliation CAS failed");
      const lane = this.laneRows(input.reviewId).find(
        (row) => row.agent === input.agent && row.role === input.role,
      )!;
      return laneSnapshot(lane, this.attemptRows(input.reviewId, input.agent, input.role).map(attemptSnapshot));
    }).immediate();
  }

  barrier(reviewId: string): { satisfied: boolean; terminalCount: number; requiredCount: number } {
    if (this.reviewRow(reviewId) === undefined) throw new Error(`Unknown review: ${reviewId}`);
    const lanes = this.laneRows(reviewId);
    const terminalCount = lanes.filter((lane) => TERMINAL.has(lane.status)).length;
    return {
      satisfied: lanes.length > 0 && terminalCount === lanes.length,
      terminalCount,
      requiredCount: lanes.length,
    };
  }

  deferredReviewIds(agent: AgentId): string[] {
    return (this.db.prepare(`SELECT DISTINCT review_id FROM runtime_review_lanes
      WHERE agent=? AND status='deferred' ORDER BY review_id`).all(agent) as Array<{ review_id: string }>)
      .map((row) => row.review_id);
  }

  activateDeferred(input: {
    reviewId: string;
    agent: AgentId;
    currentArtifactHash: string;
    currentSourceFingerprint?: string;
    now: number;
    providerHealth: ProviderHealthStore;
  }): {
    status: "activated" | "provider_unavailable" | "stale_artifact" | "none";
    lanes: LaneEnqueueDescriptor[];
  } {
    const review = this.reviewRow(input.reviewId);
    if (review === undefined) throw new Error(`Unknown review: ${input.reviewId}`);
    const deferred = this.laneRows(input.reviewId).filter(
      (lane) => lane.agent === input.agent && lane.status === "deferred",
    );
    if (deferred.length === 0) return { status: "none", lanes: [] };

    if (review.artifact_hash !== input.currentArtifactHash ||
        (review.source_fingerprint !== null && review.source_fingerprint !== input.currentSourceFingerprint)) {
      this.db.prepare(`
        UPDATE runtime_review_lanes
           SET status = 'stale_artifact', terminal_at = ?
         WHERE review_id = ? AND agent = ? AND status = 'deferred'
      `).run(input.now, input.reviewId, input.agent);
      return { status: "stale_artifact", lanes: [] };
    }
    if (!input.providerHealth.isRunnable(input.agent, input.now)) {
      return { status: "provider_unavailable", lanes: [] };
    }

    const activate = this.db.transaction(() => {
      for (const lane of deferred) {
        const attempts = this.attemptRows(input.reviewId, lane.agent, lane.role);
        const latest = attempts.at(-1);
        if (latest?.status === "scheduled") continue;
        const attemptOrdinal = (latest?.attempt_ordinal ?? -1) + 1;
        const decision = reviewDecisionFor(lane.agent, lane.role, {
          attemptOrdinal,
          artifactBytes: review.artifact.length,
          changedFiles: review.changed_files,
        });
        const sessionId = randomUUID();
        const idempotencyKey = attemptOrdinal === 0
          ? lane.idempotency_key
          : `${review.idempotency_key}:${lane.agent}:${lane.role}:attempt:${attemptOrdinal}`;
        this.db.prepare(`INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,attempt_id,status,model,effort,policy_version,
           reasons,session_id,idempotency_key,result,error,created_at,terminal_at)
          VALUES (?,?,?,?,?,'scheduled',?,?,?,?,?,?,NULL,NULL,?,NULL)`).run(
            input.reviewId, lane.agent, lane.role, attemptOrdinal, randomUUID(), decision.model,
            decision.effort, decision.policyVersion, JSON.stringify(decision.reasons), sessionId,
            idempotencyKey, input.now,
          );
        this.db.prepare(`UPDATE runtime_review_lanes
          SET model=?,effort=?,policy_version=?,reasons=?,session_id=?,idempotency_key=?,degraded=1
          WHERE review_id=? AND agent=? AND role=? AND status='deferred'`).run(
            decision.model, decision.effort, decision.policyVersion, JSON.stringify(decision.reasons),
            sessionId, idempotencyKey, input.reviewId, lane.agent, lane.role,
          );
      }
      return this.snapshot(review).lanes
        .filter((lane) => lane.agent === input.agent && lane.status === "deferred")
        .map((lane) => this.descriptor(review, lane));
    });
    return { status: "activated", lanes: activate.immediate() };
  }

  confirmDeferredEnqueued(reviewId: string, agent: AgentId): number {
    return this.db.prepare(`UPDATE runtime_review_lanes SET status='queued'
      WHERE review_id=? AND agent=? AND status='deferred'`).run(reviewId, agent).changes;
  }

  close(): void {
    this.db.close();
  }
}
