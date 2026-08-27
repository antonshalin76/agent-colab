import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  createReviewPlan,
  reviewDecisionFor,
  type ReviewRole,
} from "../domain/review.js";
import {
  REVIEW_VERDICT_OUTPUT_CONTRACT,
  ReviewVerdictEnvelopeSchema,
} from "../domain/review-verdict.js";
import { ROUTING_POLICY_VERSION } from "../domain/routing.js";
import { isFailoverOutcome } from "../domain/outcomes.js";
import type {
  ActiveAgentId,
  ApprovalScope,
  EffortDecision,
  EffortReason,
  ReviewProviderHealthSnapshot,
  ReviewProviderId,
} from "../domain/routing.js";
import { sanitizeResult } from "../security/redaction.js";
import type { ProviderHealthStore } from "./provider-health-store.js";
import { RunStore } from "../store/run-store.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../flow/map-admin.js";

export type ReviewLaneStatus =
  | "queued"
  | "deferred"
  | "completed"
  | "failed"
  | "timed_out"
  | "stale_artifact";
export type ReviewTerminalStatus = "completed" | "failed" | "timed_out";
export type ReviewRunState = "FULL_CROSS_PROVIDER" | "DEGRADED_REVIEW_SET";
export type PersistedRoutingPolicyVersion = typeof ROUTING_POLICY_VERSION;

const isSemanticPass = (lane: LaneRow): boolean => {
  if (lane.status !== "completed") return false;
  let result: unknown;
  try { result = lane.result === null ? null : JSON.parse(lane.result); } catch { return false; }
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  if (value.kind !== "success") return false;
  const verdict = ReviewVerdictEnvelopeSchema.safeParse(value.reviewVerdict);
  return verdict.success && verdict.data.verdict === "PASS" &&
    verdict.data.findings.every(({ risk_level }) => risk_level === "info");
};

export interface ReviewLaneSnapshot {
  agent: ReviewProviderId;
  role: ReviewRole;
  status: ReviewLaneStatus;
  model: EffortDecision["model"];
  effort: "high" | "xhigh" | "max";
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
  effort: "high" | "xhigh" | "max";
  policyVersion: PersistedRoutingPolicyVersion;
  reasons: readonly EffortReason[];
  sessionId: string;
  idempotencyKey: string;
  result?: unknown;
  error?: unknown;
  createdAt: number;
  terminalAt: number | null;
  providerAdmissionClaimedAt?: number | undefined;
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
  requester?: ActiveAgentId | undefined;
  sourceFingerprint?: string | undefined;
  changedFiles: number;
}

export interface LaneEnqueueDescriptor {
  reviewId: string;
  stageId: string;
  agent: ReviewProviderId;
  role: ReviewRole;
  artifact: Buffer;
  artifactHash: string;
  approvalScope: ApprovalScope;
  model: EffortDecision["model"];
  effort: "high" | "xhigh" | "max";
  policyVersion: EffortDecision["policyVersion"];
  reasons: readonly EffortReason[];
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  degraded: boolean;
  attemptId: string;
  attemptOrdinal: number;
  project?: string | undefined;
  requester?: ActiveAgentId | undefined;
  sourceFingerprint?: string | undefined;
  providerAdmissionClaimedAt?: number | undefined;
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
  requester: ActiveAgentId | null;
  source_fingerprint: string | null;
  changed_files: number;
}

