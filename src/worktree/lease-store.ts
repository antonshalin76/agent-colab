import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AgentId } from "../domain/routing.js";

const assertFreshV2Schema = (db: Database.Database): void => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktree_leases'",
  ).get() as { sql: string } | undefined;
  const sql = row?.sql.toLowerCase() ?? "";
  if (!sql.includes("'grok'") || sql.includes("'claude'")) {
    throw new Error("worktree_leases requires offline v1-to-v2 migration");
  }
};

export interface WorktreeLease {
  worktreePath: string;
  taskId: string;
  leaseId: string;
  holder: AgentId;
  fencingToken: number;
  expiresAt: number;
}

export interface HandoffRecord {
  from: AgentId;
  to: AgentId;
  previousLeaseId: string;
  fencingToken: number;
  evidence: unknown;
  recordedAt: number;
}

type AcquireResult =
  | { status: "acquired"; lease: WorktreeLease }
  | { status: "contended"; currentLease: WorktreeLease };
type TransferResult =
  | { status: "transferred"; lease: WorktreeLease; handoff: HandoffRecord }
  | { status: "fenced"; currentFencingToken: number };
type MutationResult =
  | { status: "renewed"; lease: WorktreeLease }
  | { status: "released" }
  | { status: "fenced"; currentFencingToken: number };

interface LeaseRow {
  worktree_path: string;
  task_id: string;
  lease_id: string;
  holder: AgentId;
  fencing_token: number;
  expires_at: number;
}

interface HandoffRow {
  payload: string;
}

const toLease = (row: LeaseRow): WorktreeLease => ({
  worktreePath: row.worktree_path,
  taskId: row.task_id,
  leaseId: row.lease_id,
  holder: row.holder,
  fencingToken: row.fencing_token,
  expiresAt: row.expires_at,
});

