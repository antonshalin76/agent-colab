import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReviewRuntimeComposition } from "../src/app/review-runtime-composition.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { RunStore } from "../src/store/run-store.js";
import { openStateDatabaseLease } from "../src/store/state-database-fence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readyEvidence = () => new ReviewEvidenceCapture({
  captureSource: ({ project }) => ({
    sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint,
    valid: true,
  }),
  captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
  observedAt: () => 100,
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-runtime-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const databasePath = join(root, "state.db");
  initializeCurrentExecutionSchema(databasePath);
  const access = openStateDatabaseLease(databasePath, "mutating_service");
  return { root, project, databasePath, access };
};

describe("review-only production composition", () => {
  it("does not import the quarantined workflow, graph, history, worktree, or full service owners", () => {
    const source = readFileSync(
      new URL("../src/app/review-runtime-composition.ts", import.meta.url),
      "utf8",
    );

    for (const forbidden of [
      "LocalCollabService",
      "/history/",
      "/workflow/",
      "CollaborationRuntime",
      "Worktree",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("owns only the review application stores and hides unrelated queued work", async () => {
    const { root, project, access } = fixture();
    const unrestricted = new RunStore(access.borrow());
    unrestricted.enqueue({
      idempotencyKey: "ordinary-workflow-run",
      stage: "implementation",
      priority: 1,
      now: 1,
    });
    unrestricted.close();

    const runtime = createReviewRuntimeComposition(access, {
      allowedRoots: [root],
      evidenceCapture: readyEvidence(),
    });
    for (const agent of ["grok", "claude", "codex"] as const) {
      runtime.providers.recordSuccess(agent, 2);
    }

    const artifactContent = "immutable review-only artifact";
    const review = await runtime.requestReview({
      requester: "codex",
      approvalScope: "workspace-read",
      workspaceRoot: project,
      artifactContent,
      artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
      prompt: "audit and critique",
      idempotencyKey: "review-only-composition",
    });
    const status = await runtime.status() as {
      protocol: string;
      capabilities: { reviewOnly: boolean };
      queue: Record<string, number>;
    };

    expect(review).toMatchObject({ laneCount: 6, activeLaneCount: 6 });
    expect(status).toMatchObject({
      protocol: "agent-collab-review-only/v1",
      capabilities: { reviewOnly: true },
      queue: { queued: 6 },
    });
    expect(runtime.runs.getByIdempotencyKey("ordinary-workflow-run")).toBeUndefined();
    expect(runtime.runs.list()).toHaveLength(6);

    runtime.close();
    expect(() => access.assertUsable()).toThrow(/closed/i);
  });

  it("releases the transferred state capability when construction fails", () => {
    const { access } = fixture();

    expect(() => createReviewRuntimeComposition(access, {
      allowedRoots: [join(tmpdir(), "definitely-missing-agent-collab-root")],
      evidenceCapture: readyEvidence(),
    })).toThrow(/allowed project root/i);
    expect(() => access.assertUsable()).toThrow(/closed/i);
  });
});
