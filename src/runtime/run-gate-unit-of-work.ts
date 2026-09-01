import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { openStateStoreAccess, type StateDatabaseAccess, type StateStoreInput } from "../store/state-database-fence.js";
import canonicalize from "canonicalize";
import {
  assertExactReviewTopology,
  createReviewPlan,
  hasExactReviewTopology,
  REVIEW_BARRIER_POLICY,
  REVIEW_ROLES,
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
import { assertReviewV3SchemaSignature } from "../migration/review-v3-schema.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../flow/map-admin.js";
export { createReviewAttemptIdentity } from "./review-attempt-identity.js";
import { createReviewAttemptIdentity } from "./review-attempt-identity.js";

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("review evidence must be RFC8785 JSON");
  return encoded;
};
const canonicalHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export type ReviewLaneStatus =
  | "queued"
  | "deferred"
  | "completed"
  | "failed"
  | "timed_out"
  | "stale_artifact"
  | "needs_reconciliation";
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

const attemptMatchesLaneIdentity = (
  lane: ReviewLaneSnapshot,
  attempt: ReviewAttemptSnapshot,
): boolean => lane.model === attempt.model && lane.effort === attempt.effort &&
  lane.policyVersion === attempt.policyVersion && isDeepStrictEqual(lane.reasons, attempt.reasons) &&
  lane.sessionId === attempt.sessionId && lane.idempotencyKey === attempt.idempotencyKey;

const matchesAcceptedUnavailableProjection = (
  lane: LaneRow,
  acceptedError: unknown,
  terminalAt: number,
): boolean => {
  if (lane.error === null || lane.terminal_at !== terminalAt) return false;
  try { return isDeepStrictEqual(parseJson(lane.error), acceptedError); } catch { return false; }
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
  recoveryGeneration?: number | undefined;
  previousOrdinal?: number | undefined;
  previousEvidenceHash?: string | undefined;
  sourceReceiptId?: string | undefined;
  readinessReceiptId?: string | undefined;
  authorityId?: string | undefined;
  scheduledAt?: number | undefined;
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
  recoveryGeneration?: number | undefined;
  previousOrdinal?: number | undefined;
  previousEvidenceHash?: string | undefined;
  sourceReceiptId?: string | undefined;
  readinessReceiptId?: string | undefined;
  authorityId?: string | undefined;
  scheduledAt?: number | undefined;
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
  launch_authority_version: 1 | 2 | 3;
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
  lane_revision?: number;
}

interface AttemptLinkRow {
  review_id: string;
  agent: ReviewProviderId;
  role: ReviewRole;
  attempt_ordinal: number;
  run_id: string;
  created_at: number;
  attempt_id?: string | null;
  authority_id?: string | null;
  base_policy_id?: string | null;
  authority_kind?: string | null;
  model?: EffortDecision["model"] | null;
  effort?: "high" | "xhigh" | "max" | null;
  policy_version?: PersistedRoutingPolicyVersion | null;
  reasons_json?: string | null;
  session_id?: string | null;
  idempotency_key?: string | null;
  recovery_generation?: number | null;
  previous_ordinal?: number | null;
  previous_evidence_hash?: string | null;
  expected_lane_revision?: number | null;
  expected_attempt_ordinal?: number | null;
  authority_receipt_id?: string | null;
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
  admissionReceipts?: ReviewAdmissionReceiptPair[];
  faultInjector?: (point: string) => void;
}

export interface ReviewAdmissionReceiptPair {
  agent?: ReviewProviderId;
  role: ReviewRole;
  activationNonce?: string;
  sourceReceiptId: string;
  readinessReceiptId: string;
}

interface CaptureReviewReceiptInput {
  receiptId: string;
  phase: "admission" | "prelaunch";
  scope: string;
  scopeRevision: number;
  activationNonce: string;
  expectedTuple: Record<string, unknown>;
  recoveryGeneration: number | null;
  observation: Record<string, unknown>;
  predecessorReceiptId: string | null;
  createdAt: number;
  faultInjector?: (point: string) => void;
}