interface LaneRow {
  review_id: string;
  agent: ReviewProviderId;
  role: ReviewRole;
  status: ReviewLaneStatus;
  model: EffortDecision["model"];
  effort: "high" | "xhigh" | "max";
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

interface AttemptLinkRow {
  review_id: string;
  agent: ReviewProviderId;
  role: ReviewRole;
  attempt_ordinal: number;
  run_id: string;
  created_at: number;
}

export interface CreateReviewBarrierInput {
  reviewId: string;
  stageId: string;
  artifact: Buffer;
  health: ReviewProviderHealthSnapshot;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  prompts: Record<ReviewRole, string>;
  createdAt: number;
  project?: string;
  requester?: ActiveAgentId;
  sourceFingerprint?: string;
  changedFiles?: number;
}

export interface ExactSemanticPassReviewInput {
  reviewId: string;
  stageId: string;
  artifact: Buffer;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  prompts: Record<ReviewRole, string>;
  project: string;
  requester: ActiveAgentId;
  sourceFingerprint: string;
  changedFiles: number;
}

export const createReviewRunInput = (lane: LaneEnqueueDescriptor) => {
  if (!lane.project || !lane.requester || !lane.sourceFingerprint) {
    throw new Error("review lane lacks exact durable execution context");
  }
  const mapLearning = createCurrentMapLearningLaunchBinding(lane.agent);
  return {
    idempotencyKey: lane.idempotencyKey,
    stage: `review:${lane.role}`,
    priority: 5,
    artifactHash: lane.artifactHash,
    approvalScope: "workspace-read" as const,
    payload: {
      requester: lane.requester,
      preferredAgent: lane.agent,
      project: lane.project,
      prompt: `${lane.prompt}\n\n${REVIEW_VERDICT_OUTPUT_CONTRACT}\n\n${formatMapLearningLaunchBindingContext(
        mapLearning,
      )}\n\nImmutable artifact (${lane.artifactHash}):\n${lane.artifact.toString("utf8")}`,
      approvalScope: "workspace-read" as const,
      allowFallback: false,
      reviewRole: lane.role,
      sourceFingerprint: lane.sourceFingerprint,
      mapLearning,
      decision: {
        agent: lane.agent,
        model: lane.model,
        effort: lane.effort,
        policyVersion: lane.policyVersion,
        reasons: lane.reasons,
      },
      reviewDispatchIdentity: {
        agent: lane.agent,
        model: lane.model,
        effort: lane.effort,
        policyVersion: lane.policyVersion,
        reasons: lane.reasons,
        sessionId: lane.sessionId,
        attemptId: lane.attemptId,
        attemptOrdinal: lane.attemptOrdinal,
        degraded: lane.degraded,
      },
      reviewDispatchId: lane.idempotencyKey,
      reviewId: lane.reviewId,
      sessionId: lane.sessionId,
      artifactHash: lane.artifactHash,
      reviewAttemptId: lane.attemptId,
      reviewAttemptOrdinal: lane.attemptOrdinal,
      ...(lane.providerAdmissionClaimedAt === undefined
        ? {}
        : { providerAdmissionClaimedAt: lane.providerAdmissionClaimedAt }),
    },
  };
};

interface RecordTerminalInput {
  reviewId: string;
  agent: ReviewProviderId;
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

const assertFreshV5Schema = (db: Database.Database): void => {
  const schema = (table: string): string => {
    return tableSchema(db, table);
  };
  const barriers = schema("runtime_review_barriers");
  const lanes = schema("runtime_review_lanes");
  const attempts = schema("runtime_review_lane_attempts");
  if (
    !barriers.includes("requester in ('grok', 'codex')") ||
    barriers.includes("requester in ('grok', 'claude', 'codex')") ||
    !barriers.includes("run_state in ('full_cross_provider', 'degraded_review_set')") ||
    !lanes.includes("agent in ('grok', 'claude', 'codex')") ||
    !lanes.includes("model in ('grok-4.6', 'glm-5.3', 'gpt-5.6-sol')") ||
    !lanes.includes("effort in ('high', 'xhigh', 'max')") ||
    !lanes.includes("policy_version = 'routing-v5'") ||
    !lanes.includes("reasons") ||
    !attempts.includes("agent in ('grok', 'claude', 'codex')") ||
    !attempts.includes("attempt_ordinal") ||
    !attempts.includes("run_id") ||
    attempts.includes("policy_version") ||
    attempts.includes("status text")
  ) {
    throw new Error("runtime review tables require the current routing-v5 schema");
  }
};

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

export class RunGateUnitOfWork {
  private readonly db: Database.Database;
  private readonly runs: RunStore;
  private readonly ownsDatabase: boolean;

