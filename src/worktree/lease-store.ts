import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AgentId } from "../domain/routing.js";

const assertFreshV3Schema = (db: Database.Database): void => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktree_leases'",
  ).get() as { sql: string } | undefined;
  const sql = row?.sql.toLowerCase() ?? "";
  if (!sql.includes("'grok'") || !sql.includes("'codex'") || sql.includes("'claude'") ||
      !sql.includes("authority_policy = 'routing-v5'")) {
    throw new Error("worktree_leases requires offline routing-v5 migration");
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

export interface PolicyFenceRecord {
  kind: "routing_policy_fence";
  from: "grok";
  policyVersion: "routing-v5";
  previousLeaseId: string;
  fencingToken: number;
  recordedAt: number;
}

export type LeaseAuditRecord = PolicyFenceRecord;

type AcquireResult =
  | { status: "acquired"; lease: WorktreeLease }
  | { status: "contended"; currentLease: WorktreeLease };
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
  authority_policy?: string;
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
        assertFreshV3Schema(this.db);
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
        expires_at INTEGER NOT NULL,
        authority_policy TEXT NOT NULL DEFAULT 'routing-v5'
          CHECK (authority_policy = 'routing-v5')
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
      assertFreshV3Schema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private assertCodexWriter(holder: AgentId): void {
    if (holder !== "codex") {
      throw new Error("Grok cannot hold writer authority; Codex is the sole writer");
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
    this.assertCodexWriter(input.holder);
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
             (worktree_path, task_id, lease_id, holder, fencing_token, expires_at, authority_policy)
           VALUES (?, ?, ?, ?, ?, ?, 'routing-v5')
           ON CONFLICT(worktree_path) DO UPDATE SET
             task_id = excluded.task_id,
             lease_id = excluded.lease_id,
             holder = excluded.holder,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             authority_policy = excluded.authority_policy`,
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
    this.assertCodexWriter(input.holder);
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

  async renew(input: {
    worktreePath: string;
    leaseId: string;
    fencingToken: number;
    holder: AgentId;
    now: number;
    ttlMs: number;
  }): Promise<MutationResult> {
    this.assertCodexWriter(input.holder);
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

  async listHandoffs(taskId: string): Promise<LeaseAuditRecord[]> {
    const rows = this.db
      .prepare("SELECT payload FROM worktree_handoffs WHERE task_id = ? ORDER BY id")
      .all(taskId) as HandoffRow[];
    return rows.map((row) => JSON.parse(row.payload) as LeaseAuditRecord);
  }

  close(): void {
    this.db.close();
  }
}
