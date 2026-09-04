import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewApplicationService } from "../src/app/review-application-service.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { ProjectPolicy } from "../src/security/project-policy.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function logicalReviewState(path: string): Record<string, unknown> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = (database.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND (name='runs' OR name='runtime_provider_health'
        OR name LIKE 'runtime_review_%') ORDER BY name`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    return Object.fromEntries(tables.map((table) => {
      const rows = database.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      return [table, rows.map((row) => JSON.stringify(row)).sort()];
    }));
  } finally {
    database.close();
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-request-idempotency-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const databasePath = join(root, "state.db");
  initializeCurrentExecutionSchema(databasePath);
  return { root, project, databasePath };
}

function openApplication(input: { root: string; project: string; databasePath: string }) {
  const captureSource = vi.fn(() => ({
    sourceFingerprint: captureWorkspaceFingerprint(input.project).fingerprint,
    valid: true,
  }));
  const captureReadiness = vi.fn(() => ({ harnessReady: true, state: "ready", valid: true }));
  const runs = new RunStore(input.databasePath, { scope: "review" });
  const reviews = new RunGateUnitOfWork(input.databasePath);
  const providers = new ProviderHealthStore(input.databasePath, { cooldownMs: 60_000 });
  for (const agent of ["grok", "claude", "codex"] as const) providers.recordSuccess(agent, 1);
  const service = new ReviewApplicationService({
    runs,
    reviews,
    providers,
    projects: new ProjectPolicy([input.root]),
    evidenceCapture: new ReviewEvidenceCapture({
      captureSource,
      captureReadiness,
      observedAt: () => 100,
    }),
  });
  return {
    service,
    captureSource,
    captureReadiness,
    close() {
      providers.close();
      reviews.close();
      runs.close();
    },
  };
}

function request(project: string, overrides: Record<string, unknown> = {}) {
  const artifactContent = "immutable idempotent review artifact";
  return {
    requester: "codex" as const,
    workspaceRoot: project,
    artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
    artifactContent,
    prompt: "review the immutable artifact",
    approvalScope: "workspace-read" as const,
    idempotencyKey: "request-review-idempotency",
    ...overrides,
  };
}

describe("requestReview durable idempotency", () => {
  it("replays the exact request with the same response and zero admission or persistence effects", async () => {
    const context = fixture();
    const application = openApplication(context);
    try {
      const first = await application.service.requestReview(request(context.project));
      const before = logicalReviewState(context.databasePath);
      const sourceCalls = application.captureSource.mock.calls.length;
      const readinessCalls = application.captureReadiness.mock.calls.length;

      const replay = await application.service.requestReview(request(context.project));

      expect(replay).toEqual(first);
      expect(application.captureSource).toHaveBeenCalledTimes(sourceCalls);
      expect(application.captureReadiness).toHaveBeenCalledTimes(readinessCalls);
      expect(logicalReviewState(context.databasePath)).toEqual(before);
    } finally {
      application.close();
    }
  });

  it("rejects an immutable-key conflict before evidence capture and without changing durable state", async () => {
    const context = fixture();
    const application = openApplication(context);
    try {
      await application.service.requestReview(request(context.project));
      const before = logicalReviewState(context.databasePath);
      const sourceCalls = application.captureSource.mock.calls.length;
      const readinessCalls = application.captureReadiness.mock.calls.length;

      await expect(application.service.requestReview(request(context.project, {
        prompt: "a conflicting prompt under the same key",
      }))).rejects.toThrow(/immutable review conflict/i);

      expect(application.captureSource).toHaveBeenCalledTimes(sourceCalls);
      expect(application.captureReadiness).toHaveBeenCalledTimes(readinessCalls);
      expect(logicalReviewState(context.databasePath)).toEqual(before);
    } finally {
      application.close();
    }
  });

  it("replays effectlessly after the application stores are reopened", async () => {
    const context = fixture();
    const firstApplication = openApplication(context);
    const first = await firstApplication.service.requestReview(request(context.project));
    firstApplication.close();
    const before = logicalReviewState(context.databasePath);
    const reopened = openApplication(context);
    try {
      const replay = await reopened.service.requestReview(request(context.project));

      expect(replay).toEqual(first);
      expect(reopened.captureSource).not.toHaveBeenCalled();
      expect(reopened.captureReadiness).not.toHaveBeenCalled();
      expect(logicalReviewState(context.databasePath)).toEqual(before);
    } finally {
      reopened.close();
    }
  });
});
