import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import canonicalize from "canonicalize";
import { normalizeReviewProviderResult } from "../src/domain/review-verdict.js";
import {
  createReviewRunInput,
  RunGateUnitOfWork,
  type ReviewAdmissionReceiptPair,
} from "../src/runtime/run-gate-unit-of-work.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
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
    const admissionReceipts: ReviewAdmissionReceiptPair[] = [];
    for (const agent of ["grok", "claude", "codex"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        const activationNonce = `verdict/${agent}/${role}`;
        const sourceReceiptId = `${activationNonce}/source`;
        const readinessReceiptId = `${activationNonce}/readiness`;
        store.captureReviewReceiptPair({ pairId: activationNonce, phase: "admission",
          activationNonce, scopeRevision: 1, recoveryGeneration: null,
          expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
          predecessorReceiptIds: { source: null, readiness: null }, receipts: {
            source: { receiptId: sourceReceiptId, scope: `review/${reviewId}/${agent}/${role}/source`,
              observation: { sourceFingerprint, valid: true } },
            readiness: { receiptId: readinessReceiptId,
              scope: `review/${reviewId}/${agent}/${role}/readiness`,
              observation: { harnessReady: true, valid: true } },
          }, createdAt: 1 });
        admissionReceipts.push({ agent, role, activationNonce, sourceReceiptId, readinessReceiptId });
      }
    }
    store.create({
      reviewId,
      stageId: "code-review",
      artifact,
      approvalScope: "workspace-read",
      idempotencyKey: "review-verdict-composition:v1",
      prompts: { auditor: "audit", critic: "critic" },
      health: { grok: "healthy", claude: "healthy", codex: "healthy" },
      project,
      requester: "codex",
      sourceFingerprint,
      createdAt: 1,
      admissionReceipts,
    });
    const providerHealth = new ProviderHealthStore(database, { cooldownMs: 1_000 });
    for (const agent of ["codex", "grok", "claude"] as const) providerHealth.recordSuccess(agent, 1);
    providerHealth.close();

    for (const agent of ["codex", "grok", "claude"] as const) {
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
        const source = { sourceFingerprint, valid: true };
        const readiness = { harnessReady: true, valid: true };
        const hash = (value: unknown) => {
          const encoded = canonicalize(value);
          if (encoded === undefined) throw new Error("test evidence must be JSON");
          return createHash("sha256").update(encoded).digest("hex");
        };
        const scope = `attempt/${attempt.attemptId}/prelaunch`;
        const cursor = store.receiptCursor(scope);
        const receiptId = `${attempt.attemptId}/prelaunch`;
        store.captureReviewReceipt({ receiptId, phase: "prelaunch", scope,
          scopeRevision: cursor.scopeRevision, activationNonce: receiptId,
          expectedTuple: { attemptId: attempt.attemptId }, recoveryGeneration: null,
          observation: { source, readiness, sourceObservationHash: hash(source),
            readinessObservationHash: hash(readiness) },
          predecessorReceiptId: cursor.predecessorReceiptId, createdAt: 1 });
        const fence = store.applyPrelaunchFence({ attemptId: attempt.attemptId,
          prelaunchReceiptId: receiptId, now: 1 });
        expect(fence).toMatchObject({ status: "authorized" });
        runs.markLaunchIntent(claimed.id, claimed.leaseToken!, {
          agent, ...(fence.spawnAuthority as Record<string, unknown>),
        });
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
