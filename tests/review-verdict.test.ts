import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeReviewProviderResult } from "../src/domain/review-verdict.js";
import { createReviewRunInput, RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { RunStore } from "../src/store/run-store.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const passText = JSON.stringify({
  schemaVersion: "review-verdict/v1",
  verdict: "PASS",
  findings: [],
});

describe("review verdict composition boundary", () => {
  it("accepts informational findings under PASS after risk_level normalization", () => {
    expect(normalizeReviewProviderResult({
      kind: "success",
      text: JSON.stringify({
        schemaVersion: "review-verdict/v1",
        verdict: "PASS",
        findings: [{ risk_level: "info", message: "non-blocking observation" }],
      }),
    })).toMatchObject({
      reviewVerdict: {
        verdict: "PASS",
        findings: [{ risk_level: "info" }],
      },
    });
  });

  it("normalizes the exact AgentRunner visible text before opening a review lane", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-verdict-"));
    roots.push(root);
    const database = join(root, "state.db");
    initializeCurrentExecutionSchema(database);
    const store = new RunGateUnitOfWork(database);
    const runs = new RunStore(database);
    const artifact = Buffer.from("exact packet", "utf8");
    const reviewId = "review-verdict-composition";
    const project = process.cwd();
    const sourceFingerprint = captureWorkspaceFingerprint(project).fingerprint;
    store.create({
      reviewId,
      stageId: "code-review",
      artifact,
      approvalScope: "workspace-read",
      idempotencyKey: "review-verdict-composition:v1",
      prompts: { auditor: "audit", critic: "critic" },
      health: { grok: "healthy", codex: "healthy" },
      project,
      requester: "codex",
      sourceFingerprint,
      createdAt: 1,
    });

    for (const agent of ["grok", "codex"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        const attempt = store.attempts(reviewId, agent, role).at(-1)!;
        const result = normalizeReviewProviderResult({ kind: "success", agent, text: passText });
        const descriptor = store.enqueueDescriptors(reviewId).find(
          (candidate) => candidate.agent === agent && candidate.role === role,
        )!;
        const queued = runs.enqueueExact(createReviewRunInput(descriptor));
        const claimed = runs.claimNext({ workerId: "verdict-test", leaseMs: 1_000,
          now: Date.now() + 1_000 })!;
        expect(claimed.id).toBe(queued.id);
        runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent });
        runs.markLaunched(claimed.id, claimed.leaseToken!, { phase: "started", pid: 1234,
          agent, model: attempt.model, effort: attempt.effort,
          policyVersion: attempt.policyVersion, sessionId: attempt.sessionId });
        runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: result,
          effect: { type: "review", reviewId, attemptId: attempt.attemptId, role, agent,
            resultKind: "success", terminalAt: 2 }, status: "completed" });
        store.recordTerminal({
          reviewId,
          agent,
          role,
          attemptId: attempt.attemptId,
          status: "completed",
          result,
          terminalAt: 2,
        });
      }
    }
    expect(store.get(reviewId)?.artifactHash).toBe(createHash("sha256").update(artifact).digest("hex"));
    expect(store.barrier(reviewId).satisfied).toBe(true);
    runs.close();
    store.close();
  });

  it.each([
    "PASS",
    "```json\n" + passText + "\n```",
    JSON.stringify({ schemaVersion: "review-verdict/v1", verdict: "PASS", findings: [{ risk_level: "warn", message: "hidden" }] }),
    JSON.stringify({ schemaVersion: "review-verdict/v1", verdict: "CHANGES_REQUESTED", findings: [] }),
    JSON.stringify({ schemaVersion: "review-verdict/v1", verdict: "CHANGES_REQUESTED", findings: [{ risk: "warn", message: "legacy field" }] }),
  ])("rejects malformed or semantically inconsistent review text", (text) => {
    expect(() => normalizeReviewProviderResult({ kind: "success", text })).toThrow(/review verdict|JSON/i);
  });
});
