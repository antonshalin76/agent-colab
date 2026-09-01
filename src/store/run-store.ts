import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { sanitizeResult } from "../security/redaction.js";
import { openStateStoreAccess, type StateStoreInput } from "./state-database-fence.js";

export type RunStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled" | "needs_reconciliation";
export interface RunRecord {
  id: string; idempotencyKey: string; stage: string; priority: number; status: RunStatus;
  artifactHash?: string | undefined; approvalScope?: string | undefined; createdAt: number; nextAttemptAt: number;
  leaseToken?: string | undefined; leaseExpiresAt?: number | undefined; workerId?: string | undefined; launched: boolean;
  launchInfo?: unknown | undefined; result?: unknown | undefined; cancelReason?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  attemptCount: number;
  dependsOnRunId?: string | undefined;
}
export interface EnqueueInput {
  idempotencyKey: string; stage: string; priority: number; now?: number;
  artifactHash?: string; approvalScope?: string;
  payload?: Record<string, unknown>; notBefore?: number; dependsOnRunId?: string;
}

export interface DomainEffectEnvelope {
  domainEffect: "pending" | "applying" | "applied" | "quarantined";
  providerResult: Record<string, unknown>;
  effect: Record<string, unknown>;
  replayLease?: { owner: string; expiresAt: number };
  replayError?: unknown;
  quarantineError?: unknown;
}

type DbRow = Record<string, unknown>;
const parse = (value: unknown) => value == null ? undefined : JSON.parse(String(value));

