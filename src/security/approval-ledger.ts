import { chmodSync } from "node:fs";
import Database from "better-sqlite3";

export type ApprovalScope = "workspace-read" | "workspace-write" | "external";
export type ApprovalDenialReason =
  | "not_found"
  | "project_mismatch"
  | "scope_mismatch"
  | "expired"
  | "exhausted";

export type ApprovalValidation =
  | { allowed: true; remainingUses: number }
  | { allowed: false; reason: ApprovalDenialReason };

export interface ApprovalGrant {
  reference: string;
  project: string;
  scope: ApprovalScope;
  expiresAt: number;
  maxUses?: number;
}

export interface ApprovalRequest {
  reference: string;
  project: string;
  scope: ApprovalScope;
  now?: number;
  consumerKey?: string;
}

interface StoredApproval {
  expires_at: number;
  max_uses: number;
  used_count: number;
}

function requireNonempty(value: string, field: string): void {
  if (!value || value.trim() !== value) throw new Error(`${field} must be a non-empty exact value`);
}

function requireTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
}

export class ApprovalLedger {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_grants (
        reference TEXT NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        expires_at INTEGER NOT NULL,
        max_uses INTEGER NOT NULL CHECK (max_uses > 0),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
        PRIMARY KEY (reference, project, scope)
      );
      CREATE TABLE IF NOT EXISTS approval_consumptions (
        consumer_key TEXT PRIMARY KEY,
        reference TEXT NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        consumed_at INTEGER NOT NULL
      );
    `);
  }

  issue(input: ApprovalGrant): void {
    requireNonempty(input.reference, "reference");
    requireNonempty(input.project, "project");
    requireTime(input.expiresAt, "expiresAt");
    const maxUses = input.maxUses ?? 1;
    if (!Number.isSafeInteger(maxUses) || maxUses <= 0) {
      throw new Error("maxUses must be a positive integer");
    }
    try {
      this.db
        .prepare(
          `INSERT INTO approval_grants
             (reference, project, scope, expires_at, max_uses, used_count)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(input.reference, input.project, input.scope, input.expiresAt, maxUses);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new Error("approval already exists for the exact reference, project, and scope");
      }
      throw error;
    }
  }

  validateAndConsume(input: ApprovalRequest): ApprovalValidation {
    requireNonempty(input.reference, "reference");
    requireNonempty(input.project, "project");
    const now = input.now ?? Date.now();
    requireTime(now, "now");

    const consume = this.db.transaction((): ApprovalValidation => {
      if (input.consumerKey) {
        requireNonempty(input.consumerKey, "consumerKey");
        const prior = this.db.prepare(`SELECT reference,project,scope FROM approval_consumptions
          WHERE consumer_key=?`).get(input.consumerKey) as { reference: string; project: string; scope: ApprovalScope } | undefined;
        if (prior) {
          if (prior.reference !== input.reference || prior.project !== input.project || prior.scope !== input.scope) {
            throw new Error("approval consumer key conflicts with a different authority request");
          }
          return { allowed: true, remainingUses: 0 };
        }
      }
      const approval = this.db
        .prepare(
          `SELECT expires_at, max_uses, used_count
             FROM approval_grants
            WHERE reference = ? AND project = ? AND scope = ?`,
        )
        .get(input.reference, input.project, input.scope) as StoredApproval | undefined;
      if (!approval) return this.mismatchReason(input);
      if (now >= approval.expires_at) return { allowed: false, reason: "expired" };
      if (approval.used_count >= approval.max_uses) return { allowed: false, reason: "exhausted" };

      const updated = this.db
        .prepare(
          `UPDATE approval_grants
              SET used_count = used_count + 1
            WHERE reference = ? AND project = ? AND scope = ?
              AND expires_at > ? AND used_count < max_uses`,
        )
        .run(input.reference, input.project, input.scope, now);
      if (updated.changes !== 1) {
        const latest = this.db
          .prepare(
            `SELECT expires_at, max_uses, used_count
               FROM approval_grants
              WHERE reference = ? AND project = ? AND scope = ?`,
          )
          .get(input.reference, input.project, input.scope) as StoredApproval;
        return now >= latest.expires_at
          ? { allowed: false, reason: "expired" }
          : { allowed: false, reason: "exhausted" };
      }
      if (input.consumerKey) {
        this.db.prepare(`INSERT INTO approval_consumptions
          (consumer_key,reference,project,scope,consumed_at) VALUES(?,?,?,?,?)`).run(
            input.consumerKey, input.reference, input.project, input.scope, now,
          );
      }
      return { allowed: true, remainingUses: approval.max_uses - approval.used_count - 1 };
    });
    return consume.immediate();
  }

  close(): void {
    this.db.close();
  }

  private mismatchReason(input: ApprovalRequest): ApprovalValidation {
    const projects = this.db
      .prepare("SELECT project, scope FROM approval_grants WHERE reference = ?")
      .all(input.reference) as Array<{ project: string; scope: ApprovalScope }>;
    if (projects.length === 0) return { allowed: false, reason: "not_found" };
    if (!projects.some((row) => row.project === input.project)) {
      return { allowed: false, reason: "project_mismatch" };
    }
    return { allowed: false, reason: "scope_mismatch" };
  }
}
