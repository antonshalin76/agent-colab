import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { createReviewRunInput, RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { RunStore } from "../src/store/run-store.js";
import { formatMapLearningLaunchBindingContext } from "../src/flow/map-admin.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

type V3CreateInput = Parameters<RunGateUnitOfWork["create"]>[0];

function createV3(store: RunGateUnitOfWork, createInput: V3CreateInput): ReturnType<RunGateUnitOfWork["create"]> {
  const captureMethod = (store as unknown as Record<string, unknown>).captureReviewReceiptPair;
  expect(captureMethod, "new barrier fixtures must use authority-v3 receipt pairs").toBeTypeOf("function");
  const capturePair = (captureMethod as (input: Record<string, unknown>) => unknown).bind(store);
  const admissionReceipts: NonNullable<V3CreateInput["admissionReceipts"]> = [];
  for (const agent of ["grok", "claude", "codex"] as const) {
    if (createInput.health[agent] !== "healthy") continue;
    for (const role of ["auditor", "critic"] as const) {
      const activationNonce = `create/${createInput.reviewId}/${agent}/${role}`;
      const sourceReceiptId = `${activationNonce}/source`;
      const readinessReceiptId = `${activationNonce}/readiness`;
      capturePair({ pairId: activationNonce, phase: "admission", activationNonce,
        scopeRevision: 1, recoveryGeneration: null,
        expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
        predecessorReceiptIds: { source: null, readiness: null },
        receipts: {
          source: { receiptId: sourceReceiptId,
            scope: `review/${createInput.reviewId}/${agent}/${role}/source`,
            observation: { sourceFingerprint: createInput.sourceFingerprint, valid: true } },
          readiness: { receiptId: readinessReceiptId,
            scope: `review/${createInput.reviewId}/${agent}/${role}/readiness`,
            observation: { harnessReady: true, valid: true } },
        }, createdAt: createInput.createdAt });
      admissionReceipts.push({ agent, role, activationNonce, sourceReceiptId, readinessReceiptId });
    }
  }
  return store.create({ ...createInput, admissionReceipts });
}

type LegacyActivationInput = Parameters<RunGateUnitOfWork["activateDeferred"]>[0];

function activateV3(
  store: RunGateUnitOfWork,
  activation: LegacyActivationInput,
): ReturnType<RunGateUnitOfWork["activateDeferred"]> {
  if (store.barrier(activation.reviewId).satisfied) {
    return (store.activateDeferred as unknown as (input: Record<string, unknown>) =>
      ReturnType<RunGateUnitOfWork["activateDeferred"]>)({
        reviewId: activation.reviewId, agent: activation.agent, now: activation.now,
        recoveryGeneration: null, admissionReceipts: [],
      });
  }
  if (activation.harnessReady !== true) {
    return { status: "harness_unavailable", lanes: [] };
  }
  if (!store.get(activation.reviewId)?.lanes.some(({ agent, status }) =>
    agent === activation.agent && status === "deferred")) {
    return (store.activateDeferred as unknown as (input: Record<string, unknown>) =>
      ReturnType<RunGateUnitOfWork["activateDeferred"]>)({
        reviewId: activation.reviewId, agent: activation.agent, now: activation.now,
        recoveryGeneration: null, admissionReceipts: [],
      });
  }
  const providerHealth = activation.providerHealth;
  if (!providerHealth) throw new Error("v3 activation fixture requires provider health");
  const claimedAt = activation.now;
  const probe = providerHealth.acquireExplicitProbeAdmission(activation.agent, claimedAt);
  if (!probe.runnable) return { status: "provider_unavailable", lanes: [] };
  providerHealth.recordSuccess(activation.agent, activation.now, probe.claimedAt);
  const generationMethod = (providerHealth as unknown as Record<string, unknown>).latestRecoveryGeneration;
  expect(generationMethod, "rejoin fixtures require the explicit probe generation").toBeTypeOf("function");
  const recoveryGeneration = (generationMethod as (agent: string) => number)
    .call(providerHealth, activation.agent);
  const tupleMethod = (store as unknown as Record<string, unknown>).admissionTuple;
  const captureMethod = (store as unknown as Record<string, unknown>).captureReviewReceiptPair;
  const cursorMethod = (store as unknown as Record<string, unknown>).receiptPairCursor;
  expect(tupleMethod).toBeTypeOf("function");
  expect(captureMethod).toBeTypeOf("function");
  expect(cursorMethod).toBeTypeOf("function");
  const admissionReceipts: Array<Record<string, unknown>> = [];
  const review = store.get(activation.reviewId)!;
  for (const lane of review.lanes.filter(({ agent, status }) =>
    agent === activation.agent && status === "deferred")) {
    const expectedTuple = (tupleMethod as (...args: unknown[]) => Record<string, unknown>)
      .call(store, activation.reviewId, activation.agent, lane.role);
    const activationNonce = `rejoin/${activation.reviewId}/${activation.agent}/${lane.role}/${recoveryGeneration}`;
    const sourceReceiptId = `${activationNonce}/source`;
    const readinessReceiptId = `${activationNonce}/readiness`;
    const sourceScope = `review/${activation.reviewId}/${activation.agent}/${lane.role}/source`;
    const readinessScope = `review/${activation.reviewId}/${activation.agent}/${lane.role}/readiness`;
    const cursor = (cursorMethod as (input: Record<string, unknown>) => {
      scopeRevision: number;
      predecessorReceiptIds: { source: string | null; readiness: string | null };
    }).call(store, { sourceScope, readinessScope });
    (captureMethod as (input: Record<string, unknown>) => unknown).call(store, {
      pairId: activationNonce, phase: "admission", activationNonce,
      scopeRevision: cursor.scopeRevision, recoveryGeneration, expectedTuple,
      predecessorReceiptIds: cursor.predecessorReceiptIds,
      receipts: {
        source: { receiptId: sourceReceiptId,
          scope: sourceScope,
          observation: { sourceFingerprint: activation.currentSourceFingerprint, valid: true } },
        readiness: { receiptId: readinessReceiptId,
          scope: readinessScope,
          observation: { harnessReady: true, valid: true } },
      }, createdAt: activation.now,
    });
    admissionReceipts.push({ role: lane.role, activationNonce, sourceReceiptId, readinessReceiptId });
  }
  return (store.activateDeferred as unknown as (input: Record<string, unknown>) =>
    ReturnType<RunGateUnitOfWork["activateDeferred"]>)({
      reviewId: activation.reviewId, agent: activation.agent, now: activation.now,
      recoveryGeneration, admissionReceipts,
    });
}

const roots: string[] = [];
const rawDatabase = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-"));
  roots.push(root);
  return join(root, "state.db");
};
const database = () => {
  const path = rawDatabase();
  initializeCurrentExecutionSchema(path);
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const artifact = Buffer.from("immutable runtime review packet", "utf8");
const artifactHash = createHash("sha256").update(artifact).digest("hex");
const project = process.cwd();
const sourceFingerprint = captureWorkspaceFingerprint(project).fingerprint;
const healthyReviewProviders = {
  grok: "healthy",
  claude: "healthy",
  codex: "healthy",
} as const;
const input = {
  reviewId: "review-runtime-1",
  stageId: "architecture-audit",
  artifact,
  approvalScope: "workspace-read" as const,
  idempotencyKey: "review-runtime-1:artifact-v2",
  prompts: {
    auditor: "audit only the immutable packet",
    critic: "challenge only the immutable packet",
  },
  project,
  requester: "codex" as const,
  sourceFingerprint,
  createdAt: 100,
};

const attemptIdFor = (
  store: RunGateUnitOfWork,
  agent: "grok" | "claude" | "codex",
  role: "auditor" | "critic",
): string => store.attempts(input.reviewId, agent, role).at(-1)!.attemptId;

const passResult = () => ({
  kind: "success",
  reviewVerdict: {
    schemaVersion: "review-verdict/v1",
    verdict: "PASS",
    findings: [],
  },
});

const changesResult = () => ({
  kind: "success",
  reviewVerdict: {
    schemaVersion: "review-verdict/v1",
    verdict: "CHANGES_REQUESTED",
    findings: [{ risk_level: "warn", message: "finding" }],
  },
});

const inconclusiveResult = () => ({
  kind: "success",
  reviewVerdict: {
    schemaVersion: "review-verdict/v1",
    verdict: "INCONCLUSIVE",
    findings: [],
  },
});

const warningPassResult = () => ({
  kind: "success",
  reviewVerdict: {
    schemaVersion: "review-verdict/v1",
    verdict: "PASS",
    findings: [{ risk_level: "warn", message: "blocking warning" }],
  },
});

const malformedSuccessResult = () => ({
  kind: "success",
  reviewVerdict: { verdict: "PASS", findings: [] },
});

const prioritizeRun = (path: string, idempotencyKey: string): void => {
  const db = new Database(path);
  db.prepare("UPDATE runs SET next_attempt_at=9000000000000000 WHERE status='queued'").run();
  db.prepare("UPDATE runs SET next_attempt_at=0 WHERE idempotency_key=? AND status='queued'")
    .run(idempotencyKey);
  db.close();
};

const authorizeClaimedReview = (
  store: RunGateUnitOfWork,
  claimed: ReturnType<RunStore["claimNext"]> & {},
  now: number,
): { authorityId: string; authorityHash: string } => {
  const attemptId = String(claimed.payload?.reviewAttemptId);
  const source = { sourceFingerprint: String(claimed.payload?.sourceFingerprint), valid: true };
  const readiness = { harnessReady: true, valid: true };
  const hash = (value: unknown) => {
    const encoded = canonicalize(value);
    if (encoded === undefined) throw new Error("test evidence must be JSON");
    return createHash("sha256").update(encoded).digest("hex");
  };
  const scope = `attempt/${attemptId}/prelaunch`;
  const cursor = store.receiptCursor(scope);
  const receiptId = `${attemptId}/prelaunch/${cursor.scopeRevision}`;
  store.captureReviewReceipt({ receiptId, phase: "prelaunch", scope,
    scopeRevision: cursor.scopeRevision, activationNonce: receiptId,
    expectedTuple: { attemptId }, recoveryGeneration: null,
    observation: { source, readiness, sourceObservationHash: hash(source),
      readinessObservationHash: hash(readiness) },
    predecessorReceiptId: cursor.predecessorReceiptId, createdAt: now });
  const result = store.applyPrelaunchFence({ attemptId, prelaunchReceiptId: receiptId,
    reviewId: String(claimed.payload?.reviewId), runId: claimed.id,
    agent: (claimed.payload?.decision as { agent: "grok" | "claude" | "codex" }).agent,
    role: claimed.payload?.reviewRole as "auditor" | "critic",
    attemptOrdinal: Number(claimed.payload?.reviewAttemptOrdinal), now });
  expect(result).toMatchObject({ status: "authorized", spawnAuthority: {
    authorityId: expect.any(String), authorityHash: expect.any(String),
  } });
  return result.spawnAuthority as { authorityId: string; authorityHash: string };
};

const completeLaneWithEvidence = (
  path: string,
  store: RunGateUnitOfWork,
  agent: "grok" | "claude" | "codex",
  role: "auditor" | "critic",
  verdict: "pass" | "changes" = "pass",
): void => {
  const review = store.get(input.reviewId)!;
  const lane = review.lanes.find((item) => item.agent === agent && item.role === role)!;
  const attempt = lane.attempts.at(-1)!;
  const result = { ...(verdict === "pass" ? passResult() : changesResult()), agent };
  const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
  health.recordSuccess(agent, Date.now());
  health.close();
  const runs = new RunStore(path);
  const queued = runs.getByIdempotencyKey(attempt.idempotencyKey)!;
  prioritizeRun(path, attempt.idempotencyKey);
  const claimed = runs.claimNext({ workerId: "review-test", leaseMs: 1_000, now: Date.now() + 1_000 })!;
  expect(claimed.id).toBe(queued.id);
  const spawnAuthority = authorizeClaimedReview(store, claimed, 250);
  runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent, ...spawnAuthority });
  runs.markLaunched(claimed.id, claimed.leaseToken!, {
    phase: "started", pid: 1234, agent, model: attempt.model, effort: attempt.effort,
    policyVersion: attempt.policyVersion, sessionId: attempt.sessionId,
  });
  runs.commitDomainEffect({ id: queued.id, token: claimed.leaseToken!, providerResult: result,
    effect: { type: "review", reviewId: review.reviewId, attemptId: attempt.attemptId,
      role, agent, resultKind: "success", terminalAt: 300 }, status: "completed" });
  store.recordTerminal({ reviewId: review.reviewId, agent, role, attemptId: attempt.attemptId,
    status: "completed", result, terminalAt: 300 });
  runs.close();
};

