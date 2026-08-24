import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { sanitizeResult } from "../security/redaction.js";

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
  domainEffect: "pending" | "applied";
  providerResult: Record<string, unknown>;
  effect: Record<string, unknown>;
}

type DbRow = Record<string, unknown>;
const parse = (value: unknown) => value == null ? undefined : JSON.parse(String(value));

export class RunStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
      priority INTEGER NOT NULL, status TEXT NOT NULL, artifact_hash TEXT, approval_scope TEXT,
      created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      lease_token TEXT, lease_expires_at INTEGER, worker_id TEXT, launched INTEGER NOT NULL DEFAULT 0,
      launch_info TEXT, result TEXT, cancel_reason TEXT, payload TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      depends_on_run_id TEXT
    ); CREATE INDEX IF NOT EXISTS runs_due ON runs(status, next_attempt_at, priority, created_at);`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const required of ["payload", "attempt_count", "depends_on_run_id"]) {
      if (!columns.has(required)) {
        this.db.close();
        throw new Error("runs table requires offline v1-to-v2 migration");
      }
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
  pendingDomainEffects(): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs
      WHERE status IN ('completed','failed')
        AND json_extract(result, '$.domainEffect') = 'pending'
      ORDER BY created_at,id`).all() as DbRow[]).map((row) => this.record(row)!);
  }
  needsReconciliation(): RunRecord[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status='needs_reconciliation' ORDER BY created_at,id").all() as DbRow[])
      .map((row) => this.record(row)!);
  }
  claimNext(input: { workerId: string; leaseMs: number; now?: number }): RunRecord | undefined {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const candidate = this.db.prepare(`SELECT id FROM runs r WHERE status='queued' AND next_attempt_at <= ?
        AND (depends_on_run_id IS NULL OR EXISTS (SELECT 1 FROM runs d WHERE d.id=r.depends_on_run_id AND d.status='completed'))
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1`).get(now) as { id: string } | undefined;
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
  releaseForRetry(id: string, token: string, input: { nextAttemptAt: number }): void {
    this.requireLease(id, token);
    this.db.prepare(`UPDATE runs SET status='queued',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
      worker_id=NULL,launched=0,launch_info=NULL WHERE id=? AND lease_token=?`).run(input.nextAttemptAt, id, token);
  }
  cancel(id: string, reason: string): void {
    this.db.prepare("UPDATE runs SET status='cancelled',cancel_reason=? WHERE id=? AND status='queued'").run(reason, id);
  }
  markLaunched(id: string, token: string, info: unknown): void {
    const current = this.requireLease(id, token);
    const merged = current.launchInfo && typeof current.launchInfo === "object" && info && typeof info === "object"
      ? { ...(current.launchInfo as Record<string, unknown>), ...(info as Record<string, unknown>) }
      : info;
    this.db.prepare("UPDATE runs SET launched=1,launch_info=? WHERE id=? AND lease_token=?")
      .run(JSON.stringify(sanitizeResult(merged)), id, token);
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
    this.requireLease(input.id, input.token);
    const envelope: DomainEffectEnvelope = {
      domainEffect: "pending",
      providerResult: sanitizeResult(input.providerResult),
      effect: sanitizeResult(input.effect),
    };
    const persist = () => {
      const changed = this.db.prepare(`UPDATE runs SET status=?,result=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE id=? AND status='claimed' AND lease_token=?`).run(
          input.status, JSON.stringify(envelope), input.id, input.token,
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
  markDomainEffectApplied(id: string): boolean {
    return this.db.prepare(`UPDATE runs
      SET result=json_set(result, '$.domainEffect', 'applied')
      WHERE id=? AND status IN ('completed','failed')
        AND json_extract(result, '$.domainEffect')='pending'`).run(id).changes === 1;
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
  persistResult(id: string, token: string, result: unknown): void {
    this.requireLease(id, token);
    this.db.prepare(`UPDATE runs SET status='completed',result=?,lease_token=NULL,lease_expires_at=NULL,
      worker_id=NULL WHERE id=? AND lease_token=?`).run(JSON.stringify(sanitizeResult(result)), id, token);
  }
  fail(id: string, token: string, result: unknown): void {
    this.requireLease(id, token);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET status='failed',result=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE id=? AND lease_token=?`).run(JSON.stringify(sanitizeResult(result)), id, token);
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
      const before = this.db.prepare(`UPDATE runs SET status='queued',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
        worker_id=NULL WHERE status='claimed' AND lease_expires_at < ? AND launched=0`).run(now + 1_000, now).changes;
      const after = this.db.prepare(`UPDATE runs SET status='needs_reconciliation',lease_token=NULL,
        lease_expires_at=NULL,worker_id=NULL WHERE status='claimed' AND lease_expires_at < ? AND launched=1 AND result IS NULL`).run(now).changes;
      return before + after;
    })();
  }
  close(): void { this.db.close(); }
}
