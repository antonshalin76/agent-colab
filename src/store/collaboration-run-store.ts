import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { sanitizeResult } from "../security/redaction.js";
import {
  restoreCollaborationRun,
  serializeCollaborationRun,
  transitionCollaborationRun,
  type ActiveStage,
  type CollaborationRun,
  type DispatchRecord,
  type WorkflowEvent,
} from "../workflow/workflow.js";

export interface WorkflowDispatch {
  dispatchId: string;
  workflowId: string;
  dispatch: DispatchRecord;
  stage: ActiveStage;
  handoff?: CollaborationRun["handoffs"][number];
}

interface WorkflowRow { state_json: string; version: number }
interface OutboxRow { dispatch_id: string; workflow_id: string; payload_json: string }

const immutableWorkflowInput = (run: CollaborationRun) => sanitizeResult({
  taskId: run.taskId,
  origin: run.origin,
  policyVersion: run.policyVersion,
  stages: run.stages,
  retryPolicy: run.retryPolicy,
});

export class CollaborationRunStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_runs (
        workflow_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_dispatch_outbox (
        dispatch_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES collaboration_runs(workflow_id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        published_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS collaboration_outbox_pending
        ON collaboration_dispatch_outbox(published_at, dispatch_id);
    `);
  }

  get(workflowId: string): CollaborationRun | null {
    const row = this.db.prepare("SELECT state_json,version FROM collaboration_runs WHERE workflow_id=?")
      .get(workflowId) as WorkflowRow | undefined;
    return row ? restoreCollaborationRun(row.state_json) : null;
  }

  recoverable(): Array<{ workflowId: string; state: CollaborationRun }> {
    const rows = this.db.prepare("SELECT workflow_id,state_json FROM collaboration_runs ORDER BY workflow_id")
      .all() as Array<{ workflow_id: string; state_json: string }>;
    return rows
      .map((row) => ({ workflowId: row.workflow_id, state: restoreCollaborationRun(row.state_json) }))
      .filter(({ state }) => state.pendingStageId !== null && state.activeStage === null);
  }

  private insertDispatches(workflowId: string, before: CollaborationRun, next: CollaborationRun): void {
    const newDispatches = next.dispatches.slice(before.dispatches.length);
    for (const [offset, dispatch] of newDispatches.entries()) {
      const stageDefinition = next.stages.find((stage) => stage.id === dispatch.stageId);
      if (!stageDefinition) throw new Error(`Dispatch references unknown stage: ${dispatch.stageId}`);
      const stage: ActiveStage = {
        ...stageDefinition,
        assignment: structuredClone(dispatch.assignment),
      };
      const dispatchId = `${workflowId}:dispatch:${before.dispatches.length + offset}`;
      const handoff = dispatch.handoffEventId
        ? next.handoffs.find((item) => item.eventId === dispatch.handoffEventId)
        : undefined;
      const payload = sanitizeResult({
        dispatchId,
        workflowId,
        dispatch,
        stage,
        ...(handoff ? { handoff } : {}),
      });
      const encoded = JSON.stringify(payload);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO collaboration_dispatch_outbox
        (dispatch_id,workflow_id,payload_json,published_at) VALUES(?,?,?,NULL)`)
        .run(dispatchId, workflowId, encoded);
      if (inserted.changes === 0) {
        const existing = this.db.prepare(`SELECT dispatch_id,workflow_id,payload_json
          FROM collaboration_dispatch_outbox WHERE dispatch_id=?`).get(dispatchId) as OutboxRow | undefined;
        if (!existing || !isDeepStrictEqual(JSON.parse(existing.payload_json), payload)) {
          throw new Error("dispatch id conflicts with immutable outbox payload");
        }
      }
    }
  }

  createStartedIfAbsent(workflowId: string, run: CollaborationRun, event: WorkflowEvent, now = Date.now()): CollaborationRun {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT state_json,version FROM collaboration_runs WHERE workflow_id=?")
        .get(workflowId) as WorkflowRow | undefined;
      if (existing) {
        const restored = restoreCollaborationRun(existing.state_json);
        if (!isDeepStrictEqual(immutableWorkflowInput(restored), immutableWorkflowInput(run))) {
          throw new Error("workflow id conflicts with immutable collaboration input");
        }
        return restored;
      }
      const sanitizedRun = sanitizeResult(run);
      const next = transitionCollaborationRun(sanitizedRun, event);
      this.db.prepare(`INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at) VALUES(?,?,1,?)`)
        .run(workflowId, serializeCollaborationRun(next), now);
      this.insertDispatches(workflowId, sanitizedRun, next);
      return next;
    }).immediate();
  }

  apply(workflowId: string, event: WorkflowEvent, now = Date.now()): CollaborationRun {
    return this.applyMany(workflowId, [event], now);
  }

  applyMany(workflowId: string, events: WorkflowEvent[], now = Date.now()): CollaborationRun {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT state_json,version FROM collaboration_runs WHERE workflow_id=?")
        .get(workflowId) as WorkflowRow | undefined;
      if (!row) throw new Error(`Unknown collaboration workflow: ${workflowId}`);
      const before = restoreCollaborationRun(row.state_json);
      const next = events.reduce((state, item) => transitionCollaborationRun(state, item), before);
      if (next === before || serializeCollaborationRun(next) === row.state_json) return before;
      this.insertDispatches(workflowId, before, next);
      const changed = this.db.prepare(`UPDATE collaboration_runs SET state_json=?,version=version+1,updated_at=?
        WHERE workflow_id=? AND version=?`).run(serializeCollaborationRun(sanitizeResult(next)), now, workflowId, row.version);
      if (changed.changes !== 1) throw new Error("Collaboration workflow CAS conflict");
      return next;
    }).immediate();
  }

  pendingDispatches(limit = 100): WorkflowDispatch[] {
    const rows = this.db.prepare(`SELECT dispatch_id,workflow_id,payload_json FROM collaboration_dispatch_outbox
      WHERE published_at IS NULL ORDER BY dispatch_id LIMIT ?`).all(limit) as OutboxRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as WorkflowDispatch);
  }

  markPublished(dispatchId: string, now = Date.now()): void {
    this.db.prepare(`UPDATE collaboration_dispatch_outbox SET published_at=?
      WHERE dispatch_id=? AND published_at IS NULL`).run(now, dispatchId);
  }

  close(): void { this.db.close(); }
}