const failReviewPairWithEvidence = (
  path: string,
  store: RunGateUnitOfWork,
  agent: "grok" | "claude" | "codex",
  terminalAt: number,
  kind: "quota" | "model_unavailable",
): NonNullable<ReturnType<RunGateUnitOfWork["get"]>>["lanes"] => {
  const lanes = store.get(input.reviewId)!.lanes.filter((lane) => lane.agent === agent);
  expect(lanes.map(({ role }) => role).sort()).toEqual(["auditor", "critic"]);
  const runs = new RunStore(path);
  for (const [index, lane] of lanes.entries()) {
    const attempt = lane.attempts.at(-1)!;
    prioritizeRun(path, attempt.idempotencyKey);
    const claimed = runs.claimNext({ workerId: `provider-unavailable-${agent}-${lane.role}`,
      leaseMs: 1_000, now: Date.now() + 1_000 + index })!;
    expect(claimed.idempotencyKey).toBe(attempt.idempotencyKey);
    const spawnAuthority = authorizeClaimedReview(store, claimed, terminalAt - 1);
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent, ...spawnAuthority });
    runs.markLaunched(claimed.id, claimed.leaseToken!, {
      phase: "started", pid: 1234 + index, agent, model: attempt.model,
      effort: attempt.effort, policyVersion: attempt.policyVersion, sessionId: attempt.sessionId,
    });
    const unavailable = { kind, agent, role: lane.role };
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: unavailable,
      effect: { type: "review", reviewId: input.reviewId, attemptId: attempt.attemptId,
        role: lane.role, agent, resultKind: kind, terminalAt,
        providerAdmissionClaimedAt: attempt.providerAdmissionClaimedAt },
      status: "completed" });
    store.recordProviderUnavailable({ reviewId: input.reviewId, agent, role: lane.role,
      attemptId: attempt.attemptId, error: unavailable, terminalAt });
  }
  runs.close();
  return lanes;
};

const activateAndCompleteCodex = (
  path: string,
  store: RunGateUnitOfWork,
  health: ProviderHealthStore,
  now: number,
): void => {
  health.recordSuccess("codex", now);
  const codexQueued = store.get(input.reviewId)?.lanes.some((lane) =>
    lane.agent === "codex" && lane.status === "queued");
  if (!codexQueued) {
    expect(activateV3(store, {
      reviewId: input.reviewId,
      agent: "codex",
      currentSourceFingerprint: sourceFingerprint,
      now,
      providerHealth: health,
      harnessReady: true,
    }).status).toBe("activated");
  }
  completeLaneWithEvidence(path, store, "codex", "auditor");
  completeLaneWithEvidence(path, store, "codex", "critic");
};

