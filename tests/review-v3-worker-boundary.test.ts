import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { executeReviewLaunchWithFence } from "../src/runtime/review-launch-admission.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { RunStore, type RunRecord } from "../src/store/run-store.js";

const roots: string[] = [];

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-v3-worker-boundary-"));
  roots.push(root);
  return join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appendAdmissionReceipts(path: string): Array<Record<string, string>> {
  const db = new Database(path);
  const output: Array<Record<string, string>> = [];
  for (const role of ["auditor", "critic"] as const) {
    const pair: Record<string, string> = { role };
    for (const kind of ["source", "readiness"] as const) {
      const receiptId = `worker-${role}-${kind}`;
      const scope = `review/worker-v3/codex/${role}/${kind}`;
      const observation = JSON.stringify(kind === "source"
        ? { sourceFingerprint: "source-v1", valid: true }
        : { harnessReady: true, manifestHash: "m".repeat(64), valid: true });
      const observationHash = createHash("sha256").update(observation).digest("hex");
      const expectedTuple = JSON.stringify({ laneRevision: 0, latestOrdinal: null,
        latestEvidenceHash: null });
      const canonicalBytes = JSON.stringify({ receiptId, phase: "admission", scope,
        scopeRevision: 1, activationNonce: "worker-create", expectedTuple,
        recoveryGeneration: null, observationHash, predecessorReceiptId: null });
      db.prepare(`INSERT INTO runtime_review_receipts
        (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
         recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
         canonical_bytes,envelope_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, "admission", scope, 1, "worker-create", expectedTuple, null,
        observation, observationHash, null, canonicalBytes,
        createHash("sha256").update(canonicalBytes).digest("hex"), 1,
      );
      db.prepare(`INSERT INTO runtime_review_receipt_heads
        (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,1,'worker-create')`)
        .run(scope, receiptId);
      pair[`${kind}ReceiptId`] = receiptId;
    }
    output.push(pair);
  }
  db.close();
  return output;
}

function reviewRun(): RunRecord {
  return {
    id: "run-v3",
    idempotencyKey: "review-v3-dispatch",
    stage: "review:auditor",
    priority: 20,
    status: "claimed",
    createdAt: 1,
    nextAttemptAt: 1,
    launched: false,
    attemptCount: 1,
    payload: {
      reviewId: "review-v3",
      reviewRole: "auditor",
      reviewAttemptId: "attempt-v3",
      reviewAttemptOrdinal: 0,
      reviewDispatchIdentity: { attemptId: "attempt-v3", attemptOrdinal: 0, agent: "codex" },
      project: "/repo",
      decision: { agent: "codex" },
    },
  };
}

function seedSingleV3WorkerRun(path: string): string {
  initializeCurrentExecutionSchema(path);
  const admissionReceipts = appendAdmissionReceipts(path);
  const reviews = new RunGateUnitOfWork(path);
  const create = reviews.create.bind(reviews) as unknown as
    (input: Record<string, unknown>) => unknown;
  create({ reviewId: "worker-v3", stageId: "stage", artifact: Buffer.from("candidate"),
    health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
    approvalScope: "workspace-read", idempotencyKey: "worker-v3-key",
    prompts: { auditor: "audit", critic: "critic" }, createdAt: 1, project: "/repo",
    requester: "codex", sourceFingerprint: "source-v1", changedFiles: 1, admissionReceipts });
  reviews.close();
  const db = new Database(path);
  const row = db.prepare(`SELECT a.run_id FROM runtime_review_lane_attempts a
    WHERE a.review_id='worker-v3' AND a.agent='codex' AND a.role='auditor'`).get() as { run_id: string };
  const criticRunId = db.prepare(`SELECT run_id FROM runtime_review_lane_attempts
    WHERE review_id='worker-v3' AND role='critic'`).pluck().get() as string;
  db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(criticRunId);
  db.prepare(`UPDATE runtime_review_lanes SET status='completed'
    WHERE review_id='worker-v3' AND role='critic'`).run();
  db.close();
  return row.run_id;
}

describe("authority-v3 claim and worker boundaries", () => {
  it("claims review-v3 work only through the complete committed authority/link tuple", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const admissionReceipts = appendAdmissionReceipts(path);
    const reviews = new RunGateUnitOfWork(path);
    const create = reviews.create.bind(reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    create({
      reviewId: "worker-v3",
      stageId: "stage",
      artifact: Buffer.from("candidate"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read",
      idempotencyKey: "worker-v3-key",
      prompts: { auditor: "audit", critic: "critic" },
      createdAt: 1,
      project: "/repo",
      requester: "codex",
      sourceFingerprint: "source-v1",
      changedFiles: 1,
      admissionReceipts,
    });
    reviews.close();

    const raw = new Database(path);
    raw.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES ('rogue-v3','rogue-v3','review:auditor',0,'queued',0,0,
        '{"reviewId":"worker-v3","reviewRole":"auditor","decision":{"agent":"codex"}}')`).run();
    raw.close();

    const runs = new RunStore(path);
    const claimed = runs.claimNext({ workerId: "v3-worker", leaseMs: 1_000, now: 10 });
    expect(claimed?.id).not.toBe("rogue-v3");
    expect(claimed?.stage).toBe("review:auditor");
    const proofDb = new Database(path, { readonly: true });
    const proof = proofDb.prepare(`SELECT a.attempt_id,a.authority_id
      FROM runtime_review_lane_attempts a
      JOIN runtime_review_attempt_authorities v3 ON v3.authority_id=a.authority_id
      WHERE a.run_id=?`).get(claimed!.id) as Record<string, unknown> | undefined;
    expect(proof).toMatchObject({ attempt_id: expect.any(String), authority_id: expect.any(String) });
    proofDb.close();
    runs.close();
  });

  it("keeps v1 non-claimable while preserving the v2 one-shot claim path", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    for (const version of [1, 2] as const) {
      const reviewId = `claim-v${version}`;
      const runId = `claim-run-v${version}`;
      db.prepare(`INSERT INTO runtime_review_barriers
        (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
         run_state,created_at,launch_authority_version)
        VALUES (?,?,X'01',?,?,?,?,?,?)`).run(reviewId, "stage", `hash-v${version}`,
        "workspace-read", `key-v${version}`, "DEGRADED_REVIEW_SET", version, version);
      db.prepare(`INSERT INTO runtime_review_lanes
        (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
         idempotency_key,prompt,degraded) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`).run(
        reviewId, "codex", "auditor", "queued", "gpt-5.6-sol", "max", "routing-v5", "[]",
        `session-v${version}`, `lane-v${version}`, "audit");
      db.prepare(`INSERT INTO runs
        (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
        VALUES (?,?,?,?,?,?,?,?)`).run(runId, runId, "review:auditor", 30 - version,
        "queued", version, version, JSON.stringify({ reviewId, reviewRole: "auditor",
          decision: { agent: "codex" } }));
      db.prepare(`INSERT INTO runtime_review_lane_attempts
        (review_id,agent,role,attempt_ordinal,run_id,created_at)
        VALUES (?,?,?,?,?,?)`).run(reviewId, "codex", "auditor", 0, runId, version);
    }
    db.close();
    const runs = new RunStore(path);
    expect(runs.claimNext({ workerId: "legacy-worker", leaseMs: 1_000, now: 10 })?.id)
      .toBe("claim-run-v2");
    runs.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare("SELECT status FROM runs WHERE id='claim-run-v1'").pluck().get()).toBe("queued");
    proof.close();
  });

  it.each([
    { label: "attempt link", sql: "UPDATE runtime_review_lane_attempts SET attempt_id='wrong'" },
    { label: "authority", sql: "UPDATE runtime_review_lane_attempts SET authority_id='wrong'" },
    { label: "ordinal", sql: "UPDATE runtime_review_lane_attempts SET attempt_ordinal=1" },
    { label: "lane revision", sql: "UPDATE runtime_review_lane_attempts SET expected_lane_revision=99" },
    { label: "generation", sql: "UPDATE runtime_review_lane_attempts SET recovery_generation=99" },
    { label: "admission receipt", sql: `UPDATE runtime_review_attempt_authorities
      SET admission_source_receipt_id=admission_readiness_receipt_id` },
  ])("does not claim a v3 run with mismatched $label proof", ({ sql }) => {
    const path = database();
    const runId = seedSingleV3WorkerRun(path);
    const db = new Database(path);
    db.exec(`DROP TRIGGER IF EXISTS runtime_review_attempt_update_immutable;
      DROP TRIGGER IF EXISTS runtime_review_authority_update_immutable;
      PRAGMA ignore_check_constraints=ON;`);
    db.prepare(`${sql} WHERE review_id='worker-v3' AND agent='codex' AND role='auditor'`).run();
    db.close();
    const runs = new RunStore(path);
    expect(runs.claimNext({ workerId: "tamper-worker", leaseMs: 1_000, now: 10 })).toBeUndefined();
    runs.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare("SELECT status FROM runs WHERE id=?").pluck().get(runId))
      .toBe("needs_reconciliation");
    proof.close();
  });

  it("never spawns v3 review work when the prelaunch UoW returns no durable authority", async () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 1);
    const capturePrelaunch = vi.fn(() => ({ sourceReceiptId: "p-source", readinessReceiptId: "p-ready" }));
    const applyPrelaunchFence = vi.fn(() => ({ status: "provider_unavailable", spawnAuthority: null }));
    const launch = vi.fn(async () => ({ kind: "success", agent: "codex" }));
    const execute = executeReviewLaunchWithFence as unknown as (input: Record<string, unknown>) =>
      Promise<Record<string, unknown>>;

    const result = await execute({
      run: reviewRun(),
      health,
      observedAt: 2,
      capturePrelaunch,
      reviews: { applyPrelaunchFence },
      launch,
    });

    expect(capturePrelaunch).toHaveBeenCalledOnce();
    expect(applyPrelaunchFence).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "rejected", providerResult: { kind: "model_unavailable" } });
    health.close();
  });

  it("transports an exact durable spawn authority once and does not classify observations itself", async () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 1);
    const prelaunch = { sourceReceiptId: "p-source", readinessReceiptId: "p-ready" };
    const authority = { authorityId: "spawn-authority", authorityHash: "a".repeat(64) };
    const capturePrelaunch = vi.fn(() => prelaunch);
    const applyPrelaunchFence = vi.fn(() => ({ status: "authorized", spawnAuthority: authority }));
    const launch = vi.fn(async (received: unknown) => ({ kind: "success", agent: "codex", received }));
    const execute = executeReviewLaunchWithFence as unknown as (input: Record<string, unknown>) =>
      Promise<Record<string, unknown>>;

    const result = await execute({ run: reviewRun(), health, observedAt: 2,
      capturePrelaunch, reviews: { applyPrelaunchFence }, launch });

    expect(capturePrelaunch).toHaveBeenCalledOnce();
    expect(applyPrelaunchFence).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-v3", prelaunchReceiptId: "p-source",
    }));
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(authority);
    expect(result).toMatchObject({ status: "launched" });
    health.close();
  });

  it("never repeats transport after a crash leaves a durable launch intent", async () => {
    const path = database();
    const runId = seedSingleV3WorkerRun(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const firstOwner = new RunStore(path);
    const claimed = firstOwner.claimNext({ workerId: "crashing-worker", leaseMs: 1_000, now: 10 });
    expect(claimed?.id).toBe(runId);
    firstOwner.markLaunchIntent(runId, claimed!.leaseToken!, {
      authorityId: "spawn-authority", authorityHash: "a".repeat(64),
    });
    firstOwner.close();
    const restarted = new RunStore(path);
    const run = restarted.get(runId)!;
    expect(run).toMatchObject({ id: runId, launched: true,
      launchInfo: { phase: "launching", authorityId: "spawn-authority" } });
    const capturePrelaunch = vi.fn();
    const applyPrelaunchFence = vi.fn();
    const launch = vi.fn(async () => ({ kind: "success", agent: "codex" }));
    const execute = executeReviewLaunchWithFence as unknown as (input: Record<string, unknown>) =>
      Promise<Record<string, unknown>>;
    const result = await execute({ run, health, observedAt: 3,
      capturePrelaunch, reviews: { applyPrelaunchFence }, launch });
    expect(result).toMatchObject({ status: "needs_reconciliation", duplicateSpawnPrevented: true });
    expect(capturePrelaunch).not.toHaveBeenCalled();
    expect(applyPrelaunchFence).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(restarted.get(runId)).toEqual(run);
    restarted.close();
    health.close();
  });

  it.each([
    ["attempt", (payload: Record<string, unknown>) => { delete payload.reviewAttemptId; }],
    ["ordinal", (payload: Record<string, unknown>) => { payload.reviewAttemptOrdinal = 99; }],
    ["review", (payload: Record<string, unknown>) => { payload.reviewId = "foreign-review"; }],
    ["agent", (payload: Record<string, unknown>) => {
      payload.decision = { ...(payload.decision as Record<string, unknown>), agent: "grok" };
    }],
    ["role", (payload: Record<string, unknown>) => { payload.reviewRole = "critic"; }],
  ] as const)("reconciles a v3 run whose payload crosses the immutable %s identity", (_label, mutate) => {
    const path = database();
    const runId = seedSingleV3WorkerRun(path);
    const db = new Database(path);
    const payload = JSON.parse(String(db.prepare("SELECT payload FROM runs WHERE id=?")
      .pluck().get(runId))) as Record<string, unknown>;
    mutate(payload);
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(JSON.stringify(payload), runId);
    const immutableBefore = JSON.stringify({
      attempts: db.prepare(`SELECT * FROM runtime_review_lane_attempts ORDER BY review_id,agent,role,attempt_ordinal`).all(),
      authorities: db.prepare(`SELECT * FROM runtime_review_attempt_authorities ORDER BY authority_id`).all(),
      receipts: db.prepare(`SELECT * FROM runtime_review_receipts ORDER BY receipt_id`).all(),
      lifecycle: db.prepare(`SELECT * FROM runtime_review_receipt_lifecycle ORDER BY receipt_id`).all(),
      generations: db.prepare(`SELECT * FROM runtime_review_generation_consumptions ORDER BY generation,review_id,agent,role`).all(),
      lanes: db.prepare(`SELECT * FROM runtime_review_lanes ORDER BY review_id,agent,role`).all(),
    });
    db.close();
    const runs = new RunStore(path);
    expect(runs.claimNext({ workerId: "identity-worker", leaseMs: 1_000, now: 10 }))
      .toBeUndefined();
    expect(runs.get(runId)?.status).toBe("needs_reconciliation");
    runs.close();
    const proof = new Database(path, { readonly: true });
    expect(JSON.stringify({
      attempts: proof.prepare(`SELECT * FROM runtime_review_lane_attempts ORDER BY review_id,agent,role,attempt_ordinal`).all(),
      authorities: proof.prepare(`SELECT * FROM runtime_review_attempt_authorities ORDER BY authority_id`).all(),
      receipts: proof.prepare(`SELECT * FROM runtime_review_receipts ORDER BY receipt_id`).all(),
      lifecycle: proof.prepare(`SELECT * FROM runtime_review_receipt_lifecycle ORDER BY receipt_id`).all(),
      generations: proof.prepare(`SELECT * FROM runtime_review_generation_consumptions ORDER BY generation,review_id,agent,role`).all(),
      lanes: proof.prepare(`SELECT * FROM runtime_review_lanes ORDER BY review_id,agent,role`).all(),
    })).toBe(immutableBefore);
    proof.close();
  });

  it("rejects a partial review-shaped dispatch instead of falling through to generic launch", async () => {
    const path = database();
    const runId = seedSingleV3WorkerRun(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const runs = new RunStore(path);
    const run = runs.claimNext({ workerId: "partial-worker", leaseMs: 1_000, now: 10 })!;
    expect(run.id).toBe(runId);
    delete run.payload!.reviewAttemptId;
    const launch = vi.fn(async () => ({ kind: "success" }));
    const reconcile = vi.fn(() => runs.reconcileClaimedReviewIdentity(
      run.id, run.leaseToken!, "partial review dispatch"));
    const result = await (executeReviewLaunchWithFence as unknown as
      (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      run, health, observedAt: 11, launch, reconcile,
    });
    expect(result).toMatchObject({ status: "needs_reconciliation" });
    expect(launch).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(runs.get(runId)?.status).toBe("needs_reconciliation");
    runs.close();
    health.close();
  });

  it("keeps the generic launch path only for a true non-review run", async () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const launch = vi.fn(async () => ({ kind: "success" }));
    const run: RunRecord = { ...reviewRun(), id: "ordinary-run", stage: "implementation",
      payload: { workflowId: "workflow", decision: { agent: "codex" } } };
    await expect(executeReviewLaunchWithFence({ run, health, observedAt: 12, launch }))
      .resolves.toMatchObject({ status: "launched" });
    expect(launch).toHaveBeenCalledOnce();
    health.close();
  });
});
