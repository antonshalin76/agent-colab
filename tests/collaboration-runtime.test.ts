import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createCurrentMapLearningLaunchBinding, formatMapLearningLaunchBindingContext } from "../src/flow/map-admin.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { createCollaborationRun } from "../src/workflow/workflow.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("permanent CollaborationRuntime quarantine", () => {
  it("rejects a valid legacy linear start before aggregate or outbox mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-quarantine-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const databasePath = join(root, "state.db");
    initializeCurrentExecutionSchema(databasePath);
    const workspace = captureWorkspaceFingerprint(project);
    const mapLearning = createCurrentMapLearningLaunchBinding("codex");
    const run = createCollaborationRun({
      taskId: "quarantined-linear-task",
      origin: "codex",
      health: { grok: "unavailable", codex: "healthy" },
      stages: [{
        id: "legacy-review-stage",
        kind: "code_review",
        role: "stage-owner",
        artifactRef: `artifact:${"a".repeat(64)}`,
        artifactHash: "a".repeat(64),
        artifactBytes: 1,
        changedFiles: workspace.changedFiles.length,
        approvalScope: "workspace-read",
        idempotencyKey: "quarantined-linear-task:review",
        project,
        prompt: `${formatMapLearningLaunchBindingContext(mapLearning)}\n\nreview`,
        requester: "codex",
        sourceFingerprint: workspace.fingerprint,
        mapLearning,
      }],
    });
    const runtime = new CollaborationRuntime(databasePath);
    try {
      expect(() => runtime.createAndStart("quarantined-linear-workflow", run, [], 1))
        .toThrow(/linear delegation is permanently disabled/i);
    } finally {
      runtime.close();
    }

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) FROM collaboration_runs").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM collaboration_dispatch_outbox").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps the review-only production composition detached from the legacy runtime", () => {
    const production = [
      "../src/app/review-runtime-composition.ts",
      "../src/app/review-worker-runtime.ts",
      "../src/mcp/review-only-server.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

    expect(production).not.toMatch(/CollaborationRuntime|ExecutionAdmission|CollaborationRunStore/);
  });
});