export class RunStore {
  protected readonly db: Database.Database;
  private readonly closeAccess: () => void;
  constructor(pathOrDatabase: StateStoreInput) {
    const opened = openStateStoreAccess(pathOrDatabase);
    try {
      this.db = opened.access.database;
      this.closeAccess = opened.close;
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      const columns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name));
      const index = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='runs_due'",
      ).get();
      if (["payload", "attempt_count", "depends_on_run_id", "launch_info", "launched"]
        .some((required) => !columns.has(required)) || index === undefined) {
        throw new Error("runs table requires current migration-owned schema");
      }
    } catch (error) {
      opened.close();
      throw error;
    }
  }
  private record(row?: DbRow): RunRecord | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id), idempotencyKey: String(row.idempotency_key), stage: String(row.stage),
      priority: Number(row.priority), status: row.status as RunStatus,
      artifactHash: row.artifact_hash == null ? undefined : String(row.artifact_hash),
      approvalScope: row.approval_scope == null ? undefined : String(row.approval_scope),
      createdAt: Number(row.created_at), nextAttemptAt: Number(row.next_attempt_at),
      leaseToken: row.lease_token == null ? undefined : String(row.lease_token),
      leaseExpiresAt: row.lease_expires_at == null ? undefined : Number(row.lease_expires_at),
      workerId: row.worker_id == null ? undefined : String(row.worker_id), launched: Boolean(row.launched),
      launchInfo: parse(row.launch_info), result: parse(row.result),
      cancelReason: row.cancel_reason == null ? undefined : String(row.cancel_reason),
      payload: parse(row.payload) as Record<string, unknown> | undefined,
      attemptCount: Number(row.attempt_count ?? 0),
      dependsOnRunId: row.depends_on_run_id == null ? undefined : String(row.depends_on_run_id),
    };
  }
  enqueue(input: EnqueueInput): RunRecord {
    const existing = this.db.prepare("SELECT * FROM runs WHERE idempotency_key = ?").get(input.idempotencyKey) as DbRow | undefined;
    if (existing) return this.record(existing)!;
    const now = input.now ?? Date.now(); const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO runs
        (id,idempotency_key,stage,priority,status,artifact_hash,approval_scope,created_at,next_attempt_at,payload,depends_on_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.idempotencyKey, input.stage, input.priority, "queued",
          input.artifactHash ?? null, input.approvalScope ?? null, now, input.notBefore ?? now,
          input.payload === undefined ? null : JSON.stringify(sanitizeResult(input.payload)), input.dependsOnRunId ?? null);
    } catch (error) {
      const duplicate = this.db.prepare("SELECT * FROM runs WHERE idempotency_key = ?").get(input.idempotencyKey) as DbRow | undefined;
      if (duplicate) return this.record(duplicate)!;
      throw error;
    }
    return this.get(id)!;
  }
  enqueueExact(input: EnqueueInput): RunRecord {
    const expectedPayload = input.payload === undefined
      ? undefined
      : sanitizeResult(input.payload) as Record<string, unknown>;
    const run = this.enqueue(input);
    if (run.stage !== input.stage || run.priority !== input.priority ||
        run.artifactHash !== input.artifactHash || run.approvalScope !== input.approvalScope ||
        run.dependsOnRunId !== input.dependsOnRunId || !isDeepStrictEqual(run.payload, expectedPayload)) {
      throw new Error("idempotency key conflicts with immutable queue payload");
    }
    return run;
  }
  get(id: string): RunRecord | undefined { return this.record(this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined); }
  getByIdempotencyKey(key: string): RunRecord | undefined {
    return this.record(this.db.prepare("SELECT * FROM runs WHERE idempotency_key = ?").get(key) as DbRow | undefined);
  }
  list(): RunRecord[] { return (this.db.prepare("SELECT * FROM runs ORDER BY created_at,id").all() as DbRow[]).map((row) => this.record(row)!); }
  pendingDomainEffects(now = Date.now()): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs
      WHERE status IN ('completed','failed')
        AND (json_extract(result, '$.domainEffect') = 'pending'
          OR (json_extract(result, '$.domainEffect') = 'applying'
            AND json_extract(result, '$.replayLease.expiresAt') <= ?))
      ORDER BY created_at,id`).all(now) as DbRow[]).map((row) => this.record(row)!);
  }
  needsReconciliation(): RunRecord[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status='needs_reconciliation' ORDER BY created_at,id").all() as DbRow[])
      .map((row) => this.record(row)!);
  }
  claimNext(input: { workerId: string; leaseMs: number; now?: number }): RunRecord | undefined {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET status='needs_reconciliation',lease_token=NULL,
          lease_expires_at=NULL,worker_id=NULL
        WHERE status='queued' AND stage LIKE 'review:%' AND EXISTS (
          SELECT 1 FROM runtime_review_lane_attempts a
          JOIN runtime_review_barriers b ON b.review_id=a.review_id
          WHERE a.run_id=runs.id AND b.launch_authority_version=3
            AND (NOT EXISTS (
              SELECT 1 FROM runtime_review_attempt_authorities va
              JOIN runtime_review_attempt_base_policies bp ON bp.base_policy_id=a.base_policy_id
              WHERE va.authority_id=a.authority_id AND va.attempt_id=a.attempt_id
                AND va.review_id=a.review_id AND va.agent=a.agent AND va.role=a.role
                AND va.attempt_ordinal=a.attempt_ordinal
                AND va.authority_kind=a.authority_kind
                AND va.recovery_generation IS a.recovery_generation
                AND va.previous_ordinal IS a.previous_ordinal
                AND va.previous_evidence_hash IS a.previous_evidence_hash
                AND va.authority_hash=a.authority_receipt_id
                AND va.admission_source_receipt_id<>va.admission_readiness_receipt_id
                AND bp.review_id=a.review_id AND bp.agent=a.agent AND bp.role=a.role
                AND bp.model=a.model AND bp.effort=a.effort
                AND bp.policy_version=a.policy_version AND bp.reasons_json=a.reasons_json
                AND a.expected_attempt_ordinal=a.attempt_ordinal
                AND ((a.authority_kind='initial' AND a.expected_lane_revision=0
                      AND a.recovery_generation IS NULL)
                  OR (a.authority_kind IN ('first_admission','recovery')
                      AND a.recovery_generation IS NOT NULL))
            ) OR json_extract(runs.payload,'$.reviewId') IS NOT a.review_id
              OR json_extract(runs.payload,'$.reviewRole') IS NOT a.role
              OR json_extract(runs.payload,'$.decision.agent') IS NOT a.agent
              OR json_extract(runs.payload,'$.reviewAttemptId') IS NOT a.attempt_id
              OR json_extract(runs.payload,'$.reviewAttemptOrdinal') IS NOT a.attempt_ordinal
              OR json_extract(runs.payload,'$.reviewDispatchIdentity.attemptId') IS NOT a.attempt_id
              OR json_extract(runs.payload,'$.reviewDispatchIdentity.attemptOrdinal') IS NOT a.attempt_ordinal
              OR json_extract(runs.payload,'$.reviewDispatchIdentity.agent') IS NOT a.agent)
        )`).run();
      const candidate = this.db.prepare(`SELECT id FROM runs r WHERE status='queued' AND next_attempt_at <= ?
        AND (depends_on_run_id IS NULL OR EXISTS (SELECT 1 FROM runs d WHERE d.id=r.depends_on_run_id AND d.status='completed'))
        AND (stage NOT LIKE 'review:%' OR EXISTS (
          SELECT 1
            FROM runtime_review_lane_attempts a
            JOIN runtime_review_barriers b ON b.review_id=a.review_id
           WHERE a.run_id=r.id
             AND ((b.launch_authority_version=2
               AND a.review_id=json_extract(r.payload, '$.reviewId')
               AND a.agent=json_extract(r.payload, '$.decision.agent')
               AND a.role=json_extract(r.payload, '$.reviewRole'))
              OR (b.launch_authority_version=3
               AND a.attempt_id IS NOT NULL AND a.authority_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM runtime_review_attempt_authorities va
                 WHERE va.authority_id=a.authority_id AND va.attempt_id=a.attempt_id
                   AND va.review_id=a.review_id AND va.agent=a.agent AND va.role=a.role
                   AND va.attempt_ordinal=a.attempt_ordinal)
               AND a.review_id=json_extract(r.payload, '$.reviewId')
               AND a.agent=json_extract(r.payload, '$.decision.agent')
               AND a.role=json_extract(r.payload, '$.reviewRole')
               AND a.attempt_id=json_extract(r.payload, '$.reviewAttemptId')
               AND a.attempt_ordinal=json_extract(r.payload, '$.reviewAttemptOrdinal')
               AND a.attempt_id=json_extract(r.payload, '$.reviewDispatchIdentity.attemptId')
               AND a.attempt_ordinal=json_extract(r.payload, '$.reviewDispatchIdentity.attemptOrdinal')
               AND a.agent=json_extract(r.payload, '$.reviewDispatchIdentity.agent'))
        )))
        ORDER BY priority ASC, created_at ASC,
          CASE json_extract(payload,'$.decision.agent')
            WHEN 'grok' THEN 0 WHEN 'claude' THEN 1 WHEN 'codex' THEN 2 ELSE 3 END,
          CASE json_extract(payload,'$.reviewRole') WHEN 'auditor' THEN 0 ELSE 1 END,
          id ASC LIMIT 1`).get(now) as { id: string } | undefined;
      if (!candidate) return undefined;
      const token = randomUUID();
      const changed = this.db.prepare(`UPDATE runs SET status='claimed', lease_token=?, lease_expires_at=?,
        worker_id=?, launched=0, attempt_count=attempt_count+1 WHERE id=? AND status='queued'`).run(token, now + input.leaseMs, input.workerId, candidate.id);
      return changed.changes === 1 ? this.get(candidate.id) : undefined;
    })();
  }
  private requireLease(id: string, token: string): RunRecord {
    const row = this.get(id);
    if (!row || row.status !== "claimed" || row.leaseToken !== token) throw new Error("invalid or stale lease token");
    return row;
  }
  reconcileClaimedReviewIdentity(id: string, token: string, reason: string): void {
    const current = this.requireLease(id, token);
    if (!this.db.prepare("SELECT 1 FROM runtime_review_lane_attempts WHERE run_id=?").get(id)) {
      throw new Error("only a linked review run may reconcile its identity");
    }
    const changed = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',cancel_reason=?,
      lease_token=NULL,lease_expires_at=NULL,worker_id=NULL
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=0`)
      .run(reason, id, token).changes;
    if (changed !== 1) throw new Error("review identity reconciliation fence rejected");
    if (current.launched) throw new Error("launched review identity requires launch reconciliation");
  }
  releaseForRetry(id: string, token: string, input: { nextAttemptAt: number }): void {
    this.requireLease(id, token);
    if (this.db.prepare("SELECT 1 FROM runtime_review_lane_attempts WHERE run_id=?").get(id)) {
      throw new Error("linked review attempt cannot be released for generic retry");
    }
    const changed = this.db.prepare(`UPDATE runs SET status='queued',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
      worker_id=NULL,launched=0,launch_info=NULL WHERE id=? AND status='claimed' AND lease_token=? AND launched=0`)
      .run(input.nextAttemptAt, id, token).changes;
    if (changed !== 1) throw new Error("retry release fence rejected");
  }
  cancel(id: string, reason: string): void {
    if (this.db.prepare("SELECT 1 FROM runtime_review_lane_attempts WHERE run_id=?").get(id)) {
      throw new Error("linked review attempt requires an authoritative review transition");
    }
    this.db.prepare("UPDATE runs SET status='cancelled',cancel_reason=? WHERE id=? AND status='queued'").run(reason, id);
  }
  markLaunchIntent(id: string, token: string, info: Record<string, unknown>): void {
    const current = this.requireLease(id, token);
    if (current.launched) throw new Error("launch intent fence rejected");
    const previous = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : {};
    const merged = { ...previous, ...info, phase: "launching" };
    const changed = this.db.prepare(`UPDATE runs SET launched=1,launch_info=?
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=0`)
      .run(JSON.stringify(sanitizeResult(merged)), id, token).changes;
    if (changed !== 1) throw new Error("launch intent fence rejected");
  }
  clearLaunchIntent(id: string, token: string): void {
    const current = this.requireLease(id, token);
    const launch = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : null;
    if (!current.launched || launch?.phase !== "launching") {
      throw new Error("launch intent clear fence rejected");
    }
    const launchIntent = { ...launch };
    delete launchIntent.pid;
    delete launchIntent.value;
    const changed = this.db.prepare(`UPDATE runs SET launched=0,launch_info=?
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=1`)
      .run(JSON.stringify({ ...launchIntent, phase: "proven_no_spawn" }), id, token).changes;
    if (changed !== 1) throw new Error("launch intent clear fence rejected");
  }
  markLaunched(id: string, token: string, info: unknown): void {
    const current = this.requireLease(id, token);
    const launch = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : {};
    if (!current.launched || launch.phase !== "launching") {
      throw new Error("started-process launch fence rejected");
    }
    const merged = info && typeof info === "object"
      ? { ...launch, ...(info as Record<string, unknown>), phase: "started" }
      : { ...launch, phase: "started", value: info };
    const changed = this.db.prepare(`UPDATE runs SET launched=1,launch_info=?
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=1`)
      .run(JSON.stringify(sanitizeResult(merged)), id, token).changes;
    if (changed !== 1) throw new Error("started-process launch fence rejected");
  }
  recordExecutionContext(id: string, token: string, context: Record<string, unknown>): void {
    const current = this.requireLease(id, token);
    const previous = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : {};
    const merged = { ...previous, executionContext: sanitizeResult(context) };
    const changed = this.db.prepare(`UPDATE runs SET launch_info=?
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=0`).run(
        JSON.stringify(merged), id, token,
      ).changes;
    if (changed !== 1) throw new Error("execution context launch fence rejected");
  }
  renewLease(id: string, token: string, leaseExpiresAt: number): boolean {
    return this.db.prepare(`UPDATE runs SET lease_expires_at=? WHERE id=? AND status='claimed' AND lease_token=?`)
      .run(leaseExpiresAt, id, token).changes === 1;
  }
  complete(id: string, token: string, result: unknown): void { this.persistResult(id, token, result); }
  commitDomainEffect(input: {
    id: string;
    token: string;
    providerResult: Record<string, unknown>;
    effect: Record<string, unknown>;
    status: "completed" | "failed";
  }): void {
    const current = this.requireLease(input.id, input.token);
    const launch = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : null;
    if (current.launched && launch?.phase !== "started") {
      throw new Error("ambiguous launch cannot commit a domain effect");
    }
    if (current.launched && current.approvalScope !== "workspace-read" &&
        input.providerResult.kind !== "success") {
      throw new Error("mutable launched run requires reconciliation unless provider success is validated");
    }
    const envelope: DomainEffectEnvelope = {
      domainEffect: "pending",
      providerResult: sanitizeResult(input.providerResult),
      effect: sanitizeResult(input.effect),
    };
    const persist = () => {
      const changed = this.db.prepare(`UPDATE runs SET status=?,result=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE id=? AND status='claimed' AND lease_token=?
          AND (launched=0 OR (json_extract(launch_info, '$.phase')='started'
            AND (approval_scope='workspace-read' OR ?='success')))`).run(
          input.status, JSON.stringify(envelope), input.id, input.token, input.providerResult.kind,
        ).changes;
      if (changed !== 1) throw new Error("invalid or stale lease token");
      if (input.status === "failed") {
        this.db.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM runs WHERE depends_on_run_id = ? AND status = 'queued'
          UNION ALL
          SELECT r.id FROM runs r JOIN descendants d ON r.depends_on_run_id = d.id WHERE r.status = 'queued'
        ) UPDATE runs SET status='cancelled',cancel_reason='dependency_failed'
          WHERE id IN (SELECT id FROM descendants)`).run(input.id);
      }
    };
    this.db.transaction(persist).immediate();
  }
  claimDomainEffect(id: string, input: { owner: string; now: number; leaseMs: number }): boolean {
    if (!input.owner || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error("domain effect replay claim is invalid");
    }
    const lease = JSON.stringify({ owner: input.owner, expiresAt: input.now + input.leaseMs });
    return this.db.prepare(`UPDATE runs
      SET result=json_remove(json_set(
        result,
        '$.domainEffect', 'applying',
        '$.replayLease', json(?)
      ), '$.replayError')
      WHERE id=? AND status IN ('completed','failed')
        AND (json_extract(result, '$.domainEffect')='pending'
          OR (json_extract(result, '$.domainEffect')='applying'
            AND json_extract(result, '$.replayLease.expiresAt') <= ?))`).run(
              lease,
              id,
              input.now,
            ).changes === 1;
  }
  markDomainEffectApplied(id: string, owner: string): boolean {
    return this.db.prepare(`UPDATE runs
      SET result=json_remove(json_set(result, '$.domainEffect', 'applied'), '$.replayLease', '$.replayError')
      WHERE id=? AND status IN ('completed','failed')
        AND json_extract(result, '$.domainEffect')='applying'
        AND json_extract(result, '$.replayLease.owner')=?`).run(id, owner).changes === 1;
  }
  releaseDomainEffectClaim(id: string, owner: string, error: unknown): boolean {
    const replayError = sanitizeResult({
      kind: "domain_effect_replay_deferred",
      error: error instanceof Error ? error.message : String(error),
    });
    return this.db.prepare(`UPDATE runs
      SET result=json_remove(json_set(
        result,
        '$.domainEffect', 'pending',
        '$.replayError', json(?)
      ), '$.replayLease')
      WHERE id=? AND status IN ('completed','failed')
        AND json_extract(result, '$.domainEffect')='applying'
        AND json_extract(result, '$.replayLease.owner')=?`).run(
          JSON.stringify(replayError), id, owner,
        ).changes === 1;
  }
  quarantineDomainEffect(id: string, owner: string, error: unknown): boolean {
    const quarantineError = sanitizeResult({
      kind: "domain_effect_quarantined",
      error: error instanceof Error ? error.message : String(error),
    });
    return this.db.prepare(`UPDATE runs
      SET result=json_remove(json_set(
        result,
        '$.domainEffect', 'quarantined',
        '$.quarantineError', json(?)
      ), '$.replayLease', '$.replayError')
      WHERE id=? AND status IN ('completed','failed')
        AND json_extract(result, '$.domainEffect')='applying'
        AND json_extract(result, '$.replayLease.owner')=?`).run(
          JSON.stringify(quarantineError), id, owner,
        ).changes === 1;
  }
  resolveReconciliation(input: {
    id: string;
    providerResult: Record<string, unknown>;
    effect: Record<string, unknown>;
    status: "completed" | "failed";
  }): void {
    const envelope: DomainEffectEnvelope = { domainEffect: "pending",
      providerResult: sanitizeResult(input.providerResult), effect: sanitizeResult(input.effect) };
    const changed = this.db.prepare(`UPDATE runs SET status=?,result=?
      WHERE id=? AND status='needs_reconciliation'`).run(
        input.status, JSON.stringify(envelope), input.id,
      ).changes;
    if (changed !== 1) throw new Error("run is not awaiting reconciliation");
  }
  markNeedsReconciliation(id: string, token: string, error?: unknown): void {
    const current = this.requireLease(id, token);
    if (!current.launched) throw new Error("only an ambiguous launch can enter reconciliation");
    const launch = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : {};
    const launchInfo = error === undefined
      ? launch
      : { ...launch, reconciliationError: sanitizeResult(error) };
    const changed = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',launch_info=?,
      lease_token=NULL,lease_expires_at=NULL,worker_id=NULL
      WHERE id=? AND status='claimed' AND lease_token=? AND launched=1`).run(
        JSON.stringify(launchInfo), id, token,
      ).changes;
    if (changed !== 1) throw new Error("reconciliation fence rejected");
  }
  persistResult(id: string, token: string, result: unknown): void {
    const current = this.requireLease(id, token);
    const launch = current.launchInfo && typeof current.launchInfo === "object"
      ? current.launchInfo as Record<string, unknown>
      : null;
    if (current.launched && launch?.phase !== "started") {
      throw new Error("ambiguous launch cannot persist a completed result");
    }
    if (current.launched && current.approvalScope !== "workspace-read") {
      throw new Error("mutable launched run requires a committed domain effect");
    }
    const changed = this.db.prepare(`UPDATE runs SET status='completed',result=?,lease_token=NULL,lease_expires_at=NULL,
      worker_id=NULL WHERE id=? AND status='claimed' AND lease_token=?
        AND (launched=0 OR (approval_scope='workspace-read'
          AND json_extract(launch_info, '$.phase')='started'))`)
      .run(JSON.stringify(sanitizeResult(result)), id, token).changes;
    if (changed !== 1) throw new Error("result persistence fence rejected");
  }
  fail(id: string, token: string, result: unknown): void {
    const current = this.requireLease(id, token);
    if (current.launched) throw new Error("launched run requires reconciliation or a domain effect");
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE runs SET status='failed',result=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE id=? AND status='claimed' AND lease_token=? AND launched=0`)
        .run(JSON.stringify(sanitizeResult(result)), id, token).changes;
      if (changed !== 1) throw new Error("failure persistence fence rejected");
      this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM runs WHERE depends_on_run_id = ? AND status = 'queued'
        UNION ALL
        SELECT r.id FROM runs r JOIN descendants d ON r.depends_on_run_id = d.id WHERE r.status = 'queued'
      ) UPDATE runs SET status='cancelled',cancel_reason='dependency_failed'
        WHERE id IN (SELECT id FROM descendants)`).run(id);
    })();
  }
  recoverExpired(now = Date.now()): number {
    return this.db.transaction(() => {
      const linked = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',lease_token=NULL,
        lease_expires_at=NULL,worker_id=NULL
        WHERE status='claimed' AND lease_expires_at < ? AND launched=0
          AND EXISTS (SELECT 1 FROM runtime_review_lane_attempts a WHERE a.run_id=runs.id)`)
        .run(now).changes;
      const before = this.db.prepare(`UPDATE runs SET status='queued',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE status='claimed' AND lease_expires_at < ? AND launched=0
          AND NOT EXISTS (SELECT 1 FROM runtime_review_lane_attempts a WHERE a.run_id=runs.id)`)
        .run(now + 1_000, now).changes;
      const after = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',lease_token=NULL,
        lease_expires_at=NULL,worker_id=NULL WHERE status='claimed' AND lease_expires_at < ? AND launched=1 AND result IS NULL`).run(now).changes;
      return linked + before + after;
    })();
  }
  close(): void { this.closeAccess(); }
}