  constructor(pathOrDatabase: string | Database.Database) {
    this.ownsDatabase = typeof pathOrDatabase === "string";
    this.db = this.ownsDatabase ? new Database(pathOrDatabase as string) : pathOrDatabase as Database.Database;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    const existing = this.db.prepare(`
      SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name IN ('runtime_review_barriers', 'runtime_review_lanes')
       LIMIT 1
    `).get();
    try {
      if (existing === undefined) throw new Error("review gate requires migration-owned schema");
      assertDatabaseIntegrity(this.db);
      assertFreshV5Schema(this.db);
      assertDatabaseIntegrity(this.db);
      this.runs = new RunStore(this.db);
    } catch (error) {
      if (this.ownsDatabase) this.db.close();
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
       ORDER BY CASE agent WHEN 'grok' THEN 0 WHEN 'claude' THEN 1 ELSE 2 END,
                CASE role WHEN 'auditor' THEN 0 ELSE 1 END
    `).all(reviewId) as LaneRow[];
  }

  private attemptsFor(reviewId: string, agent?: ReviewProviderId, role?: ReviewRole): ReviewAttemptSnapshot[] {
    const links = this.db.prepare(`
      SELECT review_id,agent,role,attempt_ordinal,run_id,created_at
        FROM runtime_review_lane_attempts
       WHERE review_id=? AND (? IS NULL OR agent=?) AND (? IS NULL OR role=?)
       ORDER BY agent,role,attempt_ordinal
    `).all(reviewId, agent ?? null, agent ?? null, role ?? null, role ?? null) as AttemptLinkRow[];
    return links.map((link) => {
      const run = this.runs.get(link.run_id);
      if (!run) throw new Error("review attempt references a missing run");
      const payload = run.payload ?? {};
      const identity = payload.reviewDispatchIdentity as Record<string, unknown> | undefined;
      const decision = payload.decision as Record<string, unknown> | undefined;
      if (!identity || !decision || typeof identity.attemptId !== "string" ||
          typeof identity.sessionId !== "string" || !Array.isArray(decision.reasons)) {
        throw new Error("review attempt run has an invalid immutable identity");
      }
      const envelope = run.result && typeof run.result === "object"
        ? run.result as Record<string, unknown>
        : null;
      const providerResult = envelope?.providerResult && typeof envelope.providerResult === "object"
        ? envelope.providerResult as Record<string, unknown>
        : null;
      const effect = envelope?.effect && typeof envelope.effect === "object"
        ? envelope.effect as Record<string, unknown>
        : null;
      const unavailable = isFailoverOutcome(providerResult?.kind);
      const status: ReviewAttemptSnapshot["status"] = run.status === "needs_reconciliation"
        ? "needs_reconciliation"
        : run.status === "completed"
          ? unavailable ? "provider_unavailable" : "completed"
          : run.status === "failed" || run.status === "cancelled"
            ? "failed"
            : "scheduled";
      const terminalAt = Number.isSafeInteger(effect?.terminalAt) ? Number(effect!.terminalAt) : null;
      return {
        attemptId: identity.attemptId,
        attemptOrdinal: link.attempt_ordinal,
        status,
        model: decision.model as EffortDecision["model"],
        effort: decision.effort as "high" | "xhigh" | "max",
        policyVersion: decision.policyVersion as PersistedRoutingPolicyVersion,
        reasons: decision.reasons as EffortReason[],
        sessionId: identity.sessionId,
        idempotencyKey: run.idempotencyKey,
        ...(status === "completed" && providerResult ? { result: providerResult } : {}),
        ...(status !== "scheduled" && status !== "completed" && providerResult
          ? { error: providerResult }
          : {}),
        createdAt: link.created_at,
        terminalAt,
        ...(typeof payload.providerAdmissionClaimedAt === "number"
          ? { providerAdmissionClaimedAt: payload.providerAdmissionClaimedAt }
          : {}),
      };
    });
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
        this.attemptsFor(row.review_id, lane.agent, lane.role),
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

  private enqueueActiveReviewRuns(row: ReviewRow): void {
    for (const lane of this.snapshot(row).lanes.filter(({ status }) => status === "queued")) {
      const attempt = lane.attempts.at(-1);
      if (attempt?.status === "scheduled") {
        this.runs.enqueueExact(createReviewRunInput(this.descriptorForAttempt(row, lane, attempt)));
      }
    }
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
        this.enqueueActiveReviewRuns(existing);
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
        ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
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
          (review_id,agent,role,attempt_ordinal,run_id,created_at)
        VALUES (?,?,?,?,?,?)
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
          const descriptor: LaneEnqueueDescriptor = {
            reviewId: input.reviewId,
            stageId: input.stageId,
            agent: lane.agent,
            role: lane.role,
            artifact: Buffer.from(artifact),
            artifactHash,
            approvalScope: input.approvalScope,
            model: lane.model,
            effort: lane.effort as "high" | "xhigh" | "max",
            policyVersion: lane.policyVersion,
            reasons: lane.reasons,
            sessionId: lane.sessionId,
            idempotencyKey: lane.idempotencyKey,
            prompt: lane.prompt,
            degraded: lane.degraded,
            attemptId: randomUUID(),
            attemptOrdinal: 0,
            ...(input.project ? { project: input.project } : {}),
            ...(input.requester ? { requester: input.requester } : {}),
            ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
          };
          const run = this.runs.enqueueExact(createReviewRunInput(descriptor));
          insertAttempt.run(
            input.reviewId,
            lane.agent,
            lane.role,
            0,
            run.id,
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

  private descriptorForAttempt(
    review: ReviewRow,
    lane: ReviewLaneSnapshot,
    attempt: ReviewAttemptSnapshot,
  ): LaneEnqueueDescriptor {
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
      ...(attempt.providerAdmissionClaimedAt === undefined
        ? {}
        : { providerAdmissionClaimedAt: attempt.providerAdmissionClaimedAt }),
      ...(review.project === null ? {} : { project: review.project }),
      ...(review.requester === null ? {} : { requester: review.requester }),
      ...(review.source_fingerprint === null ? {} : { sourceFingerprint: review.source_fingerprint }),
    };
  }

  private descriptor(review: ReviewRow, lane: ReviewLaneSnapshot): LaneEnqueueDescriptor {
    const attempt = lane.attempts.at(-1);
    if (!attempt || attempt.status !== "scheduled") {
      throw new Error("Review lane has no scheduled attempt");
    }
    return this.descriptorForAttempt(review, lane, attempt);
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
      const attempts = this.attemptsFor(input.reviewId, input.agent, input.role);
      const activeAttempt = attempts.at(-1);
      if (!activeAttempt || activeAttempt.attemptId !== input.attemptId) {
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
        return laneSnapshot(existing, attempts);
      }
      if (existing.status !== "queued") throw new Error("Deferred review lane is not active");
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
      const updated = this.db.prepare(`
        SELECT review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
               idempotency_key, prompt, degraded, result, error, terminal_at
          FROM runtime_review_lanes
         WHERE review_id = ? AND agent = ? AND role = ?
      `).get(input.reviewId, input.agent, input.role) as LaneRow;
      return laneSnapshot(updated, this.attemptsFor(input.reviewId, input.agent, input.role));
    });
    return update.immediate();
  }

  recordProviderUnavailable(input: {
    reviewId: string;
    agent: ReviewProviderId;
    role: ReviewRole;
    attemptId: string;
    error: unknown;
    terminalAt: number;
  }): ReviewLaneSnapshot {
    return this.db.transaction(() => {
      const lane = this.laneRows(input.reviewId).find(
        (candidate) => candidate.agent === input.agent && candidate.role === input.role,
      );
      if (!lane) throw new Error("Unknown review lane");
      const attempts = this.attemptsFor(input.reviewId, input.agent, input.role);
      const attempt = attempts.find((candidate) => candidate.attemptId === input.attemptId);
      if (!attempt) throw new Error("Unknown review attempt");
      const latest = attempts.at(-1);
      if (latest?.attemptId !== input.attemptId) {
        if (attempt.status === "provider_unavailable") {
          return laneSnapshot(lane, attempts);
        }
        throw new Error("provider failure does not match the active review attempt");
      }
      if (attempt.status !== "provider_unavailable" ||
          !isDeepStrictEqual(attempt.error, sanitizeResult(input.error)) ||
          attempt.terminalAt !== input.terminalAt) {
        throw new Error("provider failure lacks exact durable run evidence");
      }
      if (lane.status === "deferred") {
        return laneSnapshot(lane, attempts);
      }
      if (lane.status !== "queued") {
        throw new Error("Review attempt is not active");
      }
      this.db.prepare(`UPDATE runtime_review_lanes
        SET status='deferred',result=NULL,error=NULL,terminal_at=NULL
        WHERE review_id=? AND agent=? AND role=? AND status='queued'`)
        .run(input.reviewId, input.agent, input.role);
      const updated = this.laneRows(input.reviewId).find(
        (candidate) => candidate.agent === input.agent && candidate.role === input.role,
      )!;
      return laneSnapshot(updated, this.attemptsFor(input.reviewId, input.agent, input.role));
    }).immediate();
  }

  attempts(reviewId: string, agent: ReviewProviderId, role: ReviewRole): ReviewAttemptSnapshot[] {
    return this.attemptsFor(reviewId, agent, role);
  }

  barrier(reviewId: string): { satisfied: boolean; terminalCount: number; requiredCount: number } {
    if (this.reviewRow(reviewId) === undefined) throw new Error(`Unknown review: ${reviewId}`);
    const lanes = this.laneRows(reviewId);
    const terminalCount = lanes.filter((lane) => TERMINAL.has(lane.status)).length;
    const review = this.reviewRow(reviewId)!;
    return {
      satisfied: lanes.length > 0 && lanes.every((lane) =>
        isSemanticPass(lane) && this.hasExactRunnerEvidence(review, laneSnapshot(
          lane,
          this.attemptsFor(reviewId, lane.agent, lane.role),
        ))
      ),
      terminalCount,
      requiredCount: lanes.length,
    };
  }

  assertExactSemanticPass(input: ExactSemanticPassReviewInput): ReviewBarrierSnapshot {
    const review = this.get(input.reviewId);
    const artifactHash = createHash("sha256").update(input.artifact).digest("hex");
    if (
      !review ||
      review.stageId !== input.stageId ||
      review.artifactHash !== artifactHash ||
      !review.artifact.equals(input.artifact) ||
      review.approvalScope !== input.approvalScope ||
      review.idempotencyKey !== input.idempotencyKey ||
      review.project !== input.project ||
      review.requester !== input.requester ||
      review.sourceFingerprint !== input.sourceFingerprint ||
      review.changedFiles !== input.changedFiles ||
      review.lanes.length !== 6 ||
      review.lanes.some((lane) => lane.prompt !== input.prompts[lane.role]) ||
      this.barrier(input.reviewId).satisfied !== true
    ) {
      throw new Error(`review barrier is not an exact six-lane semantic PASS: ${input.reviewId}`);
    }
    return review;
  }

  private hasExactRunnerEvidence(review: ReviewRow, lane: ReviewLaneSnapshot): boolean {
    const attempt = lane.attempts.at(-1);
    if (!attempt || attempt.status !== "completed" || lane.status !== "completed") return false;
    const run = this.runs.getByIdempotencyKey(attempt.idempotencyKey);
    if (!run || !run.launched || run.status !== "completed" || run.attemptCount <= 0) return false;
    const launch = typeof run.launchInfo === "object" && run.launchInfo !== null
      ? run.launchInfo as Record<string, unknown>
      : null;
    const payload = run.payload ?? {};
    const envelope = typeof run.result === "object" && run.result !== null
      ? run.result as Record<string, unknown>
      : null;
    const providerResult = envelope && typeof envelope.providerResult === "object" &&
      envelope.providerResult !== null ? envelope.providerResult as Record<string, unknown> : null;
    const effect = envelope && typeof envelope.effect === "object" && envelope.effect !== null
      ? envelope.effect as Record<string, unknown>
      : null;
    let expected: ReturnType<typeof createReviewRunInput>;
    try {
      expected = createReviewRunInput(this.descriptorForAttempt(review, lane, attempt));
    } catch {
      return false;
    }
    return (
      (envelope?.domainEffect === "pending" || envelope?.domainEffect === "applying" ||
        envelope?.domainEffect === "applied") &&
      launch?.phase === "started" && Number.isSafeInteger(launch.pid) && Number(launch.pid) > 0 &&
      launch.agent === lane.agent && launch.model === attempt.model && launch.effort === attempt.effort &&
      launch.policyVersion === attempt.policyVersion && launch.sessionId === attempt.sessionId &&
      run.idempotencyKey === expected.idempotencyKey && run.stage === expected.stage &&
      run.priority === expected.priority && run.artifactHash === expected.artifactHash &&
      run.approvalScope === expected.approvalScope && isDeepStrictEqual(run.payload, expected.payload) &&
      payload.reviewId === review.review_id && payload.reviewRole === lane.role &&
      payload.reviewAttemptId === attempt.attemptId &&
      payload.reviewAttemptOrdinal === attempt.attemptOrdinal &&
      payload.sessionId === attempt.sessionId && payload.sourceFingerprint === review.source_fingerprint &&
      effect?.type === "review" && effect.reviewId === review.review_id &&
      effect.attemptId === attempt.attemptId && effect.role === lane.role &&
      effect.agent === lane.agent && effect.resultKind === "success" &&
      providerResult?.kind === "success" && providerResult.agent === lane.agent &&
      isDeepStrictEqual(providerResult, lane.result)
    );
  }

  deferredReviewIds(agent: ReviewProviderId): string[] {
    return (this.db.prepare(`SELECT DISTINCT review_id FROM runtime_review_lanes
      WHERE agent=? AND status='deferred' ORDER BY review_id`).all(agent) as Array<{ review_id: string }>)
      .map((row) => row.review_id);
  }

  activateDeferred(input: {
    reviewId: string;
    agent: ReviewProviderId;
    currentSourceFingerprint?: string;
    now: number;
    providerHealth: ProviderHealthStore;
  }): {
    status: "activated" | "provider_unavailable" | "stale_artifact" | "none";
    lanes: LaneEnqueueDescriptor[];
  } {
    const review = this.reviewRow(input.reviewId);
    if (review === undefined) throw new Error(`Unknown review: ${input.reviewId}`);
    if (review.source_fingerprint !== null &&
        review.source_fingerprint !== input.currentSourceFingerprint) {
      this.db.prepare(`
        UPDATE runtime_review_lanes
           SET status = 'stale_artifact', terminal_at = ?
         WHERE review_id = ? AND agent = ? AND status = 'deferred'
      `).run(input.now, input.reviewId, input.agent);
      return { status: "stale_artifact", lanes: [] };
    }
    const admission = input.providerHealth.acquireAdmission(input.agent, input.now);
    if (!admission.runnable) {
      return { status: "provider_unavailable", lanes: [] };
    }
    const admissionRun = admission.claimedAt !== undefined;

    const activate = this.db.transaction(() => {
      const deferred = this.laneRows(input.reviewId).filter(
        (lane) => lane.agent === input.agent && lane.status === "deferred",
      );
      const selected = admissionRun ? deferred.slice(0, 1) : deferred;
      const descriptors: LaneEnqueueDescriptor[] = [];
      for (const lane of selected) {
        const attempts = this.attemptsFor(input.reviewId, lane.agent, lane.role);
        const latest = attempts.at(-1);
        const attemptOrdinal = (latest?.attemptOrdinal ?? -1) + 1;
        const decision = reviewDecisionFor(lane.agent, lane.role, {
          attemptOrdinal,
          artifactBytes: review.artifact.length,
          changedFiles: review.changed_files,
        });
        const sessionId = randomUUID();
        const idempotencyKey = attemptOrdinal === 0
          ? lane.idempotency_key
          : `${review.idempotency_key}:${lane.agent}:${lane.role}:attempt:${attemptOrdinal}`;
        const claimed = this.db.prepare(`UPDATE runtime_review_lanes
          SET status='queued',model=?,effort=?,policy_version=?,reasons=?,session_id=?,idempotency_key=?,degraded=1
          WHERE review_id=? AND agent=? AND role=? AND status='deferred'`).run(
            decision.model, decision.effort, decision.policyVersion, JSON.stringify(decision.reasons),
            sessionId, idempotencyKey, input.reviewId, lane.agent, lane.role,
          ).changes;
        if (claimed !== 1) continue;
        const descriptor: LaneEnqueueDescriptor = {
          reviewId: review.review_id,
          stageId: review.stage_id,
          agent: lane.agent,
          role: lane.role,
          artifact: Buffer.from(review.artifact),
          artifactHash: review.artifact_hash,
          approvalScope: review.approval_scope,
          model: decision.model,
          effort: decision.effort as "high" | "xhigh" | "max",
          policyVersion: decision.policyVersion,
          reasons: decision.reasons,
          sessionId,
          idempotencyKey,
          prompt: lane.prompt,
          degraded: true,
          attemptId: randomUUID(),
          attemptOrdinal,
          ...(admission.claimedAt === undefined
            ? {}
            : { providerAdmissionClaimedAt: admission.claimedAt }),
          ...(review.project === null ? {} : { project: review.project }),
          ...(review.requester === null ? {} : { requester: review.requester }),
          ...(review.source_fingerprint === null ? {} : { sourceFingerprint: review.source_fingerprint }),
        };
        const run = this.runs.enqueueExact(createReviewRunInput(descriptor));
        this.db.prepare(`INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,run_id,created_at)
          VALUES (?,?,?,?,?,?)`).run(
            input.reviewId, lane.agent, lane.role, attemptOrdinal, run.id, input.now,
          );
        descriptors.push(descriptor);
      }
      return descriptors;
    });
    let lanes: LaneEnqueueDescriptor[];
    try {
      lanes = activate.immediate();
    } catch (error) {
      if (admission.claimedAt !== undefined) {
        input.providerHealth.releaseAttempt(input.agent, input.now, admission.claimedAt);
      }
      throw error;
    }
    if (lanes.length === 0 && admission.claimedAt !== undefined) {
      input.providerHealth.releaseAttempt(input.agent, input.now, admission.claimedAt);
    }
    return lanes.length === 0 ? { status: "none", lanes } : { status: "activated", lanes };
  }

  close(): void {
    this.runs.close();
    if (this.ownsDatabase) this.db.close();
  }
}