export class WorktreeLeaseStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const existing = this.db.prepare(`
      SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name IN ('worktree_leases', 'worktree_handoffs')
       LIMIT 1
    `).get();
    if (existing !== undefined) {
      try {
        assertFreshV2Schema(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_leases (
        worktree_path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        holder TEXT NOT NULL CHECK (holder IN ('grok', 'codex')),
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worktree_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worktree_handoffs_task
        ON worktree_handoffs(task_id, id);
    `);
    try {
      assertFreshV2Schema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private row(worktreePath: string): LeaseRow | undefined {
    return this.db
      .prepare("SELECT * FROM worktree_leases WHERE worktree_path = ?")
      .get(worktreePath) as LeaseRow | undefined;
  }

  async get(worktreePath: string): Promise<WorktreeLease | null> {
    return this.getImmediate(worktreePath);
  }

  getImmediate(worktreePath: string): WorktreeLease | null {
    const row = this.row(worktreePath);
    return row === undefined ? null : toLease(row);
  }

  async acquire(input: {
    worktreePath: string;
    taskId: string;
    holder: AgentId;
    now: number;
    ttlMs: number;
  }): Promise<AcquireResult> {
    const transaction = this.db.transaction((): AcquireResult => {
      const existing = this.row(input.worktreePath);
      if (existing !== undefined && existing.expires_at > input.now) {
        return { status: "contended", currentLease: toLease(existing) };
      }
      const lease: WorktreeLease = {
        worktreePath: input.worktreePath,
        taskId: input.taskId,
        leaseId: randomUUID(),
        holder: input.holder,
        fencingToken: (existing?.fencing_token ?? 0) + 1,
        expiresAt: input.now + input.ttlMs,
      };
      this.db
        .prepare(
          `INSERT INTO worktree_leases
             (worktree_path, task_id, lease_id, holder, fencing_token, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(worktree_path) DO UPDATE SET
             task_id = excluded.task_id,
             lease_id = excluded.lease_id,
             holder = excluded.holder,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at`,
        )
        .run(
          lease.worktreePath,
          lease.taskId,
          lease.leaseId,
          lease.holder,
          lease.fencingToken,
          lease.expiresAt,
        );
      return { status: "acquired", lease };
    });
    return transaction.immediate();
  }

  async reuse(input: {
    lease: WorktreeLease;
    taskId: string;
    holder: AgentId;
    now: number;
    ttlMs: number;
  }): Promise<AcquireResult> {
    const changed = this.db.prepare(`UPDATE worktree_leases SET expires_at=?
      WHERE worktree_path=? AND task_id=? AND lease_id=? AND holder=? AND fencing_token=?`).run(
        input.now + input.ttlMs, input.lease.worktreePath, input.taskId, input.lease.leaseId,
        input.holder, input.lease.fencingToken,
      ).changes;
    if (changed === 1) return { status: "acquired", lease: toLease(this.row(input.lease.worktreePath)!) };
    const current = this.row(input.lease.worktreePath);
    return current
      ? { status: "contended", currentLease: toLease(current) }
      : this.acquire({ worktreePath: input.lease.worktreePath, taskId: input.taskId,
          holder: input.holder, now: input.now, ttlMs: input.ttlMs });
  }

  async transfer(input: {
    worktreePath: string;
    expectedLeaseId: string;
    expectedFencingToken: number;
    from: AgentId;
    to: AgentId;
    now: number;
    ttlMs: number;
    evidence: unknown;
  }): Promise<TransferResult> {
    return this.transferImmediate(input);
  }

  transferImmediate(input: {
    worktreePath: string; expectedLeaseId: string; expectedFencingToken: number;
    from: AgentId; to: AgentId; now: number; ttlMs: number; evidence: unknown;
    allowAlreadyTransferred?: boolean;
  }): TransferResult {
    const existing = this.row(input.worktreePath);
    if (input.allowAlreadyTransferred && existing && existing.lease_id === input.expectedLeaseId &&
        existing.fencing_token === input.expectedFencingToken + 1 && existing.holder === input.to) {
      return { status: "transferred", lease: toLease(existing), handoff: {
        from: input.from, to: input.to, previousLeaseId: input.expectedLeaseId,
        fencingToken: existing.fencing_token, evidence: structuredClone(input.evidence), recordedAt: input.now,
      } };
    }
    const transaction = this.db.transaction((): TransferResult => {
      const current = this.row(input.worktreePath);
      if (!current || current.lease_id !== input.expectedLeaseId ||
          current.fencing_token !== input.expectedFencingToken || current.holder !== input.from) {
        return { status: "fenced", currentFencingToken: current?.fencing_token ?? 0 };
      }
      const lease = { ...toLease(current), holder: input.to, fencingToken: current.fencing_token + 1,
        expiresAt: input.now + input.ttlMs };
      this.db.prepare(`UPDATE worktree_leases SET holder=?,fencing_token=?,expires_at=?
        WHERE worktree_path=? AND lease_id=? AND fencing_token=? AND holder=?`)
        .run(lease.holder, lease.fencingToken, lease.expiresAt, input.worktreePath,
          input.expectedLeaseId, input.expectedFencingToken, input.from);
      const handoff = { from: input.from, to: input.to, previousLeaseId: current.lease_id,
        fencingToken: lease.fencingToken, evidence: structuredClone(input.evidence), recordedAt: input.now };
      this.db.prepare("INSERT INTO worktree_handoffs(task_id,recorded_at,payload) VALUES(?,?,?)")
        .run(current.task_id, input.now, JSON.stringify(handoff));
      return { status: "transferred", lease, handoff };
    });
    return transaction.immediate();
  }

  async renew(input: {
    worktreePath: string;
    leaseId: string;
    fencingToken: number;
    holder: AgentId;
    now: number;
    ttlMs: number;
  }): Promise<MutationResult> {
    const changed = this.db
      .prepare(
        `UPDATE worktree_leases SET expires_at = ?
         WHERE worktree_path = ? AND lease_id = ? AND fencing_token = ? AND holder = ?`,
      )
      .run(
        input.now + input.ttlMs,
        input.worktreePath,
        input.leaseId,
        input.fencingToken,
        input.holder,
      );
    if (changed.changes !== 1) {
      return { status: "fenced", currentFencingToken: this.row(input.worktreePath)?.fencing_token ?? 0 };
    }
    return { status: "renewed", lease: toLease(this.row(input.worktreePath)!) };
  }

  async release(input: {
    worktreePath: string;
    leaseId: string;
    fencingToken: number;
    holder: AgentId;
  }): Promise<MutationResult> {
    const changed = this.db
      .prepare(
        `DELETE FROM worktree_leases
         WHERE worktree_path = ? AND lease_id = ? AND fencing_token = ? AND holder = ?`,
      )
      .run(input.worktreePath, input.leaseId, input.fencingToken, input.holder);
    if (changed.changes !== 1) {
      return { status: "fenced", currentFencingToken: this.row(input.worktreePath)?.fencing_token ?? 0 };
    }
    return { status: "released" };
  }

  async listHandoffs(taskId: string): Promise<HandoffRecord[]> {
    const rows = this.db
      .prepare("SELECT payload FROM worktree_handoffs WHERE task_id = ? ORDER BY id")
      .all(taskId) as HandoffRow[];
    return rows.map((row) => JSON.parse(row.payload) as HandoffRecord);
  }

  close(): void {
    this.db.close();
  }
}
