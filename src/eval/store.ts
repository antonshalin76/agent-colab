import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export type EvalBlockState =
  | "planned"
  | "preflighted"
  | "running"
  | "checked"
  | "completed"
  | "inconclusive"
  | "failed";

export type EvalAttemptStatus = "planned" | "launched" | "completed" | "failed" | "invalidated";

export interface EvalBlock {
  id: string;
  idempotencyKey: string;
  manifestHash: string;
  seed: number;
  snapshotHash: string;
  parityReceiptHash: string;
  state: EvalBlockState;
}

export interface EvalAttempt {
  id: string;
  blockId: string;
  provider: "grok" | "codex";
  repetition: number;
  sessionId: string;
  status: EvalAttemptStatus;
  launchReceiptHash?: string | undefined;
  evidenceHash?: string | undefined;
}

type Row = Record<string, unknown>;

const transitions: Readonly<Record<EvalBlockState, readonly EvalBlockState[]>> = {
  planned: ["preflighted", "inconclusive"],
  preflighted: ["running", "inconclusive"],
  running: ["checked", "inconclusive", "failed"],
  checked: ["completed", "inconclusive", "failed"],
  completed: [],
  inconclusive: [],
  failed: [],
};

export class EvalStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_blocks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        manifest_hash TEXT NOT NULL,
        seed INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL,
        parity_receipt_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'planned','preflighted','running','checked','completed','inconclusive','failed'
        )),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS eval_block_transitions (
        id INTEGER PRIMARY KEY,
        block_id TEXT NOT NULL REFERENCES eval_blocks(id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (block_id, from_state, to_state)
      );
      CREATE TABLE IF NOT EXISTS eval_attempts (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL REFERENCES eval_blocks(id),
        provider TEXT NOT NULL CHECK (provider IN ('grok','codex')),
        repetition INTEGER NOT NULL CHECK (repetition >= 0),
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned','launched','completed','failed','invalidated')),
        launch_receipt_hash TEXT,
        evidence_hash TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (block_id, provider, repetition)
      );
      CREATE INDEX IF NOT EXISTS eval_attempts_block ON eval_attempts(block_id, status);
    `);
  }

  private block(row: Row | undefined): EvalBlock | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      manifestHash: String(row.manifest_hash),
      seed: Number(row.seed),
      snapshotHash: String(row.snapshot_hash),
      parityReceiptHash: String(row.parity_receipt_hash),
      state: row.state as EvalBlockState,
    };
  }

  private attempt(row: Row | undefined): EvalAttempt | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id),
      blockId: String(row.block_id),
      provider: row.provider as "grok" | "codex",
      repetition: Number(row.repetition),
      sessionId: String(row.session_id),
      status: row.status as EvalAttemptStatus,
      launchReceiptHash: row.launch_receipt_hash == null ? undefined : String(row.launch_receipt_hash),
      evidenceHash: row.evidence_hash == null ? undefined : String(row.evidence_hash),
    };
  }

  private requireBlockIdentity(row: Row, input: {
    manifestHash: string;
    seed: number;
    snapshotHash: string;
    parityReceiptHash: string;
  }): EvalBlock {
    const existing = this.block(row)!;
    if (existing.manifestHash !== input.manifestHash || existing.seed !== input.seed ||
        existing.snapshotHash !== input.snapshotHash ||
        existing.parityReceiptHash !== input.parityReceiptHash) {
      throw new Error("idempotency key conflicts with immutable eval block inputs");
    }
    return existing;
  }

  private requireAttemptIdentity(row: Row, sessionId: string): EvalAttempt {
    const existing = this.attempt(row)!;
    if (existing.sessionId !== sessionId) {
      throw new Error("attempt idempotency identity conflicts with immutable session id");
    }
    return existing;
  }

  createBlock(input: {
    idempotencyKey: string;
    manifestHash: string;
    seed: number;
    snapshotHash: string;
    parityReceiptHash: string;
  }): EvalBlock {
    const existing = this.db.prepare("SELECT * FROM eval_blocks WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as Row | undefined;
    if (existing) return this.requireBlockIdentity(existing, input);
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO eval_blocks
        (id,idempotency_key,manifest_hash,seed,snapshot_hash,parity_receipt_hash,state,created_at)
        VALUES (?,?,?,?,?,?,'planned',?)`).run(
          id,
          input.idempotencyKey,
          input.manifestHash,
          input.seed,
          input.snapshotHash,
          input.parityReceiptHash,
          Date.now(),
        );
    } catch (error) {
      const duplicate = this.db.prepare("SELECT * FROM eval_blocks WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as Row | undefined;
      if (duplicate) return this.requireBlockIdentity(duplicate, input);
      throw error;
    }
    return this.getBlock(id)!;
  }

  getBlock(id: string): EvalBlock | undefined {
    return this.block(this.db.prepare("SELECT * FROM eval_blocks WHERE id = ?").get(id) as Row | undefined);
  }

  listBlocks(): EvalBlock[] {
    return (this.db.prepare("SELECT * FROM eval_blocks ORDER BY created_at,id").all() as Row[])
      .map((row) => this.block(row)!);
  }

  advanceBlock(id: string, next: EvalBlockState, evidence: { receiptHash: string }): EvalBlock {
    return this.db.transaction(() => {
      const current = this.getBlock(id);
      if (!current) throw new Error("unknown eval block");
      if (!transitions[current.state].includes(next)) {
        throw new Error(`illegal eval block transition: ${current.state} -> ${next}`);
      }
      const changed = this.db.prepare("UPDATE eval_blocks SET state = ? WHERE id = ? AND state = ?")
        .run(next, id, current.state).changes;
      if (changed !== 1) throw new Error("eval block transition lost a concurrent race");
      this.db.prepare(`INSERT INTO eval_block_transitions
        (block_id,from_state,to_state,receipt_hash,created_at) VALUES (?,?,?,?,?)`)
        .run(id, current.state, next, evidence.receiptHash, Date.now());
      return this.getBlock(id)!;
    }).immediate();
  }

  createAttempt(input: {
    blockId: string;
    provider: "grok" | "codex";
    repetition: number;
    sessionId: string;
  }): EvalAttempt {
    const existing = this.db.prepare(`SELECT * FROM eval_attempts
      WHERE block_id=? AND provider=? AND repetition=?`)
      .get(input.blockId, input.provider, input.repetition) as Row | undefined;
    if (existing) return this.requireAttemptIdentity(existing, input.sessionId);
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO eval_attempts
        (id,block_id,provider,repetition,session_id,status,created_at)
        VALUES (?,?,?,?,?,'planned',?)`).run(
          id,
          input.blockId,
          input.provider,
          input.repetition,
          input.sessionId,
          Date.now(),
        );
    } catch (error) {
      const duplicate = this.db.prepare(`SELECT * FROM eval_attempts
        WHERE block_id=? AND provider=? AND repetition=?`)
        .get(input.blockId, input.provider, input.repetition) as Row | undefined;
      if (duplicate) return this.requireAttemptIdentity(duplicate, input.sessionId);
      throw error;
    }
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): EvalAttempt | undefined {
    return this.attempt(this.db.prepare("SELECT * FROM eval_attempts WHERE id = ?").get(id) as Row | undefined);
  }

  listAttempts(blockId: string): EvalAttempt[] {
    return (this.db.prepare(`SELECT * FROM eval_attempts
      WHERE block_id=? ORDER BY repetition,provider,id`).all(blockId) as Row[])
      .map((row) => this.attempt(row)!);
  }

  isAttemptLaunchable(id: string): boolean {
    return this.getAttempt(id)?.status === "planned";
  }

  markAttemptLaunched(id: string, input: { launchReceiptHash: string }): EvalAttempt {
    const changed = this.db.prepare(`UPDATE eval_attempts
      SET status='launched',launch_receipt_hash=?
      WHERE id=? AND status='planned' AND launch_receipt_hash IS NULL AND evidence_hash IS NULL`)
      .run(input.launchReceiptHash, id).changes;
    if (changed !== 1) throw new Error("attempt is not launchable");
    return this.getAttempt(id)!;
  }

  finishAttempt(id: string, input: {
    status: "completed" | "failed";
    evidenceHash: string;
  }): EvalAttempt {
    const changed = this.db.prepare(`UPDATE eval_attempts
      SET status=?,evidence_hash=?
      WHERE id=? AND status='launched' AND evidence_hash IS NULL`)
      .run(input.status, input.evidenceHash, id).changes;
    if (changed !== 1) throw new Error("terminal attempt evidence is immutable");
    return this.getAttempt(id)!;
  }

  invalidateAttempt(id: string, input: { evidenceHash: string }): EvalAttempt {
    const changed = this.db.prepare(`UPDATE eval_attempts
      SET status='invalidated',evidence_hash=?
      WHERE id=? AND status='planned' AND launch_receipt_hash IS NULL AND evidence_hash IS NULL`)
      .run(input.evidenceHash, id).changes;
    if (changed !== 1) throw new Error("attempt is launched, terminal, or immutable");
    return this.getAttempt(id)!;
  }

  close(): void {
    this.db.close();
  }
}