interface ReceiptCaptureResult {
  receiptId: string;
  lifecycle: "pending" | "orphaned";
  currentHeadReceiptId: string;
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
    priority: lane.agent === REVIEW_BARRIER_POLICY.requiredAgent ? 4 : 20,
    ...(lane.scheduledAt === undefined ? {} : { now: lane.scheduledAt }),
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
  const schema = (table: string): string => tableSchema(db, table)
    .replace(/\s+/g, "")
    .replace(/,/g, "");
  const barriers = schema("runtime_review_barriers");
  const lanes = schema("runtime_review_lanes");
  const attempts = schema("runtime_review_lane_attempts");
  if (
    !barriers.includes("requesterin('grok''codex')") ||
    barriers.includes("requesterin('grok''claude''codex')") ||
    !barriers.includes("run_statein('full_cross_provider''degraded_review_set')") ||
    !lanes.includes("agentin('grok''claude''codex')") ||
    !lanes.includes("modelin('grok-4.6''glm-5.3''gpt-5.6-sol')") ||
    !lanes.includes("effortin('high''xhigh''max')") ||
    !lanes.includes("policy_version='routing-v5'") ||
    !lanes.includes("reasons") ||
    !attempts.includes("agentin('grok''claude''codex')") ||
    !attempts.includes("attempt_ordinal") ||
    !attempts.includes("run_id") ||
    (!attempts.includes("policy_version") &&
      !schema("runtime_schema_capabilities").includes("capability_version")) ||
    attempts.includes("statustext")
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
  private readonly access: StateDatabaseAccess;
  private readonly closeAccess: () => void;
  private readonly hasLaunchAuthorityVersion: boolean;

  constructor(pathOrDatabase: StateStoreInput) {
    const opened = openStateStoreAccess(pathOrDatabase);
    try {
      this.access = opened.access;
      this.closeAccess = opened.close;
      this.db = this.access.database;
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      const existing = this.db.prepare(`
        SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name IN ('runtime_review_barriers', 'runtime_review_lanes')
         LIMIT 1
      `).get();
      if (existing === undefined) throw new Error("review gate requires migration-owned schema");
      assertDatabaseIntegrity(this.db);
      assertFreshV5Schema(this.db);
      if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
        AND name='runtime_schema_capabilities'`).get()) {
        assertReviewV3SchemaSignature(this.db);
      }
      this.hasLaunchAuthorityVersion = tableSchema(this.db, "runtime_review_barriers")
        .includes("launch_authority_version");
      assertDatabaseIntegrity(this.db);
      this.runs = new RunStore(this.access.borrow());
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  private reviewRow(reviewId: string): ReviewRow | undefined {
    return this.db.prepare(`
      SELECT review_id, stage_id, artifact, artifact_hash, approval_scope,
             idempotency_key, run_state, created_at, project, requester, source_fingerprint, changed_files,
             ${this.hasLaunchAuthorityVersion ? "launch_authority_version" : "1 AS launch_authority_version"}
        FROM runtime_review_barriers
       WHERE review_id = ?
    `).get(reviewId) as ReviewRow | undefined;
  }

  private laneRows(reviewId: string): LaneRow[] {
    return this.db.prepare(`
      SELECT review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
             idempotency_key, prompt, degraded, result, error, terminal_at, lane_revision
        FROM runtime_review_lanes
       WHERE review_id = ?
       ORDER BY CASE agent WHEN 'grok' THEN 0 WHEN 'claude' THEN 1 ELSE 2 END,
                CASE role WHEN 'auditor' THEN 0 ELSE 1 END
    `).all(reviewId) as LaneRow[];
  }

  private attemptsFor(reviewId: string, agent?: ReviewProviderId, role?: ReviewRole): ReviewAttemptSnapshot[] {
    const links = this.db.prepare(`
      SELECT review_id,agent,role,attempt_ordinal,run_id,created_at,attempt_id,authority_id,
             base_policy_id,authority_kind,model,effort,policy_version,reasons_json,session_id,
             idempotency_key,recovery_generation,previous_ordinal,previous_evidence_hash,
             expected_lane_revision,expected_attempt_ordinal,authority_receipt_id
        FROM runtime_review_lane_attempts
       WHERE review_id=? AND (? IS NULL OR agent=?) AND (? IS NULL OR role=?)
       ORDER BY agent,role,attempt_ordinal
    `).all(reviewId, agent ?? null, agent ?? null, role ?? null, role ?? null) as AttemptLinkRow[];
    const review = this.reviewRow(reviewId);
    const v3 = review?.launch_authority_version === 3;
    const corrupt = v3 && links.some((link) => {
      if (!link.attempt_id || !link.authority_id || !link.base_policy_id || !link.authority_kind ||
          !link.model || !link.effort || !link.policy_version || !link.reasons_json ||
          !link.session_id || !link.idempotency_key || link.expected_lane_revision == null ||
          link.expected_attempt_ordinal == null || !link.authority_receipt_id) return true;
      let expectedIdentity;
      try {
        expectedIdentity = createReviewAttemptIdentity({
          reviewId, barrierIdempotencyKey: review!.idempotency_key,
          agent: link.agent, role: link.role, ordinal: link.attempt_ordinal,
          ...(link.attempt_ordinal === 0 ? {
            legacySessionId: link.session_id, legacyIdempotencyKey: link.idempotency_key,
          } : {}),
        });
      } catch { return true; }
      if (expectedIdentity.attemptId !== link.attempt_id ||
          expectedIdentity.sessionId !== link.session_id ||
          expectedIdentity.idempotencyKey !== link.idempotency_key) return true;
      const policy = this.db.prepare(`SELECT * FROM runtime_review_attempt_base_policies
        WHERE base_policy_id=?`).get(link.base_policy_id) as Record<string, unknown> | undefined;
      if (!policy || policy.review_id !== reviewId || policy.agent !== link.agent ||
          policy.role !== link.role || policy.model !== link.model || policy.effort !== link.effort ||
          policy.policy_version !== link.policy_version || policy.reasons_json !== link.reasons_json) return true;
      const authority = this.db.prepare(`SELECT * FROM runtime_review_attempt_authorities
        WHERE authority_id=?`).get(link.authority_id) as Record<string, unknown> | undefined;
      if (!authority || authority.review_id !== reviewId || authority.agent !== link.agent ||
          authority.role !== link.role || authority.attempt_id !== link.attempt_id ||
          authority.attempt_ordinal !== link.attempt_ordinal ||
          authority.authority_kind !== link.authority_kind ||
          authority.recovery_generation !== link.recovery_generation ||
          authority.previous_ordinal !== link.previous_ordinal ||
          authority.previous_evidence_hash !== link.previous_evidence_hash ||
          authority.authority_hash !== link.authority_receipt_id) return true;
      const run = this.runs.get(link.run_id);
      const payload = run?.payload ?? {};
      const identity = payload.reviewDispatchIdentity as Record<string, unknown> | undefined;
      const decision = payload.decision as Record<string, unknown> | undefined;
      return !run || run.idempotencyKey !== link.idempotency_key ||
        identity?.attemptId !== link.attempt_id || identity?.sessionId !== link.session_id ||
        decision?.model !== link.model || decision?.effort !== link.effort ||
        decision?.policyVersion !== link.policy_version ||
        !isDeepStrictEqual(decision?.reasons, JSON.parse(link.reasons_json));
    });
    if (corrupt) {
      const ids = links.map(({ run_id }) => run_id);
      const mark = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',
        lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE id=?`);
      this.db.transaction(() => ids.forEach((id) => mark.run(id)))();
    }
    return links.map((link) => {
      const run = this.runs.get(link.run_id);
      if (!run) throw new Error("review attempt references a missing run");
      const payload = run.payload ?? {};
      const identity = payload.reviewDispatchIdentity as Record<string, unknown> | undefined;
      const decision = payload.decision as Record<string, unknown> | undefined;
      const lane = this.laneRows(reviewId).find((candidate) =>
        candidate.agent === link.agent && candidate.role === link.role);
      const attemptId = link.attempt_id ?? (typeof identity?.attemptId === "string"
        ? identity.attemptId : link.run_id);
      const sessionId = link.session_id ?? (typeof identity?.sessionId === "string"
        ? identity.sessionId : lane?.session_id ?? link.run_id);
      const reasons = link.reasons_json ? parseReasons(link.reasons_json)
        : Array.isArray(decision?.reasons) ? decision.reasons as EffortReason[]
          : lane ? parseReasons(lane.reasons) : [];
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
            ? providerResult?.kind === "network_timeout" ? "timed_out" : "failed"
            : "scheduled";
      const terminalAt = Number.isSafeInteger(effect?.terminalAt) ? Number(effect!.terminalAt) : null;
      return {
        attemptId,
        attemptOrdinal: link.attempt_ordinal,
        status,
        model: (link.model ?? decision?.model ?? lane?.model) as EffortDecision["model"],
        effort: (link.effort ?? decision?.effort ?? lane?.effort) as "high" | "xhigh" | "max",
        policyVersion: (link.policy_version ?? decision?.policyVersion ?? lane?.policy_version) as PersistedRoutingPolicyVersion,
        reasons,
        sessionId,
        idempotencyKey: link.idempotency_key ?? run.idempotencyKey,
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

  private captureReceiptInTransaction(input: CaptureReviewReceiptInput): ReceiptCaptureResult {
    if (!Number.isSafeInteger(input.scopeRevision) || input.scopeRevision <= 0) {
      throw new Error("receipt scopeRevision must be a positive integer");
    }
    const expectedTupleJson = canonicalJson(input.expectedTuple);
    const observationJson = canonicalJson(input.observation);
    const observationHash = canonicalHash(input.observation);
    const canonicalBytes = canonicalJson({
      receiptId: input.receiptId,
      phase: input.phase,
      scope: input.scope,
      scopeRevision: input.scopeRevision,
      activationNonce: input.activationNonce,
      expectedTuple: input.expectedTuple,
      recoveryGeneration: input.recoveryGeneration,
      observation: input.observation,
      predecessorReceiptId: input.predecessorReceiptId,
    });
    const envelopeHash = createHash("sha256").update(canonicalBytes).digest("hex");
    const existing = this.db.prepare(`SELECT receipt_id,phase,scope,scope_revision,
      activation_nonce,expected_tuple_json,recovery_generation,observation_json,
      predecessor_receipt_id,canonical_bytes,envelope_hash,created_at
      FROM runtime_review_receipts WHERE receipt_id=?`).get(input.receiptId) as
      Record<string, unknown> | undefined;
    if (existing) {
      const exact = existing.phase === input.phase && existing.scope === input.scope &&
        existing.scope_revision === input.scopeRevision &&
        existing.activation_nonce === input.activationNonce &&
        existing.expected_tuple_json === expectedTupleJson &&
        existing.recovery_generation === input.recoveryGeneration &&
        existing.observation_json === observationJson &&
        existing.predecessor_receipt_id === input.predecessorReceiptId &&
        existing.canonical_bytes === canonicalBytes && existing.envelope_hash === envelopeHash &&
        existing.created_at === input.createdAt;
      if (!exact) throw new Error(`immutable receipt conflict: ${input.receiptId}`);
      const lifecycle = this.db.prepare(`SELECT state FROM runtime_review_receipt_lifecycle
        WHERE receipt_id=?`).pluck().get(input.receiptId) as string | undefined;
      const head = this.db.prepare(`SELECT receipt_id FROM runtime_review_receipt_heads
        WHERE scope=?`).pluck().get(input.scope) as string | undefined;
      return {
        receiptId: input.receiptId,
        lifecycle: lifecycle === "orphaned" ? "orphaned" : "pending",
        currentHeadReceiptId: head ?? input.receiptId,
      };
    }

    this.db.prepare(`INSERT INTO runtime_review_receipts
      (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
       recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
       canonical_bytes,envelope_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.receiptId, input.phase, input.scope, input.scopeRevision,
        input.activationNonce, expectedTupleJson, input.recoveryGeneration,
        observationJson, observationHash, input.predecessorReceiptId,
        canonicalBytes, envelopeHash, input.createdAt,
      );
    input.faultInjector?.("after_envelope_insert");
    const head = this.db.prepare(`SELECT receipt_id,scope_revision,activation_nonce
      FROM runtime_review_receipt_heads WHERE scope=?`).get(input.scope) as
      { receipt_id: string; scope_revision: number; activation_nonce: string } | undefined;
    input.faultInjector?.("after_receipt_predecessor_read_before_head_cas");

    const terminal = this.db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
      (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
       recovery_generation,predecessor_receipt_id,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    let lifecycle: ReceiptCaptureResult["lifecycle"] = "pending";
    let currentHeadReceiptId = input.receiptId;
    const predecessorIsPending = head !== undefined &&
      head.receipt_id === input.predecessorReceiptId &&
      head.scope_revision + 1 === input.scopeRevision &&
      this.db.prepare(`SELECT 1 FROM runtime_review_receipt_lifecycle WHERE receipt_id=?`)
        .get(head.receipt_id) === undefined;

    const headlessPredecessor = input.predecessorReceiptId === null ? undefined
      : this.db.prepare(`SELECT receipt_id,scope_revision FROM runtime_review_receipts
        WHERE receipt_id=? AND scope=?`).get(input.predecessorReceiptId, input.scope) as
        { receipt_id: string; scope_revision: number } | undefined;
    const competingSuccessor = this.db.prepare(`SELECT 1 FROM runtime_review_receipts
      WHERE scope=? AND scope_revision=? AND receipt_id<>? LIMIT 1`)
      .get(input.scope, input.scopeRevision, input.receiptId);
    const validHeadlessSuccessor = head === undefined && headlessPredecessor !== undefined &&
      input.scopeRevision === headlessPredecessor.scope_revision + 1 && competingSuccessor === undefined;
    if (head === undefined && ((input.predecessorReceiptId === null && input.scopeRevision === 1) ||
        validHeadlessSuccessor)) {
      input.faultInjector?.("after_predecessor_terminal");
      input.faultInjector?.("before_head_cas");
      this.db.prepare(`INSERT INTO runtime_review_receipt_heads
        (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,?,?)`)
        .run(input.scope, input.receiptId, input.scopeRevision, input.activationNonce);
    } else if (predecessorIsPending) {
      terminal.run(head.receipt_id, "superseded", head.scope_revision, head.activation_nonce,
        (this.db.prepare(`SELECT expected_tuple_json FROM runtime_review_receipts WHERE receipt_id=?`)
          .pluck().get(head.receipt_id) as string),
        this.db.prepare(`SELECT recovery_generation FROM runtime_review_receipts WHERE receipt_id=?`)
          .pluck().get(head.receipt_id) as number | null,
        this.db.prepare(`SELECT predecessor_receipt_id FROM runtime_review_receipts WHERE receipt_id=?`)
          .pluck().get(head.receipt_id) as string | null,
        input.createdAt);
      input.faultInjector?.("after_predecessor_terminal");
      input.faultInjector?.("before_head_cas");
      const changed = this.db.prepare(`UPDATE runtime_review_receipt_heads
        SET receipt_id=?,scope_revision=?,activation_nonce=?
        WHERE scope=? AND receipt_id=? AND scope_revision=?`).run(
          input.receiptId, input.scopeRevision, input.activationNonce,
          input.scope, head.receipt_id, head.scope_revision,
        ).changes;
      if (changed !== 1) throw new Error("receipt head CAS failed");
    } else {
      terminal.run(input.receiptId, "orphaned", input.scopeRevision, input.activationNonce,
        expectedTupleJson, input.recoveryGeneration, input.predecessorReceiptId, input.createdAt);
      lifecycle = "orphaned";
      currentHeadReceiptId = head?.receipt_id ?? input.receiptId;
    }
    input.faultInjector?.("before_receipt_commit");
    return { receiptId: input.receiptId, lifecycle, currentHeadReceiptId };
  }

  captureReviewReceipt(input: CaptureReviewReceiptInput): ReceiptCaptureResult {
    return this.db.transaction(() => this.captureReceiptInTransaction(input)).immediate();
  }

  captureReviewReceiptPair(input: {
    pairId: string;
    phase: "admission" | "prelaunch";
    activationNonce: string;
    scopeRevision: number;
    recoveryGeneration: number | null;
    expectedTuple: Record<string, unknown>;
    predecessorReceiptIds: { source: string | null; readiness: string | null };
    receipts: {
      source: { receiptId: string; scope: string; observation: Record<string, unknown> };
      readiness: { receiptId: string; scope: string; observation: Record<string, unknown> };
    };
    createdAt: number;
    faultInjector?: (point: string) => void;
  }): { pairId: string; lifecycle: "pending" | "orphaned"; source: ReceiptCaptureResult;
    readiness: ReceiptCaptureResult } {
    return this.db.transaction(() => {
      const source = this.captureReceiptInTransaction({
        receiptId: input.receipts.source.receiptId, phase: input.phase,
        scope: input.receipts.source.scope, scopeRevision: input.scopeRevision,
        activationNonce: input.activationNonce, expectedTuple: input.expectedTuple,
        recoveryGeneration: input.recoveryGeneration,
        observation: input.receipts.source.observation,
        predecessorReceiptId: input.predecessorReceiptIds.source, createdAt: input.createdAt,
      });
      input.faultInjector?.("after_first_pair_envelope");
      const readiness = this.captureReceiptInTransaction({
        receiptId: input.receipts.readiness.receiptId, phase: input.phase,
        scope: input.receipts.readiness.scope, scopeRevision: input.scopeRevision,
        activationNonce: input.activationNonce, expectedTuple: input.expectedTuple,
        recoveryGeneration: input.recoveryGeneration,
        observation: input.receipts.readiness.observation,
        predecessorReceiptId: input.predecessorReceiptIds.readiness, createdAt: input.createdAt,
      });
      if (source.lifecycle !== readiness.lifecycle) {
        throw new Error("receipt pair head state diverged");
      }
      return { pairId: input.pairId, lifecycle: source.lifecycle, source, readiness };
    }).immediate();
  }

  private enqueueActiveReviewRuns(row: ReviewRow): void {
    if (row.launch_authority_version !== 2) return;
    for (const lane of this.snapshot(row).lanes.filter(({ status }) => status === "queued")) {
      const attempt = lane.attempts.at(-1);
      if (attempt?.status === "scheduled") {
        this.runs.enqueueExact(createReviewRunInput(this.descriptorForAttempt(row, lane, attempt)));
      }
    }
  }

  create(input: CreateReviewBarrierInput): ReviewBarrierSnapshot {
    if (!this.hasLaunchAuthorityVersion) {
      throw new Error("review creation requires the offline v3-to-v4 migration");
    }
    const artifact = Buffer.from(input.artifact);
    const artifactHash = createHash("sha256").update(artifact).digest("hex");
    const create = this.db.transaction(() => {
      const existing = this.reviewRow(input.reviewId);
      if (existing !== undefined) {
        const snapshot = this.snapshot(existing);
        assertExactReviewTopology(snapshot.lanes);
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
           idempotency_key, run_state, created_at, project, requester, source_fingerprint, changed_files,
           launch_authority_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)
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

      const allLanes = [...plan.activeLanes, ...plan.deferredLanes];
      const activeKeys = new Set(plan.activeLanes.map((lane) => lane.idempotencyKey));
      const basePolicyIds = new Map<string, string>();
      const insertBasePolicy = this.db.prepare(`INSERT INTO runtime_review_attempt_base_policies
        (base_policy_id,review_id,agent,role,model,effort,policy_version,reasons_json,
         legacy_session_id,legacy_idempotency_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const lane of allLanes) {
        const policyBytes = JSON.stringify({ reviewId: input.reviewId, agent: lane.agent,
          role: lane.role, model: lane.model, effort: lane.effort,
          policyVersion: lane.policyVersion, reasons: lane.reasons });
        const basePolicyId = `review-policy-${createHash("sha256").update(policyBytes).digest("hex")}`;
        insertBasePolicy.run(basePolicyId, input.reviewId, lane.agent, lane.role,
          lane.model, lane.effort, lane.policyVersion, JSON.stringify(lane.reasons),
          lane.sessionId, lane.idempotencyKey, input.createdAt);
        basePolicyIds.set(`${lane.agent}:${lane.role}`, basePolicyId);
      }
      input.faultInjector?.("after_base_policy_insert");
      const insertLane = this.db.prepare(`
        INSERT INTO runtime_review_lanes
          (review_id, agent, role, status, model, effort, policy_version, reasons, session_id,
           idempotency_key, prompt, degraded, result, error, terminal_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `);
      for (const lane of allLanes) {
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
      }
      input.faultInjector?.("after_lane_insert");

      for (const lane of plan.activeLanes) {
        const pair = input.admissionReceipts?.find((candidate) =>
          (candidate.agent === undefined || candidate.agent === lane.agent) && candidate.role === lane.role);
        if (!pair) throw new Error(`active review lane lacks exact admission receipt pair: ${lane.agent}/${lane.role}`);
        const expectedTuple = { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null };
        const receiptFor = (receiptId: string, kind: "source" | "readiness") => {
          const receipt = this.db.prepare(`SELECT r.*,h.receipt_id AS head_receipt_id,
            x.state AS lifecycle_state FROM runtime_review_receipts r
            LEFT JOIN runtime_review_receipt_heads h ON h.scope=r.scope
            LEFT JOIN runtime_review_receipt_lifecycle x ON x.receipt_id=r.receipt_id
            WHERE r.receipt_id=?`).get(receiptId) as Record<string, unknown> | undefined;
          const expectedScope = `review/${input.reviewId}/${lane.agent}/${lane.role}/${kind}`;
          if (!receipt || receipt.phase !== "admission" || receipt.scope !== expectedScope ||
              receipt.head_receipt_id !== receiptId || receipt.lifecycle_state != null ||
              (pair.activationNonce !== undefined && receipt.activation_nonce !== pair.activationNonce) ||
              receipt.recovery_generation !== null ||
              !isDeepStrictEqual(JSON.parse(String(receipt.expected_tuple_json)), expectedTuple)) {
            throw new Error(`invalid current admission receipt: ${receiptId}`);
          }
          const observation = JSON.parse(String(receipt.observation_json)) as Record<string, unknown>;
          const valid = observation.valid === true && (kind === "source"
            ? observation.sourceFingerprint === input.sourceFingerprint
            : observation.harnessReady === true);
          if (!valid) throw new Error(`invalid admission observation: ${receiptId}`);
          return receipt;
        };
        const source = receiptFor(pair.sourceReceiptId, "source");
        const readiness = receiptFor(pair.readinessReceiptId, "readiness");
        if (source.activation_nonce !== readiness.activation_nonce) {
          throw new Error(`admission receipt pair nonce mismatch: ${lane.agent}/${lane.role}`);
        }
        const activationNonce = String(source.activation_nonce);
        const identity = createReviewAttemptIdentity({
          reviewId: input.reviewId, barrierIdempotencyKey: input.idempotencyKey,
          agent: lane.agent, role: lane.role, ordinal: 0,
          legacySessionId: lane.sessionId, legacyIdempotencyKey: lane.idempotencyKey,
        });
        const basePolicyId = basePolicyIds.get(`${lane.agent}:${lane.role}`)!;
        const authorityBytes = JSON.stringify({ reviewId: input.reviewId, agent: lane.agent,
          role: lane.role, attemptId: identity.attemptId, attemptOrdinal: 0,
          authorityKind: "initial", sourceReceiptId: pair.sourceReceiptId,
          readinessReceiptId: pair.readinessReceiptId, activationNonce });
        const authorityHash = createHash("sha256").update(authorityBytes).digest("hex");
        const authorityId = `review-authority-${authorityHash}`;
        this.db.prepare(`INSERT INTO runtime_review_attempt_authorities
          (authority_id,review_id,agent,role,attempt_id,attempt_ordinal,authority_kind,
           recovery_generation,previous_ordinal,previous_evidence_hash,
           admission_source_receipt_id,admission_readiness_receipt_id,activation_nonce,
           authority_hash,created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)`).run(
            authorityId, input.reviewId, lane.agent, lane.role, identity.attemptId, 0, "initial",
            pair.sourceReceiptId, pair.readinessReceiptId, activationNonce,
            authorityHash, input.createdAt,
          );
        input.faultInjector?.("after_initial_authority_insert");
        const descriptor: LaneEnqueueDescriptor = {
          reviewId: input.reviewId, stageId: input.stageId, agent: lane.agent, role: lane.role,
          artifact: Buffer.from(artifact), artifactHash, approvalScope: input.approvalScope,
          model: lane.model, effort: lane.effort as "high" | "xhigh" | "max",
          policyVersion: lane.policyVersion, reasons: lane.reasons,
          sessionId: identity.sessionId, idempotencyKey: identity.idempotencyKey,
          prompt: lane.prompt, degraded: lane.degraded, attemptId: identity.attemptId,
          attemptOrdinal: 0, sourceReceiptId: pair.sourceReceiptId,
          readinessReceiptId: pair.readinessReceiptId, authorityId,
          ...(input.project ? { project: input.project } : {}),
          ...(input.requester ? { requester: input.requester } : {}),
          ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
        };
        const run = this.runs.enqueueExact(createReviewRunInput({
          ...descriptor, scheduledAt: input.createdAt,
        }));
        input.faultInjector?.("after_run_insert");
        this.db.prepare(`INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,run_id,created_at,attempt_id,authority_id,
           base_policy_id,authority_kind,model,effort,policy_version,reasons_json,session_id,
           idempotency_key,recovery_generation,previous_ordinal,previous_evidence_hash,
           expected_lane_revision,expected_attempt_ordinal,authority_receipt_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,0,0,?)`).run(
            input.reviewId, lane.agent, lane.role, 0, run.id, input.createdAt,
            identity.attemptId, authorityId, basePolicyId, "initial", lane.model, lane.effort,
            lane.policyVersion, JSON.stringify(lane.reasons), identity.sessionId,
            identity.idempotencyKey, authorityHash,
          );
        input.faultInjector?.("after_attempt_link_insert");
        const terminal = this.db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
          (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
           recovery_generation,predecessor_receipt_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const receipt of [source, readiness]) {
          terminal.run(receipt.receipt_id, "consumed", receipt.scope_revision,
            receipt.activation_nonce, receipt.expected_tuple_json, receipt.recovery_generation,
            receipt.predecessor_receipt_id, input.createdAt);
          this.db.prepare(`DELETE FROM runtime_review_receipt_heads
            WHERE scope=? AND receipt_id=?`).run(receipt.scope, receipt.receipt_id);
        }
        input.faultInjector?.("after_projection_update");
      }
      input.faultInjector?.("before_create_commit");
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
        if (attempt.status === "provider_unavailable" &&
            isDeepStrictEqual(attempt.error, sanitizeResult(input.error)) &&
            attempt.terminalAt === input.terminalAt) {
          const review = this.reviewRow(input.reviewId);
          const historicalLane = { ...laneSnapshot(lane, attempts),
            model: attempt.model, effort: attempt.effort, policyVersion: attempt.policyVersion,
            reasons: attempt.reasons, sessionId: attempt.sessionId,
            idempotencyKey: attempt.idempotencyKey };
          if (!review || !this.hasExactUnavailableAttemptEvidence(
            review, historicalLane, attempt, sanitizeResult(input.error), input.terminalAt,
          )) {
            throw new Error("provider failure lacks exact durable run evidence");
          }
          return laneSnapshot(lane, attempts);
        }
        throw new Error("provider failure does not match the active review attempt");
      }
      const acceptedError = sanitizeResult(input.error);
      if (attempt.status !== "provider_unavailable" ||
          !isDeepStrictEqual(attempt.error, acceptedError) ||
          attempt.terminalAt !== input.terminalAt) {
        throw new Error("provider failure lacks exact durable run evidence");
      }
      const review = this.reviewRow(input.reviewId);
      if (!review || !this.hasExactUnavailableRunnerEvidence(
        review,
        laneSnapshot(lane, attempts),
        acceptedError,
        input.terminalAt,
      )) {
        throw new Error("provider failure lacks exact durable run evidence");
      }
      if (lane.status === "deferred" || lane.status === "stale_artifact") {
        if (!matchesAcceptedUnavailableProjection(lane, acceptedError, input.terminalAt)) {
          throw new Error("deferred provider receipt conflicts with accepted run evidence");
        }
        return laneSnapshot(lane, attempts);
      }
      if (lane.status !== "queued") {
        throw new Error("Review attempt is not active");
      }
      this.db.prepare(`UPDATE runtime_review_lanes
        SET status='deferred',result=NULL,error=?,terminal_at=?,lane_revision=lane_revision+1
        WHERE review_id=? AND agent=? AND role=? AND status='queued'`)
        .run(JSON.stringify(acceptedError), input.terminalAt, input.reviewId, input.agent, input.role);
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
    assertExactReviewTopology(lanes);
    const review = this.reviewRow(reviewId)!;
    const required = lanes.filter((lane) => lane.agent === REVIEW_BARRIER_POLICY.requiredAgent);
    const requiredCount = REVIEW_BARRIER_POLICY.requiredRoles.length;
    const requiredPass = required.length === requiredCount && required.every((lane) =>
      isSemanticPass(lane) && this.hasExactRunnerEvidence(review, laneSnapshot(
        lane,
        this.attemptsFor(reviewId, lane.agent, lane.role),
      ))
    );
    const optionalBlocks = lanes.filter(
      (lane) => lane.agent !== REVIEW_BARRIER_POLICY.requiredAgent,
    ).some((lane) => {
      const attempts = this.attemptsFor(reviewId, lane.agent, lane.role);
      const latest = attempts.at(-1);
      if (attempts.some((attempt) => attempt.status === "provider_unavailable" &&
          !this.hasExactUnavailableAttemptEvidence(
            review,
            laneSnapshot(lane, attempts),
            attempt,
            attempt.error,
            attempt.terminalAt ?? -1,
          ))) return true;
      if (!latest) return lane.status !== "deferred" && lane.status !== "stale_artifact";
      if (latest.status === "needs_reconciliation") {
        return REVIEW_BARRIER_POLICY.optionalNeedsReconciliationBlocks;
      }
      if (latest.status === "scheduled") return true;
      if (latest.status === "provider_unavailable") {
        let acceptedError: unknown;
        try { acceptedError = parseJson(lane.error); } catch { return true; }
        const exactProjection = lane.terminal_at !== null &&
          matchesAcceptedUnavailableProjection(lane, acceptedError, lane.terminal_at);
        const exactUnavailable = exactProjection && lane.terminal_at !== null &&
          this.hasExactUnavailableRunnerEvidence(
            review,
            laneSnapshot(lane, attempts),
            acceptedError,
            lane.terminal_at,
          );
        return !exactUnavailable ||
          (lane.status !== "deferred" && lane.status !== "stale_artifact") ||
          REVIEW_BARRIER_POLICY.optionalUnavailableBlocks;
      }
      if (latest.status === "failed" || latest.status === "timed_out") {
        return true;
      }
      if (lane.status !== "completed") return true;
      if (!this.hasExactRunnerEvidence(review, laneSnapshot(lane, attempts))) return true;
      return !isSemanticPass(lane) && REVIEW_BARRIER_POLICY.optionalChangesRequestedBlocks;
    });
    return {
      satisfied: requiredPass && !optionalBlocks,
      terminalCount: required.filter((lane) => TERMINAL.has(lane.status)).length,
      requiredCount,
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
      !hasExactReviewTopology(review.lanes) ||
      review.lanes.some((lane) => lane.prompt !== input.prompts[lane.role]) ||
      this.barrier(input.reviewId).satisfied !== true
    ) {
      throw new Error(`review barrier is not an exact Codex quorum semantic PASS: ${input.reviewId}`);
    }
    return review;
  }

  private hasExactRunnerEvidence(review: ReviewRow, lane: ReviewLaneSnapshot): boolean {
    const attempt = lane.attempts.at(-1);
    if (!attempt || attempt.status !== "completed" || lane.status !== "completed") return false;
    const evidence = this.exactRunnerEvidence(review, lane);
    if (!evidence) return false;
    const { run, launchState, providerResult, effect } = evidence;
    return launchState === "started" && run.status === "completed" &&
      effect.resultKind === "success" && providerResult.kind === "success" &&
      providerResult.agent === lane.agent && isDeepStrictEqual(providerResult, lane.result) &&
      effect.terminalAt === lane.terminalAt &&
      effect.providerAdmissionClaimedAt === attempt.providerAdmissionClaimedAt;
  }

  private hasExactUnavailableRunnerEvidence(
    review: ReviewRow,
    lane: ReviewLaneSnapshot,
    error: unknown,
    terminalAt: number,
  ): boolean {
    const attempt = lane.attempts.at(-1);
    if (!attempt || attempt.status !== "provider_unavailable") return false;
    return this.hasExactUnavailableAttemptEvidence(review, lane, attempt, error, terminalAt);
  }

  private hasExactUnavailableAttemptEvidence(
    review: ReviewRow,
    lane: ReviewLaneSnapshot,
    attempt: ReviewAttemptSnapshot,
    error: unknown,
    terminalAt: number,
  ): boolean {
    if (attempt.status !== "provider_unavailable") return false;
    if (!attemptMatchesLaneIdentity(lane, attempt)) return false;
    const evidence = this.exactRunnerEvidenceForAttempt(review, lane, attempt);
    if (!evidence) return false;
    const { run, launchState, providerResult, effect } = evidence;
    const exactLaunchOutcome = launchState === "started" ||
      (launchState === "proven_no_spawn" && providerResult.kind === "cli_missing") ||
      launchState === "admission_fenced";
    return exactLaunchOutcome && run.status === "completed" && isFailoverOutcome(providerResult.kind) &&
      effect.resultKind === providerResult.kind && effect.terminalAt === terminalAt &&
      effect.providerAdmissionClaimedAt === attempt.providerAdmissionClaimedAt &&
      isDeepStrictEqual(providerResult, sanitizeResult(error));
  }

  private exactRunnerEvidence(review: ReviewRow, lane: ReviewLaneSnapshot): {
    run: NonNullable<ReturnType<RunStore["getByIdempotencyKey"]>>;
    envelope: Record<string, unknown>;
    providerResult: Record<string, unknown>;
    effect: Record<string, unknown>;
    launchState: "started" | "proven_no_spawn" | "admission_fenced";
  } | null {
    const attempt = lane.attempts.at(-1);
    if (!attempt) return null;
    if (!attemptMatchesLaneIdentity(lane, attempt)) return null;
    return this.exactRunnerEvidenceForAttempt(review, lane, attempt);
  }

  private exactRunnerEvidenceForAttempt(
    review: ReviewRow,
    lane: ReviewLaneSnapshot,
    attempt: ReviewAttemptSnapshot,
  ): {
    run: NonNullable<ReturnType<RunStore["getByIdempotencyKey"]>>;
    envelope: Record<string, unknown>;
    providerResult: Record<string, unknown>;
    effect: Record<string, unknown>;
    launchState: "started" | "proven_no_spawn" | "admission_fenced";
  } | null {
    const run = this.runs.getByIdempotencyKey(attempt.idempotencyKey);
    if (!run || run.attemptCount <= 0) return null;
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
    if (!envelope || !providerResult || !effect) return null;
    let expected: ReturnType<typeof createReviewRunInput>;
    try {
      expected = createReviewRunInput(this.descriptorForAttempt(review, lane, attempt));
    } catch {
      return null;
    }
    const exactLaunchIdentity = launch !== null &&
      launch.agent === lane.agent && launch.model === attempt.model &&
      launch.effort === attempt.effort && launch.policyVersion === attempt.policyVersion &&
      launch.sessionId === attempt.sessionId;
    const started = run.launched && launch?.phase === "started" &&
      Number.isSafeInteger(launch.pid) && Number(launch.pid) > 0 && exactLaunchIdentity;
    const provenNoSpawn = !run.launched && launch?.phase === "proven_no_spawn" &&
      launch.pid === undefined && launch.value === undefined && exactLaunchIdentity;
    const fence = providerResult.admissionFenceReceipt as Record<string, unknown> | undefined;
    const admissionFenced = !run.launched && fence?.schemaVersion === "review-admission-fence/v1" &&
      fence.runId === run.id && fence.reviewId === review.review_id &&
      fence.attemptId === attempt.attemptId && fence.role === lane.role &&
      fence.agent === lane.agent &&
      typeof fence.capabilityVerified === "boolean" && typeof fence.attemptClaimed === "boolean" &&
      !(fence.observedHealth === "healthy" && fence.capabilityVerified && !fence.attemptClaimed) &&
      Number.isSafeInteger(fence.observedAt) && launch?.pid === undefined && launch?.value === undefined;
    const exact = (
      (envelope?.domainEffect === "pending" || envelope?.domainEffect === "applying" ||
        envelope?.domainEffect === "applied") &&
      (started || provenNoSpawn || admissionFenced) &&
      run.idempotencyKey === expected.idempotencyKey && run.stage === expected.stage &&
      run.priority === expected.priority && run.artifactHash === expected.artifactHash &&
      run.approvalScope === expected.approvalScope && isDeepStrictEqual(run.payload, expected.payload) &&
      payload.reviewId === review.review_id && payload.reviewRole === lane.role &&
      payload.reviewAttemptId === attempt.attemptId &&
      payload.reviewAttemptOrdinal === attempt.attemptOrdinal &&
      payload.sessionId === attempt.sessionId && payload.sourceFingerprint === review.source_fingerprint &&
      effect?.type === "review" && effect.reviewId === review.review_id &&
      effect.attemptId === attempt.attemptId && effect.role === lane.role &&
      effect.agent === lane.agent && providerResult.agent === lane.agent
    );
    return exact ? { run, envelope, providerResult, effect,
      launchState: started ? "started" : provenNoSpawn ? "proven_no_spawn" : "admission_fenced" } : null;
  }

  deferredReviewIds(agent: ReviewProviderId): string[] {
    return (this.db.prepare(`SELECT DISTINCT review_id FROM runtime_review_lanes
      WHERE agent=? AND status='deferred' ORDER BY review_id`).all(agent) as Array<{ review_id: string }>)
      .map((row) => row.review_id);
  }

  admissionTuple(reviewId: string, agent: ReviewProviderId, role: ReviewRole): {
    laneRevision: number; latestOrdinal: number | null; latestEvidenceHash: string | null;
  } {
    const lanes = this.laneRows(reviewId);
    assertExactReviewTopology(lanes);
    const lane = lanes.find((candidate) =>
      candidate.agent === agent && candidate.role === role);
    if (!lane) throw new Error("Unknown review lane");
    const attempts = this.attemptsFor(reviewId, agent, role);
    const latest = attempts.at(-1);
    const latestEvidenceHash = latest?.status === "provider_unavailable" && latest.error !== undefined
      ? canonicalHash(latest.error)
      : null;
    return {
      laneRevision: lane.lane_revision ?? 0,
      latestOrdinal: latest?.attemptOrdinal ?? null,
      latestEvidenceHash,
    };
  }

  receiptPairCursor(input: { sourceScope: string; readinessScope: string }): {
    scopeRevision: number;
    predecessorReceiptIds: { source: string | null; readiness: string | null };
  } {
    const head = (scope: string) => this.db.prepare(`SELECT receipt_id,scope_revision
      FROM runtime_review_receipts WHERE scope=?
      ORDER BY scope_revision DESC,created_at DESC,receipt_id DESC LIMIT 1`).get(scope) as
      { receipt_id: string; scope_revision: number } | undefined;
    const source = head(input.sourceScope);
    const readiness = head(input.readinessScope);
    if ((source === undefined) !== (readiness === undefined) ||
        (source && readiness && source.scope_revision !== readiness.scope_revision)) {
      throw new Error("receipt pair cursor has mixed heads");
    }
    return {
      scopeRevision: (source?.scope_revision ?? 0) + 1,
      predecessorReceiptIds: {
        source: source?.receipt_id ?? null,
        readiness: readiness?.receipt_id ?? null,
      },
    };
  }

  receiptCursor(scope: string): { scopeRevision: number; predecessorReceiptId: string | null } {
    const latest = this.db.prepare(`SELECT receipt_id,scope_revision FROM runtime_review_receipts
      WHERE scope=? ORDER BY scope_revision DESC,created_at DESC,receipt_id DESC LIMIT 1`).get(scope) as
      { receipt_id: string; scope_revision: number } | undefined;
    return { scopeRevision: (latest?.scope_revision ?? 0) + 1,
      predecessorReceiptId: latest?.receipt_id ?? null };
  }

  private activateDeferredV3(input: {
    reviewId: string;
    agent: ReviewProviderId;
    now: number;
    recoveryGeneration: number | null;
    admissionReceipts: ReviewAdmissionReceiptPair[];
    faultInjector?: (point: string) => void;
  }): {
    status: "activated" | "stale_artifact" | "satisfied" | "none" |
      "provider_unavailable" | "needs_reconciliation";
    lanes: LaneEnqueueDescriptor[];
  } {
    input.faultInjector?.("before_activation_begin");
    const activate = this.db.transaction(() => {
      input.faultInjector?.("after_activation_begin");
      const review = this.reviewRow(input.reviewId);
      if (!review) throw new Error(`Unknown review: ${input.reviewId}`);
      if (this.barrier(input.reviewId).satisfied) {
        return { status: "satisfied" as const, lanes: [] };
      }
      if (input.recoveryGeneration === null || !Number.isSafeInteger(input.recoveryGeneration)) {
        return { status: "none" as const, lanes: [] };
      }
      const generationExists = this.db.prepare(`SELECT 1 FROM runtime_provider_recovery_generations
        WHERE agent=? AND generation=?`).get(input.agent, input.recoveryGeneration);
      if (!generationExists) return { status: "none" as const, lanes: [] };
      const health = this.db.prepare(`SELECT health,capability_verified,attempt_claimed
        FROM runtime_provider_health WHERE agent=?`).get(input.agent) as
        { health: string; capability_verified: number; attempt_claimed: number } | undefined;
      if (!health || health.health !== "healthy" || health.capability_verified !== 1 ||
          health.attempt_claimed !== 0) {
        return { status: "provider_unavailable" as const, lanes: [] };
      }

      const existingConsumptions = this.db.prepare(`SELECT role,authority_id
        FROM runtime_review_generation_consumptions
        WHERE review_id=? AND agent=? AND generation=? ORDER BY role`).all(
          input.reviewId, input.agent, input.recoveryGeneration,
        ) as Array<{ role: ReviewRole; authority_id: string }>;
      const orphanPendingAdmissionReceipts = (): void => {
        for (const pair of input.admissionReceipts) {
          for (const receiptId of [pair.sourceReceiptId, pair.readinessReceiptId]) {
            const pending = this.db.prepare(`SELECT r.* FROM runtime_review_receipts r
              LEFT JOIN runtime_review_receipt_lifecycle l ON l.receipt_id=r.receipt_id
              WHERE r.receipt_id=? AND l.receipt_id IS NULL`).get(receiptId) as Record<string, unknown> | undefined;
            if (!pending) continue;
            this.db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
              (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
               recovery_generation,predecessor_receipt_id,recorded_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(
                pending.receipt_id, "orphaned", pending.scope_revision, pending.activation_nonce,
                pending.expected_tuple_json, pending.recovery_generation,
                pending.predecessor_receipt_id, input.now);
            this.db.prepare(`DELETE FROM runtime_review_receipt_heads
              WHERE scope=? AND receipt_id=?`).run(pending.scope, pending.receipt_id);
          }
        }
      };
      if (existingConsumptions.length > 0 && existingConsumptions.every(({ role, authority_id }) => {
        if (typeof authority_id !== "string") return false;
        const authorityOrdinal = this.db.prepare(`SELECT attempt_ordinal
          FROM runtime_review_attempt_authorities WHERE authority_id=?`).pluck().get(authority_id);
        const latestOrdinal = this.db.prepare(`SELECT MAX(attempt_ordinal)
          FROM runtime_review_lane_attempts WHERE review_id=? AND agent=? AND role=?`)
          .pluck().get(input.reviewId, input.agent, role);
        return authorityOrdinal !== undefined && authorityOrdinal === latestOrdinal;
      }) && existingConsumptions.length === REVIEW_ROLES.length &&
          REVIEW_ROLES.every((role) => existingConsumptions.some((row) => row.role === role))) {
        orphanPendingAdmissionReceipts();
        const lanes = existingConsumptions.map(({ role }) => {
          const lane = this.snapshot(review).lanes.find((candidate) =>
            candidate.agent === input.agent && candidate.role === role)!;
          const attempt = lane.attempts.find((candidate) => {
            const link = this.db.prepare(`SELECT recovery_generation FROM runtime_review_lane_attempts
              WHERE attempt_id=?`).pluck().get(candidate.attemptId);
            return link === input.recoveryGeneration;
          })!;
          const authority = this.db.prepare(`SELECT authority_id,admission_source_receipt_id,
            admission_readiness_receipt_id FROM runtime_review_attempt_authorities
            WHERE attempt_id=?`).get(attempt.attemptId) as Record<string, unknown>;
          const link = this.db.prepare(`SELECT recovery_generation,previous_ordinal,
            previous_evidence_hash FROM runtime_review_lane_attempts WHERE attempt_id=?`)
            .get(attempt.attemptId) as Record<string, unknown>;
          return {
            ...this.descriptorForAttempt(review, lane, attempt),
            recoveryGeneration: Number(link.recovery_generation),
            ...(link.previous_ordinal === null ? {} : { previousOrdinal: Number(link.previous_ordinal) }),
            ...(link.previous_evidence_hash === null ? {}
              : { previousEvidenceHash: String(link.previous_evidence_hash) }),
            sourceReceiptId: String(authority.admission_source_receipt_id),
            readinessReceiptId: String(authority.admission_readiness_receipt_id),
            authorityId: String(authority.authority_id),
          };
        });
        return { status: "activated" as const, lanes };
      }
      if (existingConsumptions.length > 0) {
        orphanPendingAdmissionReceipts();
        return { status: "needs_reconciliation" as const, lanes: [] };
      }

      const receiptRoles = input.admissionReceipts.map(({ role }) => role).sort();
      const deferredRoles = this.laneRows(input.reviewId)
        .filter((lane) => lane.agent === input.agent && lane.status === "deferred")
        .map(({ role }) => role).sort();
      const exactPair = input.admissionReceipts.length === REVIEW_ROLES.length &&
        input.admissionReceipts.every((pair) => pair.agent === undefined || pair.agent === input.agent) &&
        REVIEW_ROLES.every((role, index) => receiptRoles[index] === role) &&
        REVIEW_ROLES.every((role, index) => deferredRoles[index] === role);
      if (!exactPair) {
        orphanPendingAdmissionReceipts();
        return { status: "none" as const, lanes: [] };
      }

      type ReceiptRow = Record<string, unknown>;
      const prepared: Array<{
        lane: LaneRow; pair: ReviewAdmissionReceiptPair; source: ReceiptRow;
        readiness: ReceiptRow; tuple: ReturnType<RunGateUnitOfWork["admissionTuple"]>;
      }> = [];
      for (const pair of input.admissionReceipts) {
        if (pair.agent !== undefined && pair.agent !== input.agent) continue;
        const lane = this.laneRows(input.reviewId).find((candidate) =>
          candidate.agent === input.agent && candidate.role === pair.role &&
          candidate.status === "deferred");
        if (!lane) continue;
        const tuple = this.admissionTuple(input.reviewId, input.agent, pair.role);
        const read = (receiptId: string, kind: "source" | "readiness") =>
          this.db.prepare(`SELECT r.*,h.receipt_id AS head_receipt_id,x.state AS lifecycle_state
            FROM runtime_review_receipts r
            LEFT JOIN runtime_review_receipt_heads h ON h.scope=r.scope
            LEFT JOIN runtime_review_receipt_lifecycle x ON x.receipt_id=r.receipt_id
            WHERE r.receipt_id=?`).get(receiptId) as ReceiptRow | undefined;
        const source = read(pair.sourceReceiptId, "source");
        const readiness = read(pair.readinessReceiptId, "readiness");
        const exact = (receipt: ReceiptRow | undefined, id: string, kind: "source" | "readiness") =>
          receipt !== undefined && receipt.phase === "admission" &&
          receipt.scope === `review/${input.reviewId}/${input.agent}/${pair.role}/${kind}` &&
          receipt.head_receipt_id === id && receipt.lifecycle_state == null &&
          receipt.activation_nonce === pair.activationNonce &&
          receipt.recovery_generation === input.recoveryGeneration &&
          isDeepStrictEqual(JSON.parse(String(receipt.expected_tuple_json)), tuple);
        if (!source || !readiness) {
          return { status: "needs_reconciliation" as const, lanes: [] };
        }
        if (!exact(source, pair.sourceReceiptId, "source") ||
            !exact(readiness, pair.readinessReceiptId, "readiness")) continue;
        const sourceObservation = JSON.parse(String(source!.observation_json)) as Record<string, unknown>;
        const readinessObservation = JSON.parse(String(readiness!.observation_json)) as Record<string, unknown>;
        if (sourceObservation.valid !== true || readinessObservation.valid !== true ||
            readinessObservation.harnessReady !== true) continue;
        if (sourceObservation.sourceFingerprint !== review.source_fingerprint) {
          this.db.prepare(`UPDATE runtime_review_lanes SET status='stale_artifact',
            terminal_at=COALESCE(terminal_at,?),lane_revision=lane_revision+1
            WHERE review_id=? AND agent=? AND status='deferred'`)
            .run(input.now, input.reviewId, input.agent);
          return { status: "stale_artifact" as const, lanes: [] };
        }
        prepared.push({ lane, pair, source: source!, readiness: readiness!, tuple });
      }
      if (prepared.length !== REVIEW_ROLES.length ||
          !REVIEW_ROLES.every((role) => prepared.some(({ lane }) => lane.role === role))) {
        orphanPendingAdmissionReceipts();
        return { status: "none" as const, lanes: [] };
      }

      const descriptors: LaneEnqueueDescriptor[] = [];
      for (const { lane, pair, source, readiness, tuple } of prepared) {
        const latest = this.attemptsFor(input.reviewId, input.agent, lane.role).at(-1);
        if (latest && latest.status !== "provider_unavailable") {
          throw new Error("review provider pair has a non-rejoinable lane attempt");
        }
        const ordinal = latest ? latest.attemptOrdinal + 1 : 0;
        const authorityKind = latest ? "recovery" : "first_admission";
        const policy = this.db.prepare(`SELECT * FROM runtime_review_attempt_base_policies
          WHERE review_id=? AND agent=? AND role=?`).get(input.reviewId, input.agent, lane.role) as
          Record<string, unknown> | undefined;
        if (!policy) throw new Error("review lane lacks immutable base policy");
        const identity = createReviewAttemptIdentity({
          reviewId: input.reviewId, barrierIdempotencyKey: review.idempotency_key,
          agent: input.agent, role: lane.role, ordinal,
          ...(ordinal === 0 ? {
            legacySessionId: String(policy.legacy_session_id),
            legacyIdempotencyKey: String(policy.legacy_idempotency_key),
          } : {}),
        });
        const previousEvidenceHash = latest?.error === undefined ? null
          : canonicalHash(latest.error);
        const authorityBytes = JSON.stringify({ reviewId: input.reviewId, agent: input.agent,
          role: lane.role, attemptId: identity.attemptId, attemptOrdinal: ordinal,
          authorityKind, recoveryGeneration: input.recoveryGeneration,
          previousOrdinal: latest?.attemptOrdinal ?? null, previousEvidenceHash,
          sourceReceiptId: pair.sourceReceiptId, readinessReceiptId: pair.readinessReceiptId,
          activationNonce: pair.activationNonce });
        const authorityHash = createHash("sha256").update(authorityBytes).digest("hex");
        const authorityId = `review-authority-${authorityHash}`;
        const claimed = this.db.prepare(`UPDATE runtime_review_lanes
          SET status='queued',lane_revision=lane_revision+1,degraded=1,result=NULL,error=NULL,
              terminal_at=NULL,model=?,effort=?,policy_version=?,reasons=?,session_id=?,idempotency_key=?
          WHERE review_id=? AND agent=? AND role=? AND status='deferred' AND lane_revision=?`).run(
            policy.model, policy.effort, policy.policy_version, policy.reasons_json,
            identity.sessionId, identity.idempotencyKey, input.reviewId, input.agent, lane.role,
            tuple.laneRevision,
          ).changes;
        if (claimed !== 1) throw new Error("review provider pair activation CAS lost");
        input.faultInjector?.("after_lane_cas");
        this.db.prepare(`INSERT INTO runtime_review_generation_consumptions
          (generation,review_id,agent,role,authority_id) VALUES (?,?,?,?,?)`).run(
            input.recoveryGeneration, input.reviewId, input.agent, lane.role, authorityId);
        input.faultInjector?.("after_generation_consumption");
        this.db.prepare(`INSERT INTO runtime_review_attempt_authorities
          (authority_id,review_id,agent,role,attempt_id,attempt_ordinal,authority_kind,
           recovery_generation,previous_ordinal,previous_evidence_hash,
           admission_source_receipt_id,admission_readiness_receipt_id,activation_nonce,
           authority_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            authorityId, input.reviewId, input.agent, lane.role, identity.attemptId, ordinal,
            authorityKind, input.recoveryGeneration, latest?.attemptOrdinal ?? null,
            previousEvidenceHash, pair.sourceReceiptId, pair.readinessReceiptId,
            pair.activationNonce, authorityHash, input.now,
          );
        input.faultInjector?.("after_attempt_authority_insert");
        const descriptor: LaneEnqueueDescriptor = {
          reviewId: input.reviewId, stageId: review.stage_id, agent: input.agent, role: lane.role,
          artifact: Buffer.from(review.artifact), artifactHash: review.artifact_hash,
          approvalScope: review.approval_scope,
          model: policy.model as EffortDecision["model"],
          effort: policy.effort as "high" | "xhigh" | "max",
          policyVersion: policy.policy_version as PersistedRoutingPolicyVersion,
          reasons: parseReasons(String(policy.reasons_json)), sessionId: identity.sessionId,
          idempotencyKey: identity.idempotencyKey, prompt: lane.prompt, degraded: true,
          attemptId: identity.attemptId, attemptOrdinal: ordinal,
          recoveryGeneration: input.recoveryGeneration,
          ...(latest ? { previousOrdinal: latest.attemptOrdinal,
            previousEvidenceHash: previousEvidenceHash! } : {}),
          sourceReceiptId: pair.sourceReceiptId, readinessReceiptId: pair.readinessReceiptId,
          authorityId,
          ...(review.project === null ? {} : { project: review.project }),
          ...(review.requester === null ? {} : { requester: review.requester }),
          ...(review.source_fingerprint === null ? {} : { sourceFingerprint: review.source_fingerprint }),
        };
        const run = this.runs.enqueueExact(createReviewRunInput({
          ...descriptor, scheduledAt: input.now,
        }));
        input.faultInjector?.("after_run_insert");
        this.db.prepare(`INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,run_id,created_at,attempt_id,authority_id,
           base_policy_id,authority_kind,model,effort,policy_version,reasons_json,session_id,
           idempotency_key,recovery_generation,previous_ordinal,previous_evidence_hash,
           expected_lane_revision,expected_attempt_ordinal,authority_receipt_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            input.reviewId, input.agent, lane.role, ordinal, run.id, input.now,
            identity.attemptId, authorityId, policy.base_policy_id, authorityKind,
            policy.model, policy.effort, policy.policy_version, policy.reasons_json,
            identity.sessionId, identity.idempotencyKey, input.recoveryGeneration,
            latest?.attemptOrdinal ?? null, previousEvidenceHash, tuple.laneRevision,
            ordinal, authorityHash,
          );
        input.faultInjector?.("after_attempt_link_insert");
        const terminal = this.db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
          (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
           recovery_generation,predecessor_receipt_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const receipt of [source, readiness]) {
          terminal.run(receipt.receipt_id, "consumed", receipt.scope_revision,
            receipt.activation_nonce, receipt.expected_tuple_json, receipt.recovery_generation,
            receipt.predecessor_receipt_id, input.now);
          this.db.prepare(`DELETE FROM runtime_review_receipt_heads
            WHERE scope=? AND receipt_id=?`).run(receipt.scope, receipt.receipt_id);
        }
        input.faultInjector?.("after_projection_update");
        descriptors.push(descriptor);
      }
      input.faultInjector?.("before_activation_commit");
      if (descriptors.length !== REVIEW_ROLES.length) {
        throw new Error("review provider pair activation was not atomic");
      }
      return { status: "activated" as const, lanes: descriptors };
    });
    const result = activate.immediate();
    input.faultInjector?.("after_activation_commit_before_response");
    return result;
  }

  activateDeferred(input: {
    reviewId: string;
    agent: ReviewProviderId;
    currentSourceFingerprint?: string;
    now: number;
    providerHealth?: ProviderHealthStore;
    harnessReady?: boolean;
    recoveryGeneration?: number | null;
    admissionReceipts?: ReviewAdmissionReceiptPair[];
    faultInjector?: (point: string) => void;
  }): {
    status: "activated" | "provider_unavailable" | "harness_unavailable" | "stale_artifact" |
      "satisfied" | "needs_reconciliation" | "none";
    lanes: LaneEnqueueDescriptor[];
  } {
    const review = this.reviewRow(input.reviewId);
    if (review === undefined) throw new Error(`Unknown review: ${input.reviewId}`);
    if (review.launch_authority_version === 3) {
      const raw = input as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(raw, "currentSourceFingerprint") ||
          Object.prototype.hasOwnProperty.call(raw, "providerHealth") ||
          Object.prototype.hasOwnProperty.call(raw, "harnessReady")) {
        throw new Error("authority-v3 activation rejects legacy raw readiness, health, and source evidence");
      }
      return this.activateDeferredV3({
        reviewId: input.reviewId, agent: input.agent, now: input.now,
        recoveryGeneration: input.recoveryGeneration ?? null,
        admissionReceipts: input.admissionReceipts ?? [],
        ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
      });
    }
    if (input.harnessReady !== true) return { status: "harness_unavailable", lanes: [] };
    let preflightStatus: "satisfied" | "stale_artifact" | null = null;
    this.db.transaction(() => {
      if (this.barrier(input.reviewId).satisfied) {
        preflightStatus = "satisfied";
        return;
      }
      if (review.source_fingerprint !== null &&
          review.source_fingerprint !== input.currentSourceFingerprint) {
        this.db.prepare(`
          UPDATE runtime_review_lanes
             SET status = 'stale_artifact', terminal_at = COALESCE(terminal_at, ?)
           WHERE review_id = ? AND agent = ? AND status = 'deferred'
        `).run(input.now, input.reviewId, input.agent);
        preflightStatus = "stale_artifact";
      }
    }).immediate();
    if (preflightStatus !== null) return { status: preflightStatus, lanes: [] };
    if (review.launch_authority_version !== 2) return { status: "none", lanes: [] };
    if (!input.providerHealth) return { status: "provider_unavailable", lanes: [] };
    const admission = input.providerHealth.acquireAdmission(input.agent, input.now);
    if (!admission.runnable) {
      return { status: "provider_unavailable", lanes: [] };
    }
    let barrierSatisfied = false;
    const activate = this.db.transaction(() => {
      if (this.barrier(input.reviewId).satisfied) {
        barrierSatisfied = true;
        return [];
      }
      const deferred = this.laneRows(input.reviewId).filter(
        (lane) => lane.agent === input.agent && lane.status === "deferred" &&
          this.attemptsFor(input.reviewId, lane.agent, lane.role).length === 0,
      );
      if (deferred.length !== REVIEW_ROLES.length ||
          !REVIEW_ROLES.every((role) => deferred.some((lane) => lane.role === role))) return [];
      const descriptors: LaneEnqueueDescriptor[] = [];
      for (const lane of deferred) {
        const claimed = this.db.prepare(`UPDATE runtime_review_lanes
          SET status='queued',degraded=1,result=NULL,error=NULL,terminal_at=NULL
          WHERE review_id=? AND agent=? AND role=? AND status='deferred'`).run(
            input.reviewId, lane.agent, lane.role,
          ).changes;
        if (claimed !== 1) throw new Error("review provider pair activation CAS lost");
        const descriptor: LaneEnqueueDescriptor = {
          reviewId: review.review_id,
          stageId: review.stage_id,
          agent: lane.agent,
          role: lane.role,
          artifact: Buffer.from(review.artifact),
          artifactHash: review.artifact_hash,
          approvalScope: review.approval_scope,
          model: lane.model,
          effort: lane.effort,
          policyVersion: lane.policy_version,
          reasons: parseReasons(lane.reasons),
          sessionId: lane.session_id,
          idempotencyKey: lane.idempotency_key,
          prompt: lane.prompt,
          degraded: true,
          attemptId: randomUUID(),
          attemptOrdinal: 0,
          ...(review.project === null ? {} : { project: review.project }),
          ...(review.requester === null ? {} : { requester: review.requester }),
          ...(review.source_fingerprint === null ? {} : { sourceFingerprint: review.source_fingerprint }),
        };
        const run = this.runs.enqueueExact(createReviewRunInput(descriptor));
        this.db.prepare(`INSERT INTO runtime_review_lane_attempts
          (review_id,agent,role,attempt_ordinal,run_id,created_at)
          VALUES (?,?,?,?,?,?)`).run(
            input.reviewId, lane.agent, lane.role, 0, run.id, input.now,
          );
        descriptors.push(descriptor);
      }
      if (descriptors.length !== REVIEW_ROLES.length) {
        throw new Error("review provider pair activation was not atomic");
      }
      return descriptors;
    });
    const lanes = activate.immediate();
    if (barrierSatisfied) return { status: "satisfied", lanes: [] };
    return lanes.length === 0 ? { status: "none", lanes } : { status: "activated", lanes };
  }

  applyPrelaunchFence(input: {
    attemptId?: string;
    prelaunchReceiptId: string;
    now: number;
    faultInjector?: (point: string) => void;
    reviewId?: string;
    runId?: string;
    agent?: ReviewProviderId;
    role?: ReviewRole;
    attemptOrdinal?: number;
  }): Record<string, unknown> {
    input.faultInjector?.("before_prelaunch_begin");
    if (!input.attemptId) {
      return { status: "no_spawn", reason: "needs_reconciliation" };
    }
    const apply = this.db.transaction(() => {
      input.faultInjector?.("after_prelaunch_begin");
      const link = this.db.prepare(`SELECT a.*,b.launch_authority_version,b.source_fingerprint,
          l.status AS lane_status
        FROM runtime_review_lane_attempts a
        JOIN runtime_review_barriers b ON b.review_id=a.review_id
        JOIN runtime_review_lanes l ON l.review_id=a.review_id AND l.agent=a.agent AND l.role=a.role
        WHERE a.attempt_id=?`).get(input.attemptId) as Record<string, unknown> | undefined;
      if (!link || link.launch_authority_version !== 3) {
        return { status: "no_spawn", reason: "needs_reconciliation" };
      }
      if ((input.reviewId !== undefined && input.reviewId !== link.review_id) ||
          (input.runId !== undefined && input.runId !== link.run_id) ||
          (input.agent !== undefined && input.agent !== link.agent) ||
          (input.role !== undefined && input.role !== link.role) ||
          (input.attemptOrdinal !== undefined && input.attemptOrdinal !== link.attempt_ordinal)) {
        return { status: "no_spawn", reason: "needs_reconciliation", attemptId: input.attemptId };
      }
      const attempt = this.attemptsFor(String(link.review_id), link.agent as ReviewProviderId,
        link.role as ReviewRole).find((candidate) => candidate.attemptId === input.attemptId);
      if (!attempt || attempt.status === "needs_reconciliation") {
        return { status: "no_spawn", reason: "needs_reconciliation", attemptId: input.attemptId };
      }
      const authority = this.db.prepare(`SELECT * FROM runtime_review_attempt_authorities
        WHERE authority_id=? AND attempt_id=?`).get(link.authority_id, input.attemptId) as
        Record<string, unknown> | undefined;
      if (!authority) {
        return { status: "no_spawn", reason: "needs_reconciliation", attemptId: input.attemptId };
      }

      const reconcileTarget = () => {
        this.db.prepare(`UPDATE runs SET status='needs_reconciliation',lease_token=NULL,
          lease_expires_at=NULL,worker_id=NULL WHERE id=?`).run(link.run_id);
        this.db.prepare(`UPDATE runtime_review_lanes SET status='needs_reconciliation',
          lane_revision=lane_revision+1 WHERE review_id=? AND agent=? AND role=?
          AND status<>'needs_reconciliation'`).run(link.review_id, link.agent, link.role);
        return { status: "no_spawn", reason: "needs_reconciliation",
          attemptId: input.attemptId, spawnAuthority: null };
      };
      const authorityValid = authority.authority_id === link.authority_id &&
        authority.attempt_id === input.attemptId && authority.review_id === link.review_id &&
        authority.agent === link.agent && authority.role === link.role &&
        authority.attempt_ordinal === link.attempt_ordinal &&
        authority.authority_hash === link.authority_receipt_id;
      if (!authorityValid) return reconcileTarget();

      const receiptById = (receiptId: string) => this.db.prepare(`SELECT r.*,
          h.receipt_id AS head_receipt_id,x.state AS lifecycle_state,
          x.predecessor_receipt_id AS lifecycle_predecessor_receipt_id
        FROM runtime_review_receipts r
        LEFT JOIN runtime_review_receipt_heads h ON h.scope=r.scope
        LEFT JOIN runtime_review_receipt_lifecycle x ON x.receipt_id=r.receipt_id
        WHERE r.receipt_id=?`).get(receiptId) as Record<string, unknown> | undefined;
      const receiptEnvelopeValid = (candidate: Record<string, unknown>): boolean => {
        try {
          const observation = JSON.parse(String(candidate.observation_json));
          return canonicalHash(observation) === candidate.observation_hash &&
            createHash("sha256").update(String(candidate.canonical_bytes)).digest("hex") ===
              candidate.envelope_hash;
        } catch { return false; }
      };
      const chainValid = (candidate: Record<string, unknown>): boolean => {
        const seen = new Set<string>();
        let current: Record<string, unknown> | undefined = candidate;
        while (current) {
          const id = String(current.receipt_id);
          if (seen.has(id) || !receiptEnvelopeValid(current)) return false;
          seen.add(id);
          const revision = Number(current.scope_revision);
          const predecessorId = current.predecessor_receipt_id;
          if (revision === 1) return predecessorId === null;
          if (typeof predecessorId !== "string") return false;
          const predecessor = receiptById(predecessorId);
          if (!predecessor || predecessor.scope !== current.scope ||
              Number(predecessor.scope_revision) !== revision - 1) return false;
          current = predecessor;
        }
        return false;
      };
      const isCurrentPending = (candidate: Record<string, unknown> | undefined): boolean =>
        candidate !== undefined && candidate.phase === "prelaunch" &&
        candidate.scope === `attempt/${input.attemptId}/prelaunch` &&
        candidate.head_receipt_id === candidate.receipt_id &&
        candidate.lifecycle_state == null && candidate.recovery_generation === null &&
        isDeepStrictEqual(JSON.parse(String(candidate.expected_tuple_json)),
          { attemptId: input.attemptId }) && chainValid(candidate);
      const terminalize = (candidate: Record<string, unknown>, state: "consumed" | "orphaned") => {
        this.db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
          (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
           recovery_generation,predecessor_receipt_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)`).run(
            candidate.receipt_id, state, candidate.scope_revision, candidate.activation_nonce,
            candidate.expected_tuple_json, candidate.recovery_generation,
            candidate.predecessor_receipt_id, input.now);
        if (state === "orphaned") input.faultInjector?.("after_replay_orphan_insert");
        this.db.prepare(`DELETE FROM runtime_review_receipt_heads
          WHERE scope=? AND receipt_id=?`).run(candidate.scope, candidate.receipt_id);
      };

      const existingNoSpawn = this.db.prepare(`SELECT * FROM runtime_review_no_spawn_effects
        WHERE attempt_id=?`).get(input.attemptId) as Record<string, unknown> | undefined;
      if (existingNoSpawn) {
        const replayReceipt = receiptById(input.prelaunchReceiptId);
        if (isCurrentPending(replayReceipt)) terminalize(replayReceipt!, "orphaned");
        return { status: "no_spawn", reason: existingNoSpawn.reason,
          attemptId: input.attemptId, spawnAuthority: null };
      }

      const committed = this.db.prepare(`SELECT * FROM runtime_review_spawn_authorities
        WHERE attempt_id=?`).get(input.attemptId) as Record<string, unknown> | undefined;
      if (committed) {
        const original = receiptById(String(committed.prelaunch_receipt_id));
        const committedValid = committed.attempt_authority_id === authority.authority_id &&
          original !== undefined && original.lifecycle_state === "consumed" &&
          original.lifecycle_predecessor_receipt_id === original.predecessor_receipt_id &&
          chainValid(original);
        if (!committedValid) return reconcileTarget();
        const authorized = {
          status: "authorized", attemptId: input.attemptId,
          authorityId: committed.attempt_authority_id,
          spawnAuthority: {
            authorityId: committed.attempt_authority_id,
            authorityHash: committed.authority_hash,
          },
        };
        if (input.prelaunchReceiptId === committed.prelaunch_receipt_id) return authorized;
        const replayReceipt = receiptById(input.prelaunchReceiptId);
        if (!isCurrentPending(replayReceipt)) {
          return { status: "no_spawn", reason: "needs_reconciliation",
            attemptId: input.attemptId, spawnAuthority: null };
        }
        const equivalent = replayReceipt!.observation_hash === original.observation_hash;
        terminalize(replayReceipt!, "orphaned");
        return equivalent ? authorized : { status: "no_spawn", reason: "needs_reconciliation",
          attemptId: input.attemptId, spawnAuthority: null };
      }

      const receipt = receiptById(input.prelaunchReceiptId);
      input.faultInjector?.("after_prelaunch_receipt_read");

      const persistNoSpawn = (reason: "stale_artifact" | "provider_unavailable" |
        "needs_reconciliation") => {
        this.db.prepare(`INSERT INTO runtime_review_no_spawn_effects
          (attempt_id,reason,prelaunch_receipt_id,recorded_at) VALUES (?,?,?,?)`).run(
            input.attemptId, reason, receipt?.receipt_id ?? null, input.now);
        input.faultInjector?.("after_no_spawn_effect_insert");
        const laneStatus = reason === "stale_artifact" ? "stale_artifact"
          : reason === "provider_unavailable" ? "deferred" : "needs_reconciliation";
        this.db.prepare(`UPDATE runtime_review_lanes SET status=?,lane_revision=lane_revision+1,
          terminal_at=CASE WHEN ?='stale_artifact' THEN COALESCE(terminal_at,?) ELSE terminal_at END
          WHERE review_id=? AND agent=? AND role=?`).run(
            laneStatus, reason, input.now, link.review_id, link.agent, link.role);
        if (receipt && isCurrentPending(receipt)) terminalize(receipt, "consumed");
        return { status: "no_spawn", reason, attemptId: input.attemptId, spawnAuthority: null };
      };

      if (!isCurrentPending(receipt)) {
        return { status: "no_spawn", reason: "needs_reconciliation",
          attemptId: input.attemptId, spawnAuthority: null };
      }

      const observation = JSON.parse(String(receipt!.observation_json)) as Record<string, unknown>;
      const source = observation.source as Record<string, unknown> | undefined;
      const readiness = observation.readiness as Record<string, unknown> | undefined;
      const sourceHash = source ? canonicalHash(source) : null;
      const readinessHash = readiness ? canonicalHash(readiness) : null;
      const admissionSourceHash = this.db.prepare(`SELECT observation_hash FROM runtime_review_receipts
        WHERE receipt_id=?`).pluck().get(authority.admission_source_receipt_id);
      const admissionReadinessHash = this.db.prepare(`SELECT observation_hash FROM runtime_review_receipts
        WHERE receipt_id=?`).pluck().get(authority.admission_readiness_receipt_id);
      const providerHealth = this.db.prepare(`SELECT health,capability_verified,attempt_claimed
        FROM runtime_provider_health WHERE agent=?`).get(link.agent) as
        { health: string; capability_verified: number; attempt_claimed: number } | undefined;
      let reason: "stale_artifact" | "provider_unavailable" | null = null;
      if (!source || source.valid !== true || sourceHash !== admissionSourceHash ||
          observation.sourceObservationHash !== sourceHash) reason = "stale_artifact";
      else if (!providerHealth || providerHealth.health !== "healthy" ||
          providerHealth.capability_verified !== 1 || providerHealth.attempt_claimed !== 0) {
        reason = "provider_unavailable";
      }
      else if (!readiness || readiness.valid !== true || readiness.harnessReady !== true ||
          readinessHash !== admissionReadinessHash ||
          observation.readinessObservationHash !== readinessHash) reason = "provider_unavailable";
      input.faultInjector?.("after_prelaunch_decision");
      if (reason) {
        const result = persistNoSpawn(reason);
        input.faultInjector?.("before_prelaunch_commit");
        return result;
      }

      const authorityHash = canonicalHash({
        attemptId: input.attemptId, attemptAuthorityId: authority.authority_id,
        prelaunchReceiptId: input.prelaunchReceiptId,
        prelaunchObservationHash: receipt!.observation_hash,
      });
      this.db.prepare(`INSERT INTO runtime_review_spawn_authorities
        (attempt_id,attempt_authority_id,prelaunch_receipt_id,authority_hash,created_at)
        VALUES (?,?,?,?,?)`).run(
          input.attemptId, authority.authority_id, input.prelaunchReceiptId, authorityHash, input.now);
      input.faultInjector?.("after_spawn_authority_insert");
      terminalize(receipt!, "consumed");
      input.faultInjector?.("before_prelaunch_commit");
      return {
        status: "authorized", attemptId: input.attemptId,
        authorityId: authority.authority_id,
        spawnAuthority: { authorityId: authority.authority_id, authorityHash },
      };
    });
    return apply.immediate();
  }

  close(): void {
    this.runs.close();
    this.closeAccess();
  }
}