describe("runtime durable review barrier", () => {
  it("consumes each persisted review lane grant at most once", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, reviewId: "one-shot-grant", idempotencyKey: "one-shot-grant",
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" } });

    const first = activateV3(store, {
      reviewId: "one-shot-grant",
      agent: "grok",
      currentSourceFingerprint: sourceFingerprint,
      now: 2,
      providerHealth: health,
      harnessReady: true,
    });
    expect(first.lanes).toHaveLength(2);
    const auditor = first.lanes.find((lane) => lane.role === "auditor")!;
    const db = new Database(path);
    db.prepare(`UPDATE runtime_review_lanes SET status='deferred'
      WHERE review_id='one-shot-grant' AND agent='grok' AND role='auditor'`).run();
    db.close();

    expect(activateV3(store, {
      reviewId: "one-shot-grant",
      agent: "grok",
      currentSourceFingerprint: sourceFingerprint,
      now: 3,
      providerHealth: health,
      harnessReady: true,
    })).toEqual({ status: "none", lanes: [] });
    expect(store.attempts("one-shot-grant", "grok", "auditor")).toEqual([
      expect.objectContaining({ attemptId: auditor.attemptId, attemptOrdinal: 0 }),
    ]);

    store.close();
    health.close();
  });

  it("fails closed for a legacy barrier with an incomplete Codex quorum", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 1);
    const store = new RunGateUnitOfWork(path);
    const db = new Database(path);
    db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
       run_state,created_at,project,requester,source_fingerprint,changed_files,launch_authority_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
        "legacy-authority", input.stageId, input.artifact, artifactHash, input.approvalScope,
        "legacy-authority", "DEGRADED_REVIEW_SET", input.createdAt, input.project,
        input.requester, input.sourceFingerprint, 0);
    db.prepare(`INSERT INTO runtime_review_lanes
      (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
       idempotency_key,prompt,degraded) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-authority", "codex", "auditor", "deferred", "gpt-5.6-sol", "max",
        "routing-v5", "[]", "legacy-authority-session", "legacy-authority-lane", "audit", 1);
    const runs = new RunStore(path);
    expect(runs.claimNext({ workerId: "legacy", leaseMs: 10_000,
      now: Date.now() + 1_000 })).toBeUndefined();
    expect(() => store.barrier("legacy-authority")).toThrow(/exact .*auditor\/critic topology/i);
    expect(() => store.activateDeferred({ reviewId: "legacy-authority", agent: "codex",
      currentSourceFingerprint: sourceFingerprint, now: 2, providerHealth: health,
      harnessReady: true })).toThrow(/exact .*auditor\/critic topology/i);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_lane_attempts").pluck().get()).toBe(0);
    runs.close();
    db.close();
    store.close();
    health.close();
  });
  it("queues required Codex review lanes ahead of optional helpers", () => {
    const store = new RunGateUnitOfWork(database());
    createV3(store, { ...input, health: healthyReviewProviders });
    const priorities = store.enqueueDescriptors(input.reviewId).map((lane) => ({
      agent: lane.agent,
      priority: createReviewRunInput(lane).priority,
    }));
    expect(priorities.filter(({ agent }) => agent === "codex").every(({ priority }) => priority === 4)).toBe(true);
    expect(priorities.filter(({ agent }) => agent !== "codex").every(({ priority }) => priority === 20)).toBe(true);
    store.close();
  });

  it("satisfies the barrier with exact Codex quorum while optional providers are unavailable", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    completeLaneWithEvidence(path, store, "codex", "auditor");
    completeLaneWithEvidence(path, store, "codex", "critic");
    expect(store.barrier(input.reviewId)).toEqual({ satisfied: true, terminalCount: 2, requiredCount: 2 });
    store.close();
  });

  it.each(["unavailable", "probing"] as const)(
    "keeps %s Codex as durable deferred demand after every helper passes", (codexHealth) => {
      const path = database();
      const store = new RunGateUnitOfWork(path);
      createV3(store, { ...input,
        health: { grok: "healthy", claude: "healthy", codex: codexHealth } });
      for (const agent of ["grok", "claude"] as const) {
        for (const role of ["auditor", "critic"] as const) {
          completeLaneWithEvidence(path, store, agent, role);
        }
      }
      expect(store.deferredReviewIds("codex")).toEqual([input.reviewId]);
      expect(store.get(input.reviewId)?.lanes.filter(({ agent }) => agent === "codex"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "auditor", status: "deferred", attempts: [] }),
          expect.objectContaining({ role: "critic", status: "deferred", attempts: [] }),
        ]));
      expect(store.barrier(input.reviewId).satisfied).toBe(false);
      store.close();
    });

  it("rejects a disabled mandatory Codex provider before persisting review work", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    expect(() => createV3(store, { ...input,
      health: { grok: "healthy", claude: "healthy", codex: "disabled" } }))
      .toThrow(/mandatory Codex auditor\/critic pair is disabled/i);
    expect(store.get(input.reviewId)).toBeNull();
    const runs = new RunStore(path);
    expect(runs.list()).toEqual([]);
    runs.close();
    store.close();
  });

  it("keeps the barrier open while an optional helper attempt is scheduled", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "healthy", claude: "disabled", codex: "healthy" } });
    completeLaneWithEvidence(path, store, "codex", "auditor");
    completeLaneWithEvidence(path, store, "codex", "critic");
    expect(store.get(input.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
      .every((lane) => lane.status === "queued")).toBe(true);
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 2,
      requiredCount: 2,
    });
    store.close();
  });

  it.each(["task_failure", "invalid_request", "safety_denial", "permission_denial", "user_cancelled"] as const)(
    "keeps the Codex barrier closed for optional adverse outcome %s", (outcome) => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });

    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const activated = activateV3(store, {
      reviewId: input.reviewId,
      agent: "grok",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_001,
      providerHealth: health,
      harnessReady: true,
    });
    const lane = activated.lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "optional-failure", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    expect(claimed.idempotencyKey).toBe(lane.idempotencyKey);
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, { phase: "started", pid: 1234 });
    const failure = { kind: outcome, agent: "grok" };
    runs.commitDomainEffect({
      id: claimed.id,
      token: claimed.leaseToken!,
      providerResult: failure,
      effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
        role: lane.role, agent: "grok", resultKind: outcome, terminalAt: 2_001 },
      status: "failed",
    });
    store.recordTerminal({ reviewId: input.reviewId, agent: "grok", role: lane.role,
      attemptId: lane.attemptId, status: "failed", error: failure, terminalAt: 2_001 });
    activateAndCompleteCodex(path, store, health, 3_001);

    expect(store.barrier(input.reviewId)).toEqual({ satisfied: false, terminalCount: 2, requiredCount: 2 });
    runs.close();
    health.close();
    store.close();
  });

  it("blocks the Codex barrier while an optional launched attempt needs reconciliation", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });

    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const lane = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "optional-reconciliation", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    expect(claimed.idempotencyKey).toBe(lane.idempotencyKey);
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markNeedsReconciliation(claimed.id, claimed.leaseToken!, { kind: "ambiguous" });
    activateAndCompleteCodex(path, store, health, 3_001);

    expect(store.barrier(input.reviewId)).toEqual({ satisfied: false, terminalCount: 2, requiredCount: 2 });
    runs.close();
    health.close();
    store.close();
  });

  it("blocks when an optional run completed before its lane effect was replayed", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const lane = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "optional-crash-window", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, { phase: "started", pid: 1234 });
    const result = { ...changesResult(), agent: "grok" };
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: result,
      effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
        role: lane.role, agent: "grok", resultKind: "success", terminalAt: 2_001 },
      status: "completed" });
    activateAndCompleteCodex(path, store, health, 3_001);

    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    runs.close(); health.close(); store.close();
  });

  it("blocks an optional malformed success that was classified as failed", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const lane = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "optional-malformed", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, { phase: "started", pid: 1234 });
    const failure = { kind: "task_failure", agent: "grok", reviewOutputInvalid: true };
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: failure,
      effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
        role: lane.role, agent: "grok", resultKind: "task_failure", terminalAt: 2_001 },
      status: "failed" });
    store.recordTerminal({ reviewId: input.reviewId, agent: "grok", role: lane.role,
      attemptId: lane.attemptId, status: "failed", error: failure, terminalAt: 2_001 });
    activateAndCompleteCodex(path, store, health, 3_001);

    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    runs.close(); health.close(); store.close();
  });

  it("keeps an exactly persisted optional timeout non-blocking after the Codex quorum passes", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const activated = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes;
    const runs = new RunStore(path);
    const optionalRunIds: string[] = [];
    for (const [index, lane] of activated.entries()) {
      prioritizeRun(path, lane.idempotencyKey);
      const claimed = runs.claimNext({ workerId: "optional-timeout", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      optionalRunIds.push(claimed.id);
      runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
      runs.markLaunched(claimed.id, claimed.leaseToken!, {
        phase: "started", pid: 1234 + index, agent: "grok", model: lane.model,
        effort: lane.effort, policyVersion: lane.policyVersion, sessionId: lane.sessionId,
      });
      const timeout = { kind: "network_timeout", agent: "grok" };
      runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: timeout,
        effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
          role: lane.role, agent: "grok", resultKind: "network_timeout", terminalAt: 2_001 + index },
        status: "completed" });
      store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "grok", role: lane.role,
        attemptId: lane.attemptId, error: timeout, terminalAt: 2_001 + index });
    }
    activateAndCompleteCodex(path, store, health, 3_001);

    expect(store.get(input.reviewId)?.lanes.map((candidate) => ({
      lane: `${candidate.agent}:${candidate.role}`,
      status: candidate.status,
      attemptStatus: candidate.attempts.at(-1)?.status ?? null,
    }))).toEqual([
      { lane: "grok:auditor", status: "deferred", attemptStatus: "provider_unavailable" },
      { lane: "grok:critic", status: "deferred", attemptStatus: "provider_unavailable" },
      { lane: "claude:auditor", status: "deferred", attemptStatus: null },
      { lane: "claude:critic", status: "deferred", attemptStatus: null },
      { lane: "codex:auditor", status: "completed", attemptStatus: "completed" },
      { lane: "codex:critic", status: "completed", attemptStatus: "completed" },
    ]);

    expect(store.barrier(input.reviewId)).toEqual({ satisfied: true, terminalCount: 2, requiredCount: 2 });
    const sqlite = new Database(path);
    const original = sqlite.prepare(`SELECT status,payload,launch_info,result FROM runs WHERE id=?`)
      .get(optionalRunIds[0]) as { status: string; payload: string; launch_info: string; result: string };
    for (const field of [
      "payload", "launchSession", "reviewId", "attemptId", "role", "agent",
      "resultKind", "terminalAt", "providerResult", "domainEffect", "runStatus",
    ] as const) {
      const payload = JSON.parse(original.payload) as Record<string, unknown>;
      const launch = JSON.parse(original.launch_info) as Record<string, unknown>;
      const envelope = JSON.parse(original.result) as {
        domainEffect: string;
        providerResult: Record<string, unknown>;
        effect: Record<string, unknown>;
      };
      let status = original.status;
      if (field === "payload") payload.prompt = `${String(payload.prompt)}\nforged`;
      if (field === "launchSession") launch.sessionId = "forged-session";
      if (field === "reviewId") envelope.effect.reviewId = `${input.reviewId}:forged`;
      if (field === "attemptId") envelope.effect.attemptId = "123e4567-e89b-42d3-a456-426614174999";
      if (field === "role") envelope.effect.role = "critic";
      if (field === "agent") envelope.effect.agent = "claude";
      if (field === "resultKind") envelope.effect.resultKind = "quota";
      if (field === "terminalAt") envelope.effect.terminalAt = Number(envelope.effect.terminalAt) + 1;
      if (field === "providerResult") envelope.providerResult.kind = "quota";
      if (field === "domainEffect") envelope.domainEffect = "quarantined";
      if (field === "runStatus") status = "failed";
      sqlite.prepare(`UPDATE runs SET status=?,payload=?,launch_info=?,result=? WHERE id=?`).run(
        status, JSON.stringify(payload), JSON.stringify(launch), JSON.stringify(envelope), optionalRunIds[0],
      );
      expect.soft(store.barrier(input.reviewId), field).toEqual({
        satisfied: false, terminalCount: 2, requiredCount: 2,
      });
      sqlite.prepare(`UPDATE runs SET status=?,payload=?,launch_info=?,result=? WHERE id=?`).run(
        original.status, original.payload, original.launch_info, original.result, optionalRunIds[0],
      );
      expect.soft(store.barrier(input.reviewId), `${field}:restored`).toEqual({
        satisfied: true, terminalCount: 2, requiredCount: 2,
      });
    }
    sqlite.close();
    runs.close(); health.close(); store.close();
  }, 30_000);

  it("binds accepted optional evidence independently across lane, attempt, and run identity", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const activated = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes;
    const runs = new RunStore(path);
    const optionalRunIds: string[] = [];
    for (const [index, lane] of activated.entries()) {
      prioritizeRun(path, lane.idempotencyKey);
      const claimed = runs.claimNext({ workerId: "optional-identity", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      optionalRunIds.push(claimed.id);
      runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
      runs.markLaunched(claimed.id, claimed.leaseToken!, {
        phase: "started", pid: 2234 + index, agent: "grok", model: lane.model,
        effort: lane.effort, policyVersion: lane.policyVersion, sessionId: lane.sessionId,
      });
      const unavailable = { kind: "network_timeout", agent: "grok" };
      runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: unavailable,
        effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
          role: lane.role, agent: "grok", resultKind: "network_timeout", terminalAt: 2_101 + index },
        status: "completed" });
      store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "grok", role: lane.role,
        attemptId: lane.attemptId, error: unavailable, terminalAt: 2_101 + index });
    }
    activateAndCompleteCodex(path, store, health, 3_101);
    expect(store.barrier(input.reviewId).satisfied).toBe(true);

    const sqlite = new Database(path);
    const originalRun = sqlite.prepare("SELECT payload,launch_info FROM runs WHERE id=?")
      .get(optionalRunIds[0]) as { payload: string; launch_info: string };
    const originalLane = sqlite.prepare(`SELECT model,effort,reasons,session_id,idempotency_key
      FROM runtime_review_lanes WHERE review_id=? AND agent='grok' AND role='auditor'`)
      .get(input.reviewId) as {
        model: string; effort: string; reasons: string; session_id: string; idempotency_key: string;
      };
    for (const [field, value] of [
      ["effort", originalLane.effort === "high" ? "xhigh" : "high"],
      ["reasons", JSON.stringify(["forged_lane_reason"])],
      ["session_id", "forged-lane-session"],
      ["idempotency_key", `${originalLane.idempotency_key}:forged`],
    ] as const) {
      sqlite.prepare(`UPDATE runtime_review_lanes SET ${field}=?
        WHERE review_id=? AND agent='grok' AND role='auditor'`).run(value, input.reviewId);
      expect.soft(store.barrier(input.reviewId), `lane:${field}`).toEqual({
        satisfied: false, terminalCount: 2, requiredCount: 2,
      });
      sqlite.prepare(`UPDATE runtime_review_lanes SET model=?,effort=?,reasons=?,session_id=?,idempotency_key=?
        WHERE review_id=? AND agent='grok' AND role='auditor'`).run(
        originalLane.model, originalLane.effort, originalLane.reasons,
        originalLane.session_id, originalLane.idempotency_key, input.reviewId,
      );
    }
    const coordinatedPayload = JSON.parse(originalRun.payload) as Record<string, unknown>;
    const coordinatedLaunch = JSON.parse(originalRun.launch_info) as Record<string, unknown>;
    const coordinatedEffort = originalLane.effort === "high" ? "xhigh" : "high";
    (coordinatedPayload.decision as Record<string, unknown>).effort = coordinatedEffort;
    (coordinatedPayload.reviewDispatchIdentity as Record<string, unknown>).effort = coordinatedEffort;
    coordinatedLaunch.effort = coordinatedEffort;
    sqlite.prepare("UPDATE runs SET payload=?,launch_info=? WHERE id=?").run(
      JSON.stringify(coordinatedPayload), JSON.stringify(coordinatedLaunch), optionalRunIds[0],
    );
    expect.soft(store.barrier(input.reviewId), "coordinated-run-identity").toEqual({
      satisfied: false, terminalCount: 2, requiredCount: 2,
    });
    sqlite.close(); runs.close(); health.close(); store.close();
  }, 15_000);

  it("keeps exact optional prelaunch cli_missing evidence non-blocking and rejects ambiguous substitutes", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const activated = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes;
    const runs = new RunStore(path);
    const optionalRunIds: string[] = [];
    for (const [index, lane] of activated.entries()) {
      prioritizeRun(path, lane.idempotencyKey);
      const claimed = runs.claimNext({ workerId: "optional-prelaunch", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      optionalRunIds.push(claimed.id);
      runs.markLaunchIntent(claimed.id, claimed.leaseToken!, {
        agent: "grok", model: lane.model, effort: lane.effort,
        policyVersion: lane.policyVersion, sessionId: lane.sessionId,
      });
      runs.clearLaunchIntent(claimed.id, claimed.leaseToken!);
      const unavailable = { kind: "cli_missing", agent: "grok" };
      runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: unavailable,
        effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
          role: lane.role, agent: "grok", resultKind: "cli_missing", terminalAt: 2_001 + index },
        status: "completed" });
      store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "grok", role: lane.role,
        attemptId: lane.attemptId, error: unavailable, terminalAt: 2_001 + index });
    }
    activateAndCompleteCodex(path, store, health, 3_001);
    expect(store.barrier(input.reviewId)).toEqual({ satisfied: true, terminalCount: 2, requiredCount: 2 });

    const sqlite = new Database(path);
    const original = sqlite.prepare("SELECT launched,launch_info FROM runs WHERE id=?")
      .get(optionalRunIds[0]) as { launched: number; launch_info: string };
    const launch = JSON.parse(original.launch_info) as Record<string, unknown>;
    for (const mutation of [
      { launched: 1, launch: { ...launch } },
      { launched: 0, launch: { ...launch, phase: "launching" } },
      { launched: 0, launch: { ...launch, sessionId: "forged-session" } },
      { launched: 0, launch: null },
    ]) {
      sqlite.prepare("UPDATE runs SET launched=?,launch_info=? WHERE id=?").run(
        mutation.launched, mutation.launch === null ? null : JSON.stringify(mutation.launch), optionalRunIds[0],
      );
      expect.soft(store.barrier(input.reviewId), JSON.stringify(mutation)).toEqual({
        satisfied: false, terminalCount: 2, requiredCount: 2,
      });
      sqlite.prepare("UPDATE runs SET launched=?,launch_info=? WHERE id=?").run(
        original.launched, original.launch_info, optionalRunIds[0],
      );
    }
    sqlite.close(); runs.close(); health.close(); store.close();
  });

  it("does not launder a non-cli failover through proven-no-spawn evidence", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const lane = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "optional-prelaunch-quota", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, {
      agent: "grok", model: lane.model, effort: lane.effort,
      policyVersion: lane.policyVersion, sessionId: lane.sessionId,
    });
    runs.clearLaunchIntent(claimed.id, claimed.leaseToken!);
    const quota = { kind: "quota", agent: "grok" };
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: quota,
      effect: { type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
        role: lane.role, agent: "grok", resultKind: "quota", terminalAt: 2_001 },
      status: "completed" });

    expect(() => store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "grok",
      role: lane.role, attemptId: lane.attemptId, error: quota, terminalAt: 2_001 }))
      .toThrow(/exact durable run evidence/i);
    runs.close(); health.close(); store.close();
  });

  it.each([
    "reviewId",
    "attemptId",
    "role",
    "agent",
    "resultKind",
    "terminalAt",
    "payload",
  ] as const)("rejects optional timeout evidence with mismatched %s", (field) => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "unavailable", claude: "disabled", codex: "healthy" } });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1_000);
    const lane = activateV3(store, { reviewId: input.reviewId, agent: "grok",
      currentSourceFingerprint: sourceFingerprint, now: 1_001, providerHealth: health,
      harnessReady: true }).lanes[0]!;
    const runs = new RunStore(path);
    prioritizeRun(path, lane.idempotencyKey);
    const claimed = runs.claimNext({ workerId: `timeout-mismatch-${field}`, leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, {
      phase: "started", pid: 1234, agent: "grok", model: lane.model,
      effort: lane.effort, policyVersion: lane.policyVersion, sessionId: lane.sessionId,
    });
    if (field === "payload") {
      const sqlite = new Database(path);
      const row = sqlite.prepare("SELECT payload FROM runs WHERE id=?").get(claimed.id) as { payload: string };
      const payload = JSON.parse(row.payload); payload.prompt = `${payload.prompt}\nforged`;
      sqlite.prepare("UPDATE runs SET payload=? WHERE id=?").run(JSON.stringify(payload), claimed.id);
      sqlite.close();
    }
    const timeout = { kind: "network_timeout", agent: "grok" };
    const effect = {
      type: "review", reviewId: input.reviewId, attemptId: lane.attemptId,
      role: lane.role, agent: "grok", resultKind: "network_timeout", terminalAt: 2_001,
    } as Record<string, unknown>;
    if (field === "reviewId") effect.reviewId = `${input.reviewId}:forged`;
    if (field === "attemptId") effect.attemptId = "123e4567-e89b-42d3-a456-426614174999";
    if (field === "role") effect.role = lane.role === "auditor" ? "critic" : "auditor";
    if (field === "agent") effect.agent = "claude";
    if (field === "resultKind") effect.resultKind = "model_unavailable";
    if (field === "terminalAt") effect.terminalAt = 2_002;
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: timeout,
      effect, status: "completed" });

    expect(() => store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "grok",
      role: lane.role, attemptId: lane.attemptId, error: timeout, terminalAt: 2_001 }))
      .toThrow(/exact durable run evidence/i);

    runs.close(); health.close(); store.close();
  });
  it("rejects v1 review tables instead of mutating them in the constructor", () => {
    const path = rawDatabase();
    const db = new Database(path);
    db.exec(`CREATE TABLE runtime_review_barriers (
      review_id TEXT PRIMARY KEY,
      stage_id TEXT NOT NULL,
      artifact BLOB NOT NULL,
      artifact_hash TEXT NOT NULL,
      approval_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      requester TEXT CHECK (requester IS NULL OR requester IN ('claude', 'codex'))
    )`);
    db.close();

    expect(() => new RunGateUnitOfWork(path)).toThrow(/current routing-v5 schema/i);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_review_lanes'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("rejects a routing-v2 review database without mutating schema or rows", () => {
    const path = database();
    const source = new RunGateUnitOfWork(path);
    createV3(source, { ...input, health: healthyReviewProviders });
    source.close();

    const schema = new Database(path);
    schema.unsafeMode(true);
    schema.pragma("writable_schema = ON");
    schema.prepare(`
      UPDATE sqlite_master
         SET sql = replace(sql, 'policy_version = ''routing-v5''',
                                'policy_version = ''routing-v2''')
       WHERE type = 'table'
         AND name IN ('runtime_review_lanes', 'runtime_review_lane_attempts')
    `).run();
    const schemaVersion = schema.pragma("schema_version", { simple: true }) as number;
    schema.pragma(`schema_version = ${schemaVersion + 1}`);
    schema.pragma("writable_schema = OFF");
    schema.unsafeMode(false);
    schema.close();

    const legacy = new Database(path);
    legacy.prepare("UPDATE runtime_review_lanes SET policy_version = 'routing-v2'").run();
    legacy.close();

    const before = new Database(path, { readonly: true });
    const schemaBefore = before.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const lanesBefore = before.prepare("SELECT * FROM runtime_review_lanes ORDER BY agent,role").all();
    before.close();

    expect(() => new RunGateUnitOfWork(path)).toThrow(/current routing-v5 schema/i);

    const verified = new Database(path, { readonly: true });
    expect(verified.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
    expect(verified.prepare("SELECT * FROM runtime_review_lanes ORDER BY agent,role").all()).toEqual(lanesBefore);
    const tableSql = (verified.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_review_lanes'
    `).get() as { sql: string }).sql;
    expect(tableSql).toContain("'routing-v2'");
    expect(tableSql).not.toContain("'routing-v5'");
    verified.close();
  });

  it("rolls back a corrupt routing-v2 migration and rejects every reopen", () => {
    const path = database();
    const source = new RunGateUnitOfWork(path);
    createV3(source, { ...input, health: healthyReviewProviders });
    source.close();

    const schema = new Database(path);
    schema.unsafeMode(true);
    schema.pragma("writable_schema = ON");
    schema.prepare(`
      UPDATE sqlite_master
         SET sql = replace(sql, 'policy_version = ''routing-v5''',
                                'policy_version = ''routing-v2''')
       WHERE type = 'table'
         AND name IN ('runtime_review_lanes', 'runtime_review_lane_attempts')
    `).run();
    const schemaVersion = schema.pragma("schema_version", { simple: true }) as number;
    schema.pragma(`schema_version = ${schemaVersion + 1}`);
    schema.pragma("writable_schema = OFF");
    schema.unsafeMode(false);
    schema.close();

    const corrupt = new Database(path);
    corrupt.pragma("foreign_keys = OFF");
    corrupt.prepare("UPDATE runtime_review_lanes SET policy_version = 'routing-v2'").run();
    corrupt.prepare("DELETE FROM runtime_review_barriers WHERE review_id = ?").run(input.reviewId);
    corrupt.close();

    expect(() => new RunGateUnitOfWork(path)).toThrow(/foreign key|integrity/i);
    expect(() => new RunGateUnitOfWork(path)).toThrow(/foreign key|integrity/i);

    const unchanged = new Database(path, { readonly: true });
    const tableSql = (unchanged.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_review_lanes'
    `).get() as { sql: string }).sql;
    expect(tableSql).toContain("'routing-v2'");
    expect(tableSql).not.toContain("'routing-v3'");
    unchanged.close();
  });

  it("persists exact six full-review lanes over copied bytes and exposes enqueue descriptors", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    const source = Buffer.from(artifact);
    const review = createV3(store, {
      ...input,
      artifact: source,
      health: healthyReviewProviders,
    });
    source.fill(0);

    expect(review.runState).toBe("FULL_CROSS_PROVIDER");
    expect(review.artifactHash).toBe(artifactHash);
    expect(review.artifact).toEqual(artifact);
    expect(review.lanes).toHaveLength(6);
    expect(review.lanes.map((lane) => `${lane.agent}:${lane.role}:${lane.status}`)).toEqual([
      "grok:auditor:queued",
      "grok:critic:queued",
      "claude:auditor:queued",
      "claude:critic:queued",
      "codex:auditor:queued",
      "codex:critic:queued",
    ]);

    const descriptors = store.enqueueDescriptors(input.reviewId);
    expect(descriptors).toHaveLength(6);
    expect(new Set(descriptors.map((lane) => lane.sessionId)).size).toBe(6);
    expect(new Set(descriptors.map((lane) => lane.idempotencyKey)).size).toBe(6);
    expect(descriptors.every((lane) => lane.artifactHash === artifactHash)).toBe(true);
    expect(descriptors.every((lane) => lane.artifact.equals(artifact))).toBe(true);
    expect(descriptors.map(({ agent, role, model, effort, policyVersion, reasons }) => ({
      agent, role, model, effort, policyVersion, reasons,
    }))).toEqual([
      { agent: "grok", role: "auditor", model: "grok-4.6", effort: "high", policyVersion: "routing-v5", reasons: ["stage_baseline:code_audit:high"] },
      { agent: "grok", role: "critic", model: "grok-4.6", effort: "xhigh", policyVersion: "routing-v5", reasons: ["stage_baseline:code_critic:xhigh"] },
      { agent: "claude", role: "auditor", model: "glm-5.3", effort: "high", policyVersion: "routing-v5", reasons: ["stage_baseline:code_audit:high"] },
      { agent: "claude", role: "critic", model: "glm-5.3", effort: "xhigh", policyVersion: "routing-v5", reasons: ["stage_baseline:code_critic:xhigh"] },
      { agent: "codex", role: "auditor", model: "gpt-5.6-sol", effort: "high", policyVersion: "routing-v5", reasons: ["stage_baseline:code_audit:high"] },
      { agent: "codex", role: "critic", model: "gpt-5.6-sol", effort: "xhigh", policyVersion: "routing-v5", reasons: ["stage_baseline:code_critic:xhigh"] },
    ]);
    descriptors[0]!.artifact.fill(1);
    expect(store.enqueueDescriptors(input.reviewId)[0]!.artifact).toEqual(artifact);
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 0,
      requiredCount: 2,
    });
    const runs = new RunStore(path);
    expect(runs.list()).toHaveLength(6);
    runs.close();
    store.close();
  });

  it("is idempotent across reopen but rejects a conflicting immutable artifact", () => {
    const path = database();
    const first = new RunGateUnitOfWork(path);
    const created = createV3(first, {
      ...input,
      health: healthyReviewProviders,
    });
    first.close();

    const reopened = new RunGateUnitOfWork(path);
    const same = createV3(reopened, {
      ...input,
      artifact: Buffer.from(artifact),
      health: { ...healthyReviewProviders, grok: "unavailable" },
    });
    expect(same).toEqual(created);
    expect(() =>
      createV3(reopened, {
        ...input,
        artifact: Buffer.from("changed bytes"),
        health: healthyReviewProviders,
      }),
    ).toThrow(/immutable review conflict/i);
    reopened.close();
  });

  it.each([
    "grok:auditor",
    "grok:critic",
    "claude:auditor",
    "claude:critic",
    "codex:auditor",
    "codex:critic",
  ])("rolls back the full gate when atomic run creation fails at %s", (lane) => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    const injection = new Database(path);
    injection.exec(`CREATE TRIGGER inject_review_run_failure
      BEFORE INSERT ON runs
      WHEN NEW.idempotency_key LIKE '%:${lane}'
      BEGIN SELECT RAISE(ABORT, 'injected review run failure'); END`);
    injection.close();

    expect(() => createV3(store, {
      ...input,
      health: healthyReviewProviders,
    })).toThrow(/injected review run failure/i);
    const evidence = new Database(path, { readonly: true });
    for (const table of [
      "runtime_review_barriers",
      "runtime_review_lanes",
      "runtime_review_lane_attempts",
      "runs",
    ]) {
      expect(evidence.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    evidence.close();
    store.close();
  });

  it("records terminality without treating failures or change requests as semantic PASS", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: healthyReviewProviders });

    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "grok",
      role: "auditor",
      attemptId: attemptIdFor(store, "grok", "auditor"),
      status: "completed",
      result: passResult(),
      terminalAt: 200,
    });
    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "grok",
      role: "critic",
      attemptId: attemptIdFor(store, "grok", "critic"),
      status: "failed",
      error: { message: "critic failure" },
      terminalAt: 201,
    });
    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "claude",
      role: "auditor",
      attemptId: attemptIdFor(store, "claude", "auditor"),
      status: "completed",
      result: passResult(),
      terminalAt: 202,
    });
    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "claude",
      role: "critic",
      attemptId: attemptIdFor(store, "claude", "critic"),
      status: "completed",
      result: passResult(),
      terminalAt: 202,
    });
    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "codex",
      role: "auditor",
      attemptId: attemptIdFor(store, "codex", "auditor"),
      status: "timed_out",
      error: { code: "ETIMEDOUT" },
      terminalAt: 202,
    });
    expect(store.barrier(input.reviewId).satisfied).toBe(false);

    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "codex",
      role: "critic",
      attemptId: attemptIdFor(store, "codex", "critic"),
      status: "completed",
      result: changesResult(),
      terminalAt: 203,
    });
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 2,
      requiredCount: 2,
    });
    store.close();

    const reopened = new RunGateUnitOfWork(path);
    expect(reopened.get(input.reviewId)?.lanes.map(({ status }) => status).sort()).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "failed",
      "timed_out",
    ]);
    expect(reopened.get(input.reviewId)?.lanes.find(
      ({ agent, role }) => agent === "claude" && role === "critic",
    )?.result).toEqual(passResult());
    expect(reopened.barrier(input.reviewId).satisfied).toBe(false);
    expect(reopened.recordTerminal({
      reviewId: input.reviewId,
      agent: "codex",
      role: "critic",
      attemptId: attemptIdFor(reopened, "codex", "critic"),
      status: "completed",
      result: changesResult(),
      terminalAt: 203,
    }).status).toBe("completed");
    expect(() => reopened.recordTerminal({
      reviewId: input.reviewId,
      agent: "codex",
      role: "critic",
      attemptId: attemptIdFor(reopened, "codex", "critic"),
      status: "failed",
      terminalAt: 204,
    })).toThrow(/terminal state conflict/i);
    reopened.close();
  });

  it.each([
    ["request_changes", "completed", changesResult()],
    ["inconclusive", "completed", inconclusiveResult()],
    ["warning_pass", "completed", warningPassResult()],
    ["malformed_success", "completed", malformedSuccessResult()],
    ["failed", "failed", undefined],
    ["timed_out", "timed_out", undefined],
  ] as const)("keeps one isolated %s lane from satisfying the semantic barrier", (_case, blockedStatus, blockedResult) => {
    const store = new RunGateUnitOfWork(database());
    createV3(store, { ...input, health: healthyReviewProviders });
    const blockedAgent = "grok" as const;
    const blockedRole = "auditor" as const;
    for (const agent of ["codex", "grok", "claude"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        const blocked = agent === blockedAgent && role === blockedRole;
        store.recordTerminal({
          reviewId: input.reviewId,
          agent,
          role,
          attemptId: attemptIdFor(store, agent, role),
          status: blocked ? blockedStatus : "completed",
          ...(blockedResult === undefined ? {} : { result: blockedResult }),
          ...(!blocked && { result: passResult() }),
          terminalAt: 310,
        });
      }
    }
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 2,
      requiredCount: 2,
    });
    store.close();
  });

  it("opens the semantic barrier when the Codex quorum and all completed optional lanes PASS", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: healthyReviewProviders });
    for (const agent of ["codex", "grok", "claude"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        completeLaneWithEvidence(path, store, agent, role);
      }
    }
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: true,
      terminalCount: 2,
      requiredCount: 2,
    });
    store.close();
  });

  it("rejects completed runner rows whose payload is not the exact canonical review packet", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: healthyReviewProviders });
    for (const agent of ["codex", "grok", "claude"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        completeLaneWithEvidence(path, store, agent, role);
      }
    }
    expect(store.barrier(input.reviewId).satisfied).toBe(true);
    const tamper = new Database(path);
    tamper.prepare(`UPDATE runs
      SET payload=json_remove(payload, '$.prompt')
      WHERE idempotency_key=(SELECT idempotency_key FROM runtime_review_lanes
        WHERE review_id=? AND agent='grok' AND role='auditor')`).run(input.reviewId);
    tamper.close();
    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    store.close();
  });

  it("keeps exact launched runner evidence blocked when its semantic verdict requests changes", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: healthyReviewProviders });
    for (const agent of ["codex", "grok", "claude"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        completeLaneWithEvidence(
          path,
          store,
          agent,
          role,
          agent === "grok" && role === "auditor" ? "changes" : "pass",
        );
      }
    }
    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    store.close();
  });

  it("creates four active and two deferred lanes, activating Claude only after provider cooldown", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.acquireExplicitProbeAdmission("claude", 0)).toEqual({ runnable: true, claimedAt: 0 });
    health.recordFailoverFailure("claude", { kind: "quota" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);

    const store = new RunGateUnitOfWork(path);
    const project = process.cwd();
    const sourceFingerprint = captureWorkspaceFingerprint(project).fingerprint;
    const review = createV3(store, {
      ...input,
      health: { ...healthyReviewProviders, claude: "unavailable" },
      project,
      requester: "codex",
      sourceFingerprint,
    });
    expect(review.runState).toBe("DEGRADED_REVIEW_SET");
    expect(review.lanes.map((lane) => `${lane.agent}:${lane.role}:${lane.status}`)).toEqual([
      "grok:auditor:queued",
      "grok:critic:queued",
      "claude:auditor:deferred",
      "claude:critic:deferred",
      "codex:auditor:queued",
      "codex:critic:queued",
    ]);
    expect(store.enqueueDescriptors(input.reviewId).map((lane) => lane.agent)).toEqual([
      "grok",
      "grok",
      "codex",
      "codex",
    ]);
    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    const competing = new RunGateUnitOfWork(path);

    expect(activateV3(store, {
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_099,
      providerHealth: health,
      harnessReady: true,
    })).toEqual({ status: "provider_unavailable", lanes: [] });
    expect(health.acquireExplicitProbeAdmission("claude", 1_100)).toEqual({
      runnable: true, claimedAt: 1_100,
    });
    health.recordSuccess("claude", 1_101, 1_100);
    const activated = activateV3(store, {
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_102,
      providerHealth: health,
      harnessReady: true,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes.map((lane) => `${lane.agent}:${lane.role}`)).toEqual([
      "claude:auditor",
      "claude:critic",
    ]);
    for (const lane of activated.lanes) {
      const run = createReviewRunInput(lane);
      expect(run.payload.mapLearning.consumer).toBe("claude");
      const context = formatMapLearningLaunchBindingContext(run.payload.mapLearning);
      expect(run.payload.prompt.split(context)).toHaveLength(2);
    }
    expect(health.get("claude").attemptClaimed).toBe(false);
    expect(activateV3(competing, { reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: sourceFingerprint, now: 1_102, providerHealth: health,
      harnessReady: true }).status).toBe("none");
    expect(store.enqueueDescriptors(input.reviewId).filter((lane) => lane.agent === "claude")).toHaveLength(2);
    expect(activateV3(store, {
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
      harnessReady: true,
    })).toEqual({ status: "none", lanes: [] });

    store.close();
    competing.close();
    health.close();
  });

  it("atomically refuses recovered helper activation after the Codex barrier is satisfied", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 1);
    health.recordSuccess("claude", 1);
    const store = new RunGateUnitOfWork(path);
    createV3(store, {
      ...input,
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
    });
    completeLaneWithEvidence(path, store, "codex", "auditor");
    completeLaneWithEvidence(path, store, "codex", "critic");
    expect(store.barrier(input.reviewId).satisfied).toBe(true);

    const competing = new RunGateUnitOfWork(path);
    for (const actor of [store, competing]) {
      expect(activateV3(actor, {
        reviewId: input.reviewId,
        agent: "claude",
        currentSourceFingerprint: sourceFingerprint,
        now: 2,
        providerHealth: health,
        harnessReady: true,
      })).toEqual({ status: "satisfied", lanes: [] });
    }
    expect(store.get(input.reviewId)?.lanes.filter((lane) => lane.agent === "claude")
      .every((lane) => lane.status === "deferred")).toBe(true);

    competing.close();
    store.close();
    health.close();
  });

  it("preserves both failed review attempts and reactivates the pair atomically", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("claude", 1);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: {
      grok: "unavailable", claude: "healthy", codex: "healthy",
    } });
    const initial = failReviewPairWithEvidence(path, store, "claude", 100, "quota");
    for (const lane of initial) {
      const persisted = store.get(input.reviewId)!.lanes.find(({ agent, role }) =>
        agent === "claude" && role === lane.role)!;
      expect(persisted).toMatchObject({ status: "deferred", attempts: [expect.objectContaining({
        attemptId: lane.attempts[0]!.attemptId, attemptOrdinal: 0,
        status: "provider_unavailable", effort: lane.attempts[0]!.effort,
        reasons: lane.attempts[0]!.reasons,
      })] });
    }
    health.recordFailoverFailure("claude", { kind: "quota" }, 100);

    const activated = activateV3(store, {
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
      harnessReady: true,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes).toHaveLength(2);
    expect(activated.lanes.map(({ role }) => role).sort()).toEqual(["auditor", "critic"]);
    expect(activated.lanes.every(({ attemptOrdinal, previousOrdinal }) =>
      attemptOrdinal === 1 && previousOrdinal === 0)).toBe(true);
    for (const role of ["auditor", "critic"] as const) {
      expect(store.attempts(input.reviewId, "claude", role).map(({ attemptOrdinal, status }) =>
        ({ attemptOrdinal, status }))).toEqual([
          { attemptOrdinal: 0, status: "provider_unavailable" },
          { attemptOrdinal: 1, status: "scheduled" },
        ]);
    }
    store.close();
    health.close();
  });

  it("activates against the immutable persisted artifact without a caller-supplied hash", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.acquireExplicitProbeAdmission("claude", 0)).toEqual({ runnable: true, claimedAt: 0 });
    health.recordFailoverFailure("claude", { kind: "model_unavailable" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { ...healthyReviewProviders, claude: "unavailable" } });
    expect(health.acquireExplicitProbeAdmission("claude", 1_100)).toEqual({
      runnable: true, claimedAt: 1_100,
    });
    health.recordSuccess("claude", 1_101, 1_100);

    const activated = activateV3(store, {
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_102,
      providerHealth: health,
      harnessReady: true,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes).toHaveLength(2);
    expect(store.get(input.reviewId)?.artifactHash).toBe(artifactHash);

    store.close();
    health.close();
  });

  it("makes a post-launch unknown attempt explicit and resolves it only by exact attempt id", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, health: { grok: "healthy", claude: "unavailable", codex: "healthy" } });
    const attemptId = attemptIdFor(store, "grok", "auditor");
    const runs = new RunStore(path);
    prioritizeRun(path, store.enqueueDescriptors(input.reviewId)
      .find((lane) => lane.agent === "grok" && lane.role === "auditor")!.idempotencyKey);
    const claimed = runs.claimNext({ workerId: "reconcile-test", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "grok" });
    runs.markNeedsReconciliation(claimed.id, claimed.leaseToken!, { kind: "ambiguous" });
    expect(store.attempts(input.reviewId, "grok", "auditor").at(-1)?.status)
      .toBe("needs_reconciliation");
    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    expect(() => store.recordTerminal({ reviewId: input.reviewId, agent: "grok",
      role: "auditor", attemptId: `${attemptId}:stale`, status: "completed",
      result: passResult(), terminalAt: 201 })).toThrow(/active attempt/i);
    runs.resolveReconciliation({ id: claimed.id, providerResult: passResult(),
      effect: { type: "review", reviewId: input.reviewId, attemptId, role: "auditor",
        agent: "grok", resultKind: "success", terminalAt: 202 }, status: "completed" });
    expect(store.recordTerminal({ reviewId: input.reviewId, agent: "grok",
      role: "auditor", attemptId, status: "completed", result: passResult(), terminalAt: 202 }).status)
      .toBe("completed");
    runs.close();
    store.close();
    health.close();
  });

  it("marks deferred lanes stale when the source workspace fingerprint changed", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.acquireExplicitProbeAdmission("claude", 0);
    health.recordFailoverFailure("claude", { kind: "quota" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, sourceFingerprint: "workspace-v1", health: { ...healthyReviewProviders, claude: "unavailable" } });
    expect(activateV3(store, { reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: "workspace-v2", now: 1_100, providerHealth: health,
      harnessReady: true })).toEqual({ status: "stale_artifact", lanes: [] });
    expect(health.get("claude").attemptClaimed).toBe(false);
    store.close(); health.close();
  });

  it("keeps an aligned unavailable helper non-blocking when source drift wins before Codex closure", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.acquireExplicitProbeAdmission("claude", 0);
    health.recordFailoverFailure("claude", { kind: "quota" }, 100, 0);
    const store = new RunGateUnitOfWork(path);
    createV3(store, { ...input, sourceFingerprint,
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" } });
    expect(health.acquireExplicitProbeAdmission("claude", 1_100)).toEqual({
      runnable: true, claimedAt: 1_100,
    });
    health.recordSuccess("claude", 1_101, 1_100);
    const activated = activateV3(store, { reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: sourceFingerprint, now: 1_102, providerHealth: health,
      harnessReady: true });
    expect(activated.lanes).toHaveLength(2);
    const failed = failReviewPairWithEvidence(path, store, "claude", 1_102, "model_unavailable");

    expect(activateV3(store, { reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: "workspace-v2", now: 1_103, providerHealth: health,
      harnessReady: true }))
      .toEqual({ status: "stale_artifact", lanes: [] });
    for (const lane of failed) {
      const unavailable = { kind: "model_unavailable", agent: "claude", role: lane.role };
      expect(store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "claude",
        role: lane.role, attemptId: lane.attempts.at(-1)!.attemptId,
        error: unavailable, terminalAt: 1_102 }))
        .toMatchObject({ status: "stale_artifact", error: unavailable, terminalAt: 1_102 });
      expect(() => store.recordProviderUnavailable({ reviewId: input.reviewId, agent: "claude",
        role: lane.role, attemptId: lane.attempts.at(-1)!.attemptId,
        error: unavailable, terminalAt: 1_104 })).toThrow(/exact durable run evidence/i);
    }
    activateAndCompleteCodex(path, store, health, 1_200);
    expect(store.get(input.reviewId)?.lanes.map((lane) => ({
      lane: `${lane.agent}:${lane.role}`,
      status: lane.status,
      attemptStatus: lane.attempts.at(-1)?.status ?? null,
    }))).toEqual([
      { lane: "grok:auditor", status: "deferred", attemptStatus: null },
      { lane: "grok:critic", status: "deferred", attemptStatus: null },
      { lane: "claude:auditor", status: "stale_artifact", attemptStatus: "provider_unavailable" },
      { lane: "claude:critic", status: "stale_artifact", attemptStatus: "provider_unavailable" },
      { lane: "codex:auditor", status: "completed", attemptStatus: "completed" },
      { lane: "codex:critic", status: "completed", attemptStatus: "completed" },
    ]);
    expect(store.barrier(input.reviewId).satisfied).toBe(true);

    store.close(); health.close();
  });

  it.each([false, undefined] as const)(
    "requires affirmative harness readiness at authoritative admission: %s",
    (harnessReady) => {
      const path = database();
      const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
      health.recordSuccess("grok", 100);
      const store = new RunGateUnitOfWork(path);
      createV3(store, { ...input, health: {
        grok: "unavailable", claude: "disabled", codex: "healthy",
      } });
      const admission = {
        reviewId: input.reviewId,
        agent: "grok" as const,
        currentSourceFingerprint: sourceFingerprint,
        now: 101,
        providerHealth: health,
        ...(harnessReady === undefined ? {} : { harnessReady }),
      } as unknown as Parameters<RunGateUnitOfWork["activateDeferred"]>[0];

      expect(activateV3(store, admission)).toEqual({
        status: "harness_unavailable", lanes: [],
      });
      expect(health.get("grok").attemptClaimed).toBe(false);
      expect(store.get(input.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
        .every((lane) => lane.status === "deferred")).toBe(true);
      store.close(); health.close();
    },
  );
});
