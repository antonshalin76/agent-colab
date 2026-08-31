import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import {
  RunGateUnitOfWork,
  type ReviewAdmissionReceiptPair,
} from "../src/runtime/run-gate-unit-of-work.js";
import * as reviewRuntime from "../src/runtime/run-gate-unit-of-work.js";
import { activateRecoveredReviewLanes } from "../src/runtime/review-rejoin.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];
const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("test evidence must be JSON");
  return encoded;
};
const canonicalHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-rejoin-v3-"));
  roots.push(root);
  return join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reviewInput = {
  reviewId: "rejoin-v3",
  stageId: "stage",
  artifact: Buffer.from("candidate"),
  health: { grok: "unavailable", claude: "unavailable", codex: "healthy" } as const,
  approvalScope: "workspace-read" as const,
  idempotencyKey: "rejoin-v3-key",
  prompts: { auditor: "audit", critic: "critic" },
  createdAt: 1,
  project: "/repo",
  requester: "codex" as const,
  sourceFingerprint: "source-v1",
  changedFiles: 1,
};

function appendPendingReceipt(db: Database.Database, input: {
  receiptId: string;
  scope: string;
  activationNonce: string;
  generation: number;
  observation: Record<string, unknown>;
  expectedTuple?: Record<string, unknown>;
  scopeRevision?: number;
  predecessorReceiptId?: string | null;
}): void {
  const scopeRevision = input.scopeRevision ?? 1;
  const predecessorReceiptId = input.predecessorReceiptId ?? null;
  const expectedTuple = canonicalJson(input.expectedTuple ?? {
    laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
  });
  const observation = canonicalJson(input.observation);
  const observationHash = createHash("sha256").update(observation).digest("hex");
  const envelope = canonicalJson({ receiptId: input.receiptId, phase: "admission", scope: input.scope,
    scopeRevision, activationNonce: input.activationNonce, expectedTuple,
    recoveryGeneration: input.generation, observationHash, predecessorReceiptId });
  db.prepare(`INSERT INTO runtime_review_receipts
    (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
     recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
     canonical_bytes,envelope_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.receiptId, "admission", input.scope, scopeRevision, input.activationNonce, expectedTuple,
    input.generation, observation, observationHash, predecessorReceiptId, envelope,
    createHash("sha256").update(envelope).digest("hex"), 102,
  );
  db.prepare(`INSERT INTO runtime_review_receipt_heads
    (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,?,?)`)
    .run(input.scope, input.receiptId, scopeRevision, input.activationNonce);
}

function createWithAdmission(path: string, reviews: RunGateUnitOfWork, input: typeof reviewInput): void {
  const admissionReceipts: ReviewAdmissionReceiptPair[] = [];
  for (const role of ["auditor", "critic"] as const) {
    const activationNonce = `initial/${input.reviewId}/codex/${role}`;
    const sourceReceiptId = `${activationNonce}/source`;
    const readinessReceiptId = `${activationNonce}/readiness`;
    reviews.captureReviewReceiptPair({ pairId: activationNonce, phase: "admission",
      activationNonce, scopeRevision: 1, recoveryGeneration: null,
      expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
      predecessorReceiptIds: { source: null, readiness: null }, receipts: {
        source: { receiptId: sourceReceiptId,
          scope: `review/${input.reviewId}/codex/${role}/source`,
          observation: { sourceFingerprint: input.sourceFingerprint, valid: true } },
        readiness: { receiptId: readinessReceiptId,
          scope: `review/${input.reviewId}/codex/${role}/readiness`,
          observation: { harnessReady: true, valid: true } },
      }, createdAt: input.createdAt });
    admissionReceipts.push({ agent: "codex", role, activationNonce,
      sourceReceiptId, readinessReceiptId });
  }
  reviews.create({ ...input, admissionReceipts });
  const db = new Database(path);
  db.prepare(`UPDATE runs SET status='completed' WHERE id IN (
    SELECT run_id FROM runtime_review_lane_attempts WHERE review_id=? AND agent='codex'
  )`).run(input.reviewId);
  db.close();
}

function activationSnapshot(path: string, reviewId: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true });
  const tables = [
    "runs", "runtime_provider_health", "runtime_provider_recovery_generations",
    "runtime_review_barriers", "runtime_review_lanes", "runtime_review_attempt_base_policies",
    "runtime_review_lane_attempts", "runtime_review_attempt_authorities",
    "runtime_review_generation_consumptions", "runtime_review_receipts",
    "runtime_review_receipt_heads", "runtime_review_receipt_lifecycle",
  ];
  const snapshot: Record<string, unknown> = Object.fromEntries(tables.map((table) => [
    table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
  snapshot.reviewId = reviewId;
  db.close();
  return snapshot;
}

function preparedDeferred(path: string, reviewId: string): {
  reviews: RunGateUnitOfWork;
  health: ProviderHealthStore;
  generation: number;
  admissionReceipts: Array<Record<string, unknown>>;
} {
  initializeCurrentExecutionSchema(path);
  const reviews = new RunGateUnitOfWork(path);
  createWithAdmission(path, reviews, { ...reviewInput, reviewId, idempotencyKey: reviewId });
  const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
  const db = new Database(path);
  db.prepare(`DELETE FROM runtime_review_lanes
    WHERE review_id=? AND agent<>'codex' AND NOT (agent='claude' AND role='auditor')`).run(reviewId);
  db.close();
  expect(health.acquireExplicitProbeAdmission("claude", 100)).toEqual({ runnable: true, claimedAt: 100 });
  health.recordSuccess("claude", 101, 100);
  const generationDb = new Database(path, { readonly: true });
  const generation = generationDb.prepare(`SELECT MAX(generation)
    FROM runtime_provider_recovery_generations WHERE agent='claude'`).pluck().get() as number;
  generationDb.close();
  const captureCandidate = (reviews as unknown as Record<string, unknown>).captureReviewReceipt;
  expect(captureCandidate).toBeTypeOf("function");
  const capture = (captureCandidate as (input: Record<string, unknown>) => Record<string, unknown>)
    .bind(reviews);
  const activationNonce = `${reviewId}-nonce`;
  const pair: Record<string, unknown> = { role: "auditor", activationNonce };
  for (const kind of ["source", "readiness"] as const) {
    const receiptId = `${reviewId}-${kind}`;
    capture({ receiptId, phase: "admission", scope: `review/${reviewId}/claude/auditor/${kind}`,
      scopeRevision: 1, activationNonce,
      expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
      recoveryGeneration: generation,
      observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
        : { harnessReady: true, valid: true }, predecessorReceiptId: null, createdAt: 102 });
    pair[`${kind}ReceiptId`] = receiptId;
  }
  return { reviews, health, generation, admissionReceipts: [pair] };
}

function workerActivation(input: {
  databasePath: string;
  role: "leader" | "contender";
  gate: SharedArrayBuffer;
  activation: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fixtures/review-v3-activation-worker.mjs", import.meta.url), {
      workerData: { databasePath: input.databasePath, role: input.role,
        gate: input.gate, input: input.activation },
      execArgv: ["--import", "tsx"],
    });
    worker.once("message", (message: { ok: boolean; result?: Record<string, unknown>; error?: string }) => {
      if (message.ok) resolve(message.result!);
      else reject(new Error(message.error));
    });
    worker.once("error", reject);
  });
}

describe("authority-v3 recovered review admission", () => {
  it.each([
    ["currentSourceFingerprint", "source-v1"],
    ["harnessReady", true],
    ["providerHealth", {}],
  ] as const)("rejects legacy raw %s evidence with byte-identical authority state",
    (field, value) => {
      const path = database();
      const prepared = preparedDeferred(path, `raw-${field}`);
      const before = activationSnapshot(path, `raw-${field}`);
      expect(() => prepared.reviews.activateDeferred({
        reviewId: `raw-${field}`, agent: "claude", now: 103,
        recoveryGeneration: prepared.generation,
        admissionReceipts: prepared.admissionReceipts as unknown as ReviewAdmissionReceiptPair[],
        [field]: value,
      })).toThrow(/authority-v3.*legacy raw/i);
      expect(activationSnapshot(path, `raw-${field}`)).toEqual(before);
      prepared.reviews.close();
      prepared.health.close();
    });

  it("automatically rejoins recovered optional work through the control-loop wrapper", () => {
    const path = database();
    const prepared = preparedDeferred(path, "automatic-rejoin");
    const evidenceCapture = { capture: () => ({ kind: "ready" as const, agent: "claude" as const,
      observedAt: 103, source: { sourceFingerprint: "source-v1", valid: true },
      readiness: { harnessReady: true, state: "ready" as const, valid: true } }) };
    const activate = activateRecoveredReviewLanes as unknown as
      (input: Record<string, unknown>) => Record<string, unknown>;
    expect(activate({ agent: "claude", now: 103, reviews: prepared.reviews,
      health: prepared.health, evidenceCapture }))
      .toMatchObject({ activated: 1, stale: 0, skippedSatisfied: 0 });
    expect(prepared.reviews.attempts("automatic-rejoin", "claude", "auditor"))
      .toHaveLength(1);
    prepared.reviews.close(); prepared.health.close();
  });

  it("keeps wrapper recovery fail-closed when no exact receipt-pair capture is provided", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const reviews = new RunGateUnitOfWork(path);
    createWithAdmission(path, reviews, { ...reviewInput, reviewId: "wrapper-no-receipts",
      idempotencyKey: "wrapper-no-receipts" });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.acquireExplicitProbeAdmission("claude", 100)).toEqual({ runnable: true, claimedAt: 100 });
    health.recordSuccess("claude", 101, 100);
    expect(() => activateRecoveredReviewLanes({ agent: "claude", now: 102, reviews, health }))
      .toThrow(/typed rejoin evidence capture is required/i);
    expect(reviews.attempts("wrapper-no-receipts", "claude", "auditor")).toHaveLength(0);
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
      WHERE review_id='wrapper-no-receipts'`).pluck().get()).toBe(0);
    db.close(); reviews.close(); health.close();
  });

  it("linearizes two SQLite processes contending on the same current pair/tuple/G", async () => {
    const path = database();
    const prepared = preparedDeferred(path, "activation-race");
    const input = { reviewId: "activation-race", agent: "claude", now: 103,
      recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts };
    prepared.reviews.close();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const [winner, replay] = await Promise.all([
      workerActivation({ databasePath: path, role: "leader", gate, activation: input }),
      workerActivation({ databasePath: path, role: "contender", gate,
        activation: { ...input, now: 104 } }),
    ]);
    expect(winner).toMatchObject({ status: "activated" });
    expect(replay).toEqual(winner);
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
      WHERE review_id='activation-race' AND agent='claude' AND role='auditor'`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
      WHERE review_id='activation-race' AND agent='claude' AND role='auditor'`).pluck().get()).toBe(1);
    db.close();
    prepared.health.close();
  });

  it("supersedes pair A with B before activation and lets only B authorize", () => {
    const path = database();
    const prepared = preparedDeferred(path, "activation-supersession");
    const captureMethod = (prepared.reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    const capture = (captureMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(prepared.reviews);
    const pairB: Record<string, unknown> = { role: "auditor", activationNonce: "pair-b" };
    for (const kind of ["source", "readiness"] as const) {
      const predecessorReceiptId = `activation-supersession-${kind}`;
      const receiptId = `${predecessorReceiptId}-b`;
      capture({ receiptId, phase: "admission",
        scope: `review/activation-supersession/claude/auditor/${kind}`, scopeRevision: 2,
        activationNonce: "pair-b", expectedTuple: {
          laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
        }, recoveryGeneration: prepared.generation,
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true }, predecessorReceiptId, createdAt: 103 });
      pairB[`${kind}ReceiptId`] = receiptId;
    }
    const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
      (input: Record<string, unknown>) => Record<string, unknown>;
    const before = activationSnapshot(path, "activation-supersession");
    expect(activate({ reviewId: "activation-supersession", agent: "claude", now: 104,
      recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts }))
      .toMatchObject({ status: "none", lanes: [] });
    expect(activationSnapshot(path, "activation-supersession")).toEqual(before);
    expect(activate({ reviewId: "activation-supersession", agent: "claude", now: 105,
      recoveryGeneration: prepared.generation, admissionReceipts: [pairB] }))
      .toMatchObject({ status: "activated" });
    prepared.reviews.close(); prepared.health.close();
  });

  it("rejects a current invalid admission observation with byte-identical durable state", () => {
    const path = database();
    const reviewId = "activation-invalid-observation";
    const prepared = preparedDeferred(path, reviewId);
    const captureMethod = (prepared.reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    const capture = (captureMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(prepared.reviews);
    const pair: Record<string, unknown> = { role: "auditor", activationNonce: "invalid-pair" };
    for (const kind of ["source", "readiness"] as const) {
      const predecessorReceiptId = `${reviewId}-${kind}`;
      const receiptId = `${predecessorReceiptId}-invalid`;
      capture({ receiptId, phase: "admission", scope: `review/${reviewId}/claude/auditor/${kind}`,
        scopeRevision: 2, activationNonce: "invalid-pair", expectedTuple: {
          laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
        }, recoveryGeneration: prepared.generation,
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: false }
          : { harnessReady: true, valid: true }, predecessorReceiptId, createdAt: 103 });
      pair[`${kind}ReceiptId`] = receiptId;
    }
    const before = activationSnapshot(path, reviewId);
    const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
      (input: Record<string, unknown>) => Record<string, unknown>;
    expect(activate({ reviewId, agent: "claude", now: 104,
      recoveryGeneration: prepared.generation, admissionReceipts: [pair] }))
      .toEqual({ status: "none", lanes: [] });
    expect(activationSnapshot(path, reviewId)).toEqual(before);
    prepared.reviews.close(); prepared.health.close();
  });

  it.each([
    "after_lane_cas", "after_generation_consumption", "after_attempt_authority_insert",
    "after_run_insert", "after_attempt_link_insert", "after_projection_update",
    "before_activation_commit",
  ])("rolls back the complete activation tuple at %s", (faultPoint) => {
    const path = database();
    const prepared = preparedDeferred(path, `activation-fault-${faultPoint}`);
    const reviewId = `activation-fault-${faultPoint}`;
    const before = activationSnapshot(path, reviewId);
    const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    expect(() => activate({ reviewId, agent: "claude", now: 103,
      recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts,
      faultInjector: (point: string) => {
        if (point === faultPoint) throw new Error(`injected activation fault: ${faultPoint}`);
      } })).toThrow(/injected activation fault/i);
    expect(activationSnapshot(path, reviewId)).toEqual(before);
    prepared.reviews.close(); prepared.health.close();
  });

  it("replays a response-lost committed activation without a second attempt or G consumption", () => {
    const path = database();
    const prepared = preparedDeferred(path, "activation-response-loss");
    const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
      (input: Record<string, unknown>) => Record<string, unknown>;
    const input = { reviewId: "activation-response-loss", agent: "claude", now: 103,
      recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts };
    expect(() => activate({ ...input, faultInjector: (point: string) => {
      if (point === "after_activation_commit_before_response") throw new Error("response lost");
    } })).toThrow(/response lost/i);
    const captureMethod = (prepared.reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    const capture = (captureMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(prepared.reviews);
    const replayNonce = "activation-response-loss-replay";
    const replayPair: Record<string, unknown> = { role: "auditor", activationNonce: replayNonce };
    for (const kind of ["source", "readiness"] as const) {
      const predecessorReceiptId = `activation-response-loss-${kind}`;
      const receiptId = `${predecessorReceiptId}-replay`;
      capture({ receiptId, phase: "admission",
        scope: `review/activation-response-loss/claude/auditor/${kind}`, scopeRevision: 2,
        activationNonce: replayNonce, expectedTuple: {
          laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
        }, recoveryGeneration: prepared.generation,
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true }, predecessorReceiptId, createdAt: 104 });
      replayPair[`${kind}ReceiptId`] = receiptId;
    }
    const replay = activate({ ...input, now: 105, admissionReceipts: [replayPair] });
    expect(replay).toMatchObject({ status: "activated", lanes: [expect.objectContaining({
      attemptOrdinal: 0, recoveryGeneration: prepared.generation,
    })] });
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
      WHERE review_id='activation-response-loss' AND agent='claude' AND role='auditor'`)
      .pluck().get()).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
      WHERE review_id='activation-response-loss'`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT receipt_id,state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id LIKE 'activation-response-loss-%-replay' ORDER BY receipt_id`).all()).toEqual([
      { receipt_id: "activation-response-loss-readiness-replay", state: "orphaned" },
      { receipt_id: "activation-response-loss-source-replay", state: "orphaned" },
    ]);
    db.close();
    prepared.reviews.close(); prepared.health.close();
  });

  it("recaptures fresh receipt revisions after a crash before activation BEGIN", () => {
    const path = database();
    const prepared = preparedDeferred(path, "activation-prebegin");
    const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    expect(() => activate({ reviewId: "activation-prebegin", agent: "claude", now: 103,
      recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts,
      faultInjector: (point: string) => {
        if (point === "before_activation_begin") throw new Error("pre-BEGIN crash");
      } })).toThrow(/pre-BEGIN crash/i);
    const captureMethod = (prepared.reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    const capture = (captureMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(prepared.reviews);
    const activationNonce = "activation-prebegin-retry";
    const retryPair: Record<string, unknown> = { role: "auditor", activationNonce };
    for (const kind of ["source", "readiness"] as const) {
      const predecessorReceiptId = `activation-prebegin-${kind}`;
      const receiptId = `${predecessorReceiptId}-retry`;
      capture({ receiptId, phase: "admission",
        scope: `review/activation-prebegin/claude/auditor/${kind}`, scopeRevision: 2,
        activationNonce, expectedTuple: {
          laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
        }, recoveryGeneration: prepared.generation,
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true }, predecessorReceiptId, createdAt: 104 });
      retryPair[`${kind}ReceiptId`] = receiptId;
    }
    expect(activate({ reviewId: "activation-prebegin", agent: "claude", now: 105,
      recoveryGeneration: prepared.generation, admissionReceipts: [retryPair] }))
      .toMatchObject({ status: "activated" });
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT receipt_id,state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id IN ('activation-prebegin-source','activation-prebegin-readiness')
      ORDER BY receipt_id`).all()).toEqual([
      { receipt_id: "activation-prebegin-readiness", state: "superseded" },
      { receipt_id: "activation-prebegin-source", state: "superseded" },
    ]);
    db.close(); prepared.reviews.close(); prepared.health.close();
  });

  it.each(["superseded", "orphaned"] as const)(
    "rejects a %s admission receipt without any durable activation side effect",
    (terminalState) => {
      const path = database();
      const prepared = preparedDeferred(path, `activation-reject-${terminalState}`);
      const reviewId = `activation-reject-${terminalState}`;
      const sourceReceiptId = `${reviewId}-source`;
      const db = new Database(path);
      db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
        (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
         recovery_generation,predecessor_receipt_id,recorded_at)
        SELECT receipt_id,?,scope_revision,activation_nonce,expected_tuple_json,
               recovery_generation,predecessor_receipt_id,103
        FROM runtime_review_receipts WHERE receipt_id=?`).run(terminalState, sourceReceiptId);
      db.close();
      const before = activationSnapshot(path, reviewId);
      const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
        (input: Record<string, unknown>) => Record<string, unknown>;
      expect(activate({ reviewId, agent: "claude", now: 104,
        recoveryGeneration: prepared.generation, admissionReceipts: prepared.admissionReceipts }))
        .toMatchObject({ status: "none", lanes: [] });
      expect(activationSnapshot(path, reviewId)).toEqual(before);
      prepared.reviews.close(); prepared.health.close();
    },
  );

  it.each([
    { variant: "missing-receipt", expected: "needs_reconciliation" },
    { variant: "unverified-health", expected: "provider_unavailable" },
    { variant: "claimed-probe", expected: "provider_unavailable" },
    { variant: "consumed-generation", expected: "none" },
  ] as const)("rejects $variant with a byte-identical authority-state snapshot",
    ({ variant, expected }) => {
      const path = database();
      const reviewId = `activation-negative-${variant}`;
      const prepared = preparedDeferred(path, reviewId);
      const input = { reviewId, agent: "claude", now: 104,
        recoveryGeneration: prepared.generation,
        admissionReceipts: structuredClone(prepared.admissionReceipts) } as Record<string, unknown>;
      const db = new Database(path);
      if (variant === "missing-receipt") {
        (input.admissionReceipts as Array<Record<string, unknown>>)[0]!.sourceReceiptId = "absent";
      } else if (variant === "unverified-health") {
        db.prepare(`UPDATE runtime_provider_health SET capability_verified=0
          WHERE agent='claude'`).run();
      } else if (variant === "claimed-probe") {
        db.prepare(`UPDATE runtime_provider_health SET attempt_claimed=1
          WHERE agent='claude'`).run();
      } else {
        db.prepare(`INSERT INTO runtime_review_generation_consumptions
          (generation,review_id,agent,role) VALUES (?,?,?,?)`).run(
            prepared.generation, reviewId, "claude", "auditor");
      }
      db.close();
      const before = activationSnapshot(path, reviewId);
      const activate = prepared.reviews.activateDeferred.bind(prepared.reviews) as unknown as
        (activation: Record<string, unknown>) => Record<string, unknown>;
      expect(activate(input)).toEqual({ status: expected, lanes: [] });
      expect(activationSnapshot(path, reviewId)).toEqual(before);
      prepared.reviews.close(); prepared.health.close();
    },
  );
  it("first-admits a never-attempted deferred lane at ordinal zero using G and current receipts", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = new RunGateUnitOfWork(path);
    createWithAdmission(path, reviews, reviewInput);

    const setup = new Database(path, { readonly: true });
    expect(setup.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
      WHERE review_id=? AND agent='claude'`).pluck().get(reviewInput.reviewId)).toBe(0);
    setup.close();

    expect(health.acquireExplicitProbeAdmission("claude", 100)).toEqual({ runnable: true, claimedAt: 100 });
    health.recordSuccess("claude", 101, 100);
    const evidence = new Database(path);
    const generation = evidence.prepare(`SELECT generation FROM runtime_provider_recovery_generations
      WHERE agent='claude' ORDER BY generation DESC LIMIT 1`).pluck().get() as number;
    expect(Number.isSafeInteger(generation)).toBe(true);
    const admissionReceipts: Array<Record<string, unknown>> = [];
    for (const role of ["auditor", "critic"] as const) {
      const sourceReceiptId = `source-r1-${role}`;
      const readinessReceiptId = `ready-r1-${role}`;
      appendPendingReceipt(evidence, { receiptId: sourceReceiptId,
        scope: `review/rejoin-v3/claude/${role}/source`, activationNonce: `nonce-r1-${role}`,
        generation, observation: { sourceFingerprint: "source-v1", valid: true } });
      appendPendingReceipt(evidence, { receiptId: readinessReceiptId,
        scope: `review/rejoin-v3/claude/${role}/readiness`, activationNonce: `nonce-r1-${role}`,
        generation, observation: { harnessReady: true, valid: true } });
      admissionReceipts.push({ role, sourceReceiptId, readinessReceiptId,
        activationNonce: `nonce-r1-${role}` });
    }
    evidence.close();

    const activateDeferred = reviews.activateDeferred.bind(reviews) as unknown as
      (input: Record<string, unknown>) => { status: string; lanes: Array<Record<string, unknown>> };
    const activation = activateDeferred({
      reviewId: reviewInput.reviewId,
      agent: "claude",
      now: 103,
      recoveryGeneration: generation,
      admissionReceipts,
    });
    expect(activation.status).toBe("activated");
    expect(activation.lanes).toEqual([
      expect.objectContaining({ agent: "claude", role: "auditor", attemptOrdinal: 0,
        recoveryGeneration: generation, sourceReceiptId: "source-r1-auditor",
        readinessReceiptId: "ready-r1-auditor" }),
      expect.objectContaining({ agent: "claude", role: "critic", attemptOrdinal: 0,
        recoveryGeneration: generation, sourceReceiptId: "source-r1-critic",
        readinessReceiptId: "ready-r1-critic" }),
    ]);

    const competing = new RunGateUnitOfWork(path);
    const replay = (competing.activateDeferred.bind(competing) as unknown as
      (input: Record<string, unknown>) => unknown)({
      reviewId: reviewInput.reviewId, agent: "claude", now: 104,
      recoveryGeneration: generation, admissionReceipts,
    });
    expect(replay).toEqual(activation);
    competing.close();
    reviews.close();
    health.close();

    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT attempt_ordinal,recovery_generation
      FROM runtime_review_lane_attempts WHERE review_id=? AND agent='claude' ORDER BY role`)
      .all(reviewInput.reviewId)).toEqual([
      { attempt_ordinal: 0, recovery_generation: generation },
      { attempt_ordinal: 0, recovery_generation: generation },
    ]);
    expect(reopened.prepare(`SELECT generation,review_id,agent,role
      FROM runtime_review_generation_consumptions WHERE generation=? ORDER BY role`).all(generation)).toEqual([{
      generation,
      review_id: reviewInput.reviewId,
      agent: "claude",
      role: "auditor",
    }, {
      generation,
      review_id: reviewInput.reviewId,
      agent: "claude",
      role: "critic",
    }]);
    reopened.close();
  });

  it("prevents one recovery generation from authorizing two attempts for the same lane", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    const sql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_generation_consumptions'`).pluck().get());
    expect(sql).toMatch(/unique\s*\(\s*generation\s*,\s*review_id\s*,\s*agent\s*,\s*role\s*\)/i);
    expect(sql).toMatch(/runtime_provider_recovery_generations/i);
    db.close();
  });

  it("creates recovery ordinal N+1 only from G2 and fences replay/ABA of G1 and stale tuples", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = new RunGateUnitOfWork(path);
    createWithAdmission(path, reviews, { ...reviewInput, reviewId: "recovery-n", idempotencyKey: "recovery-n" });
    const trim = new Database(path);
    trim.prepare(`DELETE FROM runtime_review_lanes
      WHERE review_id='recovery-n' AND agent<>'codex'
        AND NOT (agent='claude' AND role='auditor')`).run();

    expect(health.acquireExplicitProbeAdmission("claude", 100)).toEqual({ runnable: true, claimedAt: 100 });
    health.recordSuccess("claude", 101, 100);
    const g1 = trim.prepare(`SELECT MAX(generation) FROM runtime_provider_recovery_generations
      WHERE agent='claude'`).pluck().get() as number;
    for (const [kind, receiptId] of [["source", "g1-source"], ["readiness", "g1-ready"]] as const) {
      appendPendingReceipt(trim, { receiptId, scope: `review/recovery-n/claude/auditor/${kind}`,
        activationNonce: "g1-nonce", generation: g1,
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true } });
    }
    trim.close();
    const activate = reviews.activateDeferred.bind(reviews) as unknown as
      (input: Record<string, unknown>) => { status: string; lanes: Array<Record<string, unknown>> };
    const first = activate({ reviewId: "recovery-n", agent: "claude", now: 102,
      recoveryGeneration: g1, admissionReceipts: [{ role: "auditor", sourceReceiptId: "g1-source",
        readinessReceiptId: "g1-ready", activationNonce: "g1-nonce" }] });
    expect(first.lanes[0]).toMatchObject({ attemptOrdinal: 0, recoveryGeneration: g1 });

    const attempt = first.lanes[0] as {
      idempotencyKey: string;
      attemptId: string;
      model: "grok-4.6" | "glm-5.3" | "gpt-5.6-sol";
      effort: "high" | "xhigh" | "max";
      policyVersion: "routing-v5";
      sessionId: string;
    };
    const runs = new RunStore(path);
    const claimed = runs.claimNext({ workerId: "recovery-test", leaseMs: 10_000, now: 103 })!;
    expect(claimed.idempotencyKey).toBe(attempt.idempotencyKey);
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "claude" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, {
      phase: "started", pid: 1234, agent: "claude", model: attempt.model,
      effort: attempt.effort, policyVersion: attempt.policyVersion, sessionId: attempt.sessionId,
    });
    const unavailable = { kind: "quota", agent: "claude" } as const;
    runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult: unavailable,
      effect: { type: "review", reviewId: "recovery-n", attemptId: attempt.attemptId,
        role: "auditor", agent: "claude", resultKind: "quota", terminalAt: 200 }, status: "completed" });
    reviews.recordProviderUnavailable({ reviewId: "recovery-n", agent: "claude", role: "auditor",
      attemptId: String(attempt.attemptId), error: unavailable, terminalAt: 200 });
    runs.close();
    health.recordFailoverFailure("claude", unavailable, 200);
    expect(health.acquireExplicitProbeAdmission("claude", 1_200)).toEqual({ runnable: true, claimedAt: 1_200 });
    health.recordSuccess("claude", 1_201, 1_200);

    const db = new Database(path);
    const g2 = db.prepare(`SELECT MAX(generation) FROM runtime_provider_recovery_generations
      WHERE agent='claude'`).pluck().get() as number;
    expect(g2).toBeGreaterThan(g1);
    const laneRevision = db.prepare(`SELECT lane_revision FROM runtime_review_lanes
      WHERE review_id='recovery-n' AND agent='claude' AND role='auditor'`).pluck().get() as number;
    const evidenceHash = canonicalHash(unavailable);
    const tuple = { laneRevision, latestOrdinal: 0, latestEvidenceHash: evidenceHash };
    for (const [kind, receiptId] of [["source", "g2-source"], ["readiness", "g2-ready"]] as const) {
      appendPendingReceipt(db, { receiptId, scope: `review/recovery-n/claude/auditor/${kind}`,
        activationNonce: "g2-nonce", generation: g2, expectedTuple: tuple, scopeRevision: 2,
        predecessorReceiptId: kind === "source" ? "g1-source" : "g1-ready",
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true } });
    }
    db.prepare(`UPDATE runtime_review_lanes SET model='gpt-5.6-sol',effort='high',
      reasons='["mutable-drift"]',session_id='mutable-lane-session',
      idempotency_key='mutable-lane-idempotency'
      WHERE review_id='recovery-n' AND agent='claude' AND role='auditor'`).run();
    db.close();
    const second = activate({ reviewId: "recovery-n", agent: "claude", now: 1_202,
      recoveryGeneration: g2, admissionReceipts: [{ role: "auditor", sourceReceiptId: "g2-source",
        readinessReceiptId: "g2-ready", activationNonce: "g2-nonce" }] });
    expect(second.lanes[0]).toMatchObject({ attemptOrdinal: 1, recoveryGeneration: g2,
      previousOrdinal: 0, previousEvidenceHash: evidenceHash,
      model: attempt.model, effort: attempt.effort, policyVersion: attempt.policyVersion });
    expect(second.lanes[0]!.sessionId).not.toBe("mutable-lane-session");
    expect(second.lanes[0]!.idempotencyKey).not.toBe("mutable-lane-idempotency");
    const identityFactory = (reviewRuntime as unknown as Record<string, unknown>)
      .createReviewAttemptIdentity as ((input: Record<string, unknown>) => Record<string, unknown>);
    expect(identityFactory).toBeTypeOf("function");
    const expectedIdentity = identityFactory({ reviewId: "recovery-n",
      barrierIdempotencyKey: "recovery-n", agent: "claude", role: "auditor", ordinal: 1 });
    const persistedIdentity = new Database(path, { readonly: true });
    expect(persistedIdentity.prepare(`SELECT attempt_id,session_id,idempotency_key
      FROM runtime_review_lane_attempts WHERE review_id='recovery-n' AND agent='claude'
        AND role='auditor' AND attempt_ordinal=1`).get()).toEqual({
      attempt_id: expectedIdentity.attemptId,
      session_id: expectedIdentity.sessionId,
      idempotency_key: expectedIdentity.idempotencyKey,
    });
    persistedIdentity.close();

    const secondAttempt = second.lanes[0] as typeof attempt;
    const secondRuns = new RunStore(path);
    const secondClaim = secondRuns.claimNext({ workerId: "recovery-test-2", leaseMs: 10_000,
      now: 1_203 })!;
    expect(secondClaim.idempotencyKey).toBe(secondAttempt.idempotencyKey);
    secondRuns.markLaunchIntent(secondClaim.id, secondClaim.leaseToken!, { agent: "claude" });
    secondRuns.markLaunched(secondClaim.id, secondClaim.leaseToken!, {
      phase: "started", pid: 1235, agent: "claude", model: secondAttempt.model,
      effort: secondAttempt.effort, policyVersion: secondAttempt.policyVersion,
      sessionId: secondAttempt.sessionId,
    });
    const unavailable2 = { kind: "quota", agent: "claude", cycle: 2 } as const;
    secondRuns.commitDomainEffect({ id: secondClaim.id, token: secondClaim.leaseToken!,
      providerResult: unavailable2,
      effect: { type: "review", reviewId: "recovery-n", attemptId: secondAttempt.attemptId,
        role: "auditor", agent: "claude", resultKind: "quota", terminalAt: 1_300 },
      status: "completed" });
    reviews.recordProviderUnavailable({ reviewId: "recovery-n", agent: "claude", role: "auditor",
      attemptId: secondAttempt.attemptId, error: unavailable2, terminalAt: 1_300 });
    secondRuns.close();
    health.recordFailoverFailure("claude", unavailable2, 1_300);
    expect(health.acquireExplicitProbeAdmission("claude", 2_300))
      .toEqual({ runnable: true, claimedAt: 2_300 });
    health.recordSuccess("claude", 2_301, 2_300);
    const g3db = new Database(path);
    const g3 = g3db.prepare(`SELECT MAX(generation) FROM runtime_provider_recovery_generations
      WHERE agent='claude'`).pluck().get() as number;
    expect(g3).toBeGreaterThan(g2);
    const laneRevision2 = g3db.prepare(`SELECT lane_revision FROM runtime_review_lanes
      WHERE review_id='recovery-n' AND agent='claude' AND role='auditor'`).pluck().get() as number;
    const evidenceHash2 = canonicalHash(unavailable2);
    const tuple2 = { laneRevision: laneRevision2, latestOrdinal: 1, latestEvidenceHash: evidenceHash2 };
    for (const [kind, receiptId] of [["source", "g3-source"], ["readiness", "g3-ready"]] as const) {
      appendPendingReceipt(g3db, { receiptId,
        scope: `review/recovery-n/claude/auditor/${kind}`, activationNonce: "g3-nonce",
        generation: g3, expectedTuple: tuple2, scopeRevision: 3,
        predecessorReceiptId: kind === "source" ? "g2-source" : "g2-ready",
        observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
          : { harnessReady: true, valid: true } });
    }
    g3db.close();
    const third = activate({ reviewId: "recovery-n", agent: "claude", now: 2_302,
      recoveryGeneration: g3, admissionReceipts: [{ role: "auditor", sourceReceiptId: "g3-source",
        readinessReceiptId: "g3-ready", activationNonce: "g3-nonce" }] });
    expect(third.lanes[0]).toMatchObject({ attemptOrdinal: 2, recoveryGeneration: g3,
      previousOrdinal: 1, previousEvidenceHash: evidenceHash2,
      model: attempt.model, effort: attempt.effort, policyVersion: attempt.policyVersion });

    expect(activate({ reviewId: "recovery-n", agent: "claude", now: 1_203,
      recoveryGeneration: g1, admissionReceipts: [{ role: "auditor", sourceReceiptId: "g1-source",
        readinessReceiptId: "g1-ready", activationNonce: "g1-nonce" }] })).toMatchObject({
      status: "none", lanes: [],
    });
    expect(reviews.attempts("recovery-n", "claude", "auditor").map(({ attemptOrdinal }) => attemptOrdinal))
      .toEqual([0, 1, 2]);
    const corrupt = new Database(path);
    const countsBeforeCorruption = {
      attempts: corrupt.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
        WHERE review_id='recovery-n'`).pluck().get(),
      generations: corrupt.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
        WHERE review_id='recovery-n'`).pluck().get(),
    };
    corrupt.exec(`DROP TRIGGER runtime_review_attempt_update_immutable;
      PRAGMA ignore_check_constraints=ON;`);
    corrupt.prepare(`UPDATE runtime_review_lane_attempts SET base_policy_id='historical-corruption'
      WHERE review_id='recovery-n' AND agent='claude' AND role='auditor' AND attempt_ordinal=0`).run();
    corrupt.close();
    expect(reviews.attempts("recovery-n", "claude", "auditor").at(-1)?.status)
      .toBe("needs_reconciliation");
    expect(reviews.barrier("recovery-n").satisfied).toBe(false);
    const proof = new Database(path, { readonly: true });
    expect({
      attempts: proof.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
        WHERE review_id='recovery-n'`).pluck().get(),
      generations: proof.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
        WHERE review_id='recovery-n'`).pluck().get(),
    }).toEqual(countsBeforeCorruption);
    expect(proof.prepare(`SELECT DISTINCT status FROM runs WHERE id IN (
      SELECT run_id FROM runtime_review_lane_attempts WHERE review_id='recovery-n')`)
      .pluck().all()).toContain("needs_reconciliation");
    proof.close();
    reviews.close();
    health.close();
  });

  it("source drift performs only the durable stale CAS and consumes no generation", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = new RunGateUnitOfWork(path);
    createWithAdmission(path, reviews, { ...reviewInput, reviewId: "source-drift", idempotencyKey: "source-drift" });
    expect(health.acquireExplicitProbeAdmission("claude", 10)).toEqual({ runnable: true, claimedAt: 10 });
    health.recordSuccess("claude", 11, 10);
    const db = new Database(path);
    const generation = db.prepare(`SELECT MAX(generation) FROM runtime_provider_recovery_generations
      WHERE agent='claude'`).pluck().get() as number;
    for (const [kind, id] of [["source", "drift-source"], ["readiness", "drift-ready"]] as const) {
      appendPendingReceipt(db, { receiptId: id,
        scope: `review/source-drift/claude/auditor/${kind}`, activationNonce: "drift-nonce", generation,
        observation: kind === "source" ? { sourceFingerprint: "source-v2", valid: true }
          : { harnessReady: true, valid: true } });
    }
    const before = db.prepare(`SELECT COUNT(*) attempts FROM runtime_review_lane_attempts
      WHERE review_id='source-drift'`).get();
    db.close();
    const activate = reviews.activateDeferred.bind(reviews) as unknown as
      (input: Record<string, unknown>) => Record<string, unknown>;
    expect(activate({ reviewId: "source-drift", agent: "claude", now: 12,
      recoveryGeneration: generation, admissionReceipts: [{ role: "auditor",
        sourceReceiptId: "drift-source", readinessReceiptId: "drift-ready",
        activationNonce: "drift-nonce" }] })).toMatchObject({ status: "stale_artifact", lanes: [] });
    reviews.close();
    health.close();
    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT COUNT(*) attempts FROM runtime_review_lane_attempts
      WHERE review_id='source-drift'`).get()).toEqual(before);
    expect(reopened.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
      WHERE generation=? AND review_id='source-drift'`).pluck().get(generation)).toBe(0);
    expect(reopened.prepare(`SELECT DISTINCT status FROM runtime_review_lanes
      WHERE review_id='source-drift' AND agent='claude'`).pluck().all()).toEqual(["stale_artifact"]);
    reopened.close();
  });

  it("atomically couples explicit-probe success to one immutable G and never mints G for normal success", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.acquireExplicitProbeAdmission("claude", 50)).toEqual({ runnable: true, claimedAt: 50 });
    const recordSuccess = health.recordSuccess.bind(health) as unknown as
      (agent: "grok" | "claude" | "codex", now: number, claimedAt?: number,
        options?: { faultInjector?: (point: string) => void }) => unknown;
    expect(() => recordSuccess("claude", 51, 50, { faultInjector: (point) => {
      if (point === "after_health_update_before_generation") {
        throw new Error("injected health-generation fault");
      }
    } })).toThrow(/injected health-generation fault/i);
    expect(health.get("claude")).toMatchObject({ health: "probing", attemptClaimed: true, updatedAt: 50 });
    let db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_provider_recovery_generations
      WHERE agent='claude'`).pluck().get()).toBe(0);
    db.close();

    const committed = recordSuccess("claude", 51, 50);
    expect(recordSuccess("claude", 51, 50)).toEqual(committed);
    db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT agent,generation,probe_claimed_at,verified_at
      FROM runtime_provider_recovery_generations WHERE agent='claude'`).all()).toEqual([
      expect.objectContaining({ agent: "claude", probe_claimed_at: 50, verified_at: 51 }),
    ]);
    db.close();

    recordSuccess("codex", 60);
    db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_provider_recovery_generations
      WHERE agent='codex'`).pluck().get()).toBe(0);
    db.close();
    health.close();
  });
});
