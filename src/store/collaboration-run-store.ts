import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { sanitizeResult } from "../security/redaction.js";
import { openStateStoreAccess, type StateStoreInput } from "./state-database-fence.js";
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
}

export type PendingWorkflowDispatch =
  | { dispatchId: string; workflowId: string; value: WorkflowDispatch }
  | { dispatchId: string; workflowId: string; error: string };

interface WorkflowRow { state_json: string; version: number }
interface OutboxRow {
  dispatch_id: string;
  workflow_id: string;
  payload_json: string;
  terminal_reason?: string | null;
}

const immutableWorkflowInput = (run: CollaborationRun) => sanitizeResult({
  taskId: run.taskId,
  origin: run.origin,
  policyVersion: run.policyVersion,
  stages: run.stages,
  retryPolicy: run.retryPolicy,
});

export class CollaborationRunStore {
  private readonly db: Database.Database;
  private readonly closeAccess: () => void;

  constructor(pathOrDatabase: StateStoreInput) {
    const opened = openStateStoreAccess(pathOrDatabase);
    try {
      this.db = opened.access.database;
      this.closeAccess = opened.close;
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      const outboxColumns = new Set(
        (this.db.prepare("PRAGMA table_info(collaboration_dispatch_outbox)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      const runColumns = new Set(
        (this.db.prepare("PRAGMA table_info(collaboration_runs)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      const index = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='collaboration_outbox_pending'",
      ).get();
      if (!["workflow_id", "state_json", "version", "updated_at"].every((column) => runColumns.has(column)) ||
          !["dispatch_id", "workflow_id", "payload_json", "published_at", "terminal_reason"]
            .every((column) => outboxColumns.has(column)) || index === undefined) {
        throw new Error("collaboration store requires current migration-owned schema");
      }
      const legacy = this.db.prepare("SELECT state_json FROM collaboration_runs ORDER BY workflow_id")
        .all() as Array<{ state_json: string }>;
      if (legacy.some(({ state_json }) => {
        const state = JSON.parse(state_json) as { policyVersion?: unknown };
        return state.policyVersion !== "routing-v5";
      })) {
        throw new Error("collaboration runs require offline routing-v5 migration");
      }
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  get(workflowId: string): CollaborationRun | null {
    const row = this.db.prepare("SELECT state_json,version FROM collaboration_runs WHERE workflow_id=?")
      .get(workflowId) as WorkflowRow | undefined;
    return row ? restoreCollaborationRun(row.state_json) : null;
  }

  assertReplayCompatible(workflowId: string, run: CollaborationRun): CollaborationRun | null {
    const existing = this.get(workflowId);
    if (!existing) return null;
    if (existing.status === "blocked_policy_upgrade") {
      throw new Error("routing policy upgrade requires a new workflow identity");
    }
    if (!isDeepStrictEqual(immutableWorkflowInput(existing), immutableWorkflowInput(run))) {
      throw new Error("workflow id conflicts with immutable collaboration input");
    }
    return existing;
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
      const payload = sanitizeResult({
        dispatchId,
        workflowId,
        dispatch,
        stage,
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
      const existing = this.assertReplayCompatible(workflowId, run);
      if (existing) return existing;
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
      WHERE published_at IS NULL AND terminal_reason IS NULL ORDER BY dispatch_id LIMIT ?`).all(limit) as OutboxRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as WorkflowDispatch);
  }

  pendingDispatchCandidates(limit = 100): PendingWorkflowDispatch[] {
    const rows = this.db.prepare(`SELECT dispatch_id,workflow_id,payload_json FROM collaboration_dispatch_outbox
      WHERE published_at IS NULL AND terminal_reason IS NULL ORDER BY dispatch_id LIMIT ?`).all(limit) as OutboxRow[];
    return rows.map((row) => {
      try {
        return { dispatchId: row.dispatch_id, workflowId: row.workflow_id,
          value: JSON.parse(row.payload_json) as WorkflowDispatch };
      } catch (error) {
        return { dispatchId: row.dispatch_id, workflowId: row.workflow_id,
          error: `invalid outbox payload: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  }

  markPublished(dispatchId: string, now = Date.now()): void {
    this.db.prepare(`UPDATE collaboration_dispatch_outbox SET published_at=?
      WHERE dispatch_id=? AND published_at IS NULL`).run(now, dispatchId);
  }

  quarantineDispatch(
    dispatch: Pick<WorkflowDispatch, "dispatchId" | "workflowId">,
    reason: string,
    now = Date.now(),
  ): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT state_json,version FROM collaboration_runs WHERE workflow_id=?")
        .get(dispatch.workflowId) as WorkflowRow | undefined;
      if (!row) throw new Error(`Unknown workflow: ${dispatch.workflowId}`);
      const before = restoreCollaborationRun(row.state_json);
      const indexText = dispatch.dispatchId.slice(dispatch.dispatchId.lastIndexOf(":") + 1);
      const index = Number(indexText);
      const exact = Number.isSafeInteger(index) && index >= 0 &&
        dispatch.dispatchId === `${dispatch.workflowId}:dispatch:${index}`
        ? before.dispatches[index]
        : undefined;
      const stageId = exact?.stageId ?? before.activeStage?.id;
      if (stageId) {
        const next = transitionCollaborationRun(before, {
          type: "BROKER_DISPATCH_REJECTED", eventId: `${dispatch.dispatchId}:outbox-quarantined`,
          stageId, runId: dispatch.dispatchId, reason,
        });
        const changed = this.db.prepare(`UPDATE collaboration_runs
          SET state_json=?,version=version+1,updated_at=? WHERE workflow_id=? AND version=?`).run(
            serializeCollaborationRun(sanitizeResult(next)), now, dispatch.workflowId, row.version,
          ).changes;
        if (changed !== 1) throw new Error("Collaboration workflow CAS conflict");
      }
      const disposition = JSON.stringify({ kind: "outbox_dispatch_quarantined", reason });
      this.db.prepare(`UPDATE collaboration_dispatch_outbox
        SET published_at=COALESCE(published_at,?),terminal_reason=COALESCE(terminal_reason,?)
        WHERE dispatch_id=?`).run(now, disposition, dispatch.dispatchId);
    }).immediate();
  }

  close(): void { this.closeAccess(); }
}
