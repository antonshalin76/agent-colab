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
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
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
  const root = mkdtempSync(join(tmpdir(), "agent-collab-prelaunch-fence-"));
  roots.push(root);
  return join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reviewInput = {
  reviewId: "prelaunch-v3",
  stageId: "stage",
  artifact: Buffer.from("candidate"),
  health: { grok: "unavailable", claude: "unavailable", codex: "healthy" } as const,
  approvalScope: "workspace-read" as const,
  idempotencyKey: "prelaunch-v3-key",
  prompts: { auditor: "audit", critic: "critic" },
  createdAt: 1,
  project: "/repo",
  requester: "codex" as const,
  sourceFingerprint: "source-v1",
  changedFiles: 1,
};

function appendInitialAdmissionReceipts(db: Database.Database): Array<Record<string, unknown>> {
  return (["auditor", "critic"] as const).map((role) => {
    const activationNonce = `initial-${role}`;
    const expectedTuple = canonicalJson({ laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null });
    const pair: Record<string, unknown> = { agent: "codex", role, activationNonce };
    for (const kind of ["source", "readiness"] as const) {
      const receiptId = `initial-${role}-${kind}`;
      const scope = `review/${reviewInput.reviewId}/codex/${role}/${kind}`;
      const observationJson = canonicalJson(kind === "source"
        ? { sourceFingerprint: reviewInput.sourceFingerprint, valid: true }
        : { harnessReady: true, valid: true });
      const observationHash = createHash("sha256").update(observationJson).digest("hex");
      const canonicalBytes = canonicalJson({ receiptId, phase: "admission", scope,
        scopeRevision: 1, activationNonce, expectedTuple, recoveryGeneration: null,
        observationHash, predecessorReceiptId: null });
      db.prepare(`INSERT INTO runtime_review_receipts
        (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
         recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
         canonical_bytes,envelope_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, "admission", scope, 1, activationNonce, expectedTuple, null,
        observationJson, observationHash, null, canonicalBytes,
        createHash("sha256").update(canonicalBytes).digest("hex"), 1,
      );
      db.prepare(`INSERT INTO runtime_review_receipt_heads
        (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,1,?)`)
        .run(scope, receiptId, activationNonce);
      pair[`${kind}ReceiptId`] = receiptId;
    }
    return pair;
  });
}

function appendPrelaunchReceipt(db: Database.Database, input: {
  receiptId: string;
  attemptId: string;
  sourceObservation: Record<string, unknown>;
  readinessObservation: Record<string, unknown>;
}): void {
  const scope = `attempt/${input.attemptId}/prelaunch`;
  const sourceObservationHash = canonicalHash(input.sourceObservation);
  const readinessObservationHash = canonicalHash(input.readinessObservation);
  const observationJson = canonicalJson({
    source: input.sourceObservation,
    readiness: input.readinessObservation,
    sourceObservationHash,
    readinessObservationHash,
  });
  const observationHash = createHash("sha256").update(observationJson).digest("hex");
  const canonicalBytes = canonicalJson({ receiptId: input.receiptId, phase: "prelaunch", scope,
    scopeRevision: 1, activationNonce: "prelaunch-nonce", expectedTuple: { attemptId: input.attemptId },
    recoveryGeneration: null, observationHash, predecessorReceiptId: null });
  db.prepare(`INSERT INTO runtime_review_receipts
    (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
     recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
     canonical_bytes,envelope_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.receiptId, "prelaunch", scope, 1, "prelaunch-nonce",
    canonicalJson({ attemptId: input.attemptId }), null, observationJson, observationHash,
    null, canonicalBytes, createHash("sha256").update(canonicalBytes).digest("hex"), 10,
  );
  db.prepare(`INSERT INTO runtime_review_receipt_heads
    (scope,receipt_id,scope_revision,activation_nonce) VALUES (?,?,1,'prelaunch-nonce')`)
    .run(scope, input.receiptId);
}

function preparedAttempt(path: string): {
  reviews: RunGateUnitOfWork;
  authority: {
    attempt_id: string;
    authority_id: string;
    admission_source_receipt_id: string;
    admission_readiness_receipt_id: string;
  };
  sourceHash: string;
  readinessHash: string;
} {
  initializeCurrentExecutionSchema(path);
  const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
  health.recordSuccess("codex", 1);
  health.close();
  const setup = new Database(path);
  const admissionReceipts = appendInitialAdmissionReceipts(setup);
  setup.close();
  const reviews = new RunGateUnitOfWork(path);
  const create = reviews.create.bind(reviews) as unknown as
    (input: Record<string, unknown>) => unknown;
  create({ ...reviewInput, admissionReceipts });
  const db = new Database(path, { readonly: true });
  const authority = db.prepare(`SELECT a.attempt_id,a.authority_id,
      a.admission_source_receipt_id,a.admission_readiness_receipt_id
    FROM runtime_review_attempt_authorities a
    WHERE a.review_id=? AND a.agent='codex' AND a.role='auditor'`).get(reviewInput.reviewId) as {
    attempt_id: string;
    authority_id: string;
    admission_source_receipt_id: string;
    admission_readiness_receipt_id: string;
  };
  const observations = db.prepare(`SELECT receipt_id,observation_hash FROM runtime_review_receipts
    WHERE receipt_id IN (?,?) ORDER BY receipt_id`).all(
    authority.admission_source_receipt_id,
    authority.admission_readiness_receipt_id,
  ) as Array<{ receipt_id: string; observation_hash: string }>;
  db.close();
  const runs = new RunStore(path, { scope: "review" });
  const claimed = runs.claimNext({ workerId: "prelaunch-fixture", leaseMs: 10_000, now: 10 });
  runs.close();
  if (claimed?.payload?.reviewAttemptId !== authority.attempt_id) {
    throw new Error("prelaunch fixture did not claim the exact Codex auditor attempt");
  }
  return {
    reviews,
    authority,
    sourceHash: observations.find(({ receipt_id }) =>
      receipt_id === authority.admission_source_receipt_id)!.observation_hash,
    readinessHash: observations.find(({ receipt_id }) =>
      receipt_id === authority.admission_readiness_receipt_id)!.observation_hash,
  };
}

function attemptState(path: string, attemptId: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true });
  const attempt = db.prepare(`SELECT * FROM runtime_review_lane_attempts WHERE attempt_id=?`)
    .get(attemptId) as { review_id: string; agent: string; role: string; run_id: string };
  const state = {
    attempt: db.prepare(`SELECT * FROM runtime_review_lane_attempts WHERE attempt_id=?`).get(attemptId),
    lane: db.prepare(`SELECT * FROM runtime_review_lanes
      WHERE review_id=? AND agent=? AND role=?`).get(attempt.review_id, attempt.agent, attempt.role),
    run: db.prepare("SELECT * FROM runs WHERE id=?").get(attempt.run_id),
    generationConsumptions: db.prepare(`SELECT * FROM runtime_review_generation_consumptions
      WHERE review_id=? AND agent=? AND role=? ORDER BY generation`)
      .all(attempt.review_id, attempt.agent, attempt.role),
  };
  db.close();
  return state;
}

function workerPrelaunch(input: {
  databasePath: string;
  role: "leader" | "contender";
  gate: SharedArrayBuffer;
  fence: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fixtures/review-v3-activation-worker.mjs", import.meta.url), {
      workerData: { databasePath: input.databasePath, operation: "prelaunch", role: input.role,
        gate: input.gate, input: input.fence }, execArgv: ["--import", "tsx"],
    });
    worker.once("message", (message: { ok: boolean; result?: Record<string, unknown>; error?: string }) => {
      if (message.ok) resolve(message.result!);
      else reject(new Error(message.error));
    });
    worker.once("error", reject);
  });
}

function terminalWorker(input: Record<string, unknown> & {
  databasePath: string;
  gate: SharedArrayBuffer;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fixtures/review-v3-terminal-worker.mjs", import.meta.url), {
      workerData: input, execArgv: ["--import", "tsx"],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

describe("authority-v3 prelaunch fence", () => {
  it.each([1, 2] as const)("never admits authority-v%d work into the v3 prelaunch path", (version) => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    const reviewId = `legacy-prelaunch-v${version}`;
    const runId = `legacy-prelaunch-run-v${version}`;
    db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
       run_state,created_at,launch_authority_version)
      VALUES (?,?,X'01',?,?,?,?,?,?)`).run(reviewId, "stage", `hash-v${version}`,
      "workspace-read", reviewId, "DEGRADED_REVIEW_SET", version, version);
    db.prepare(`INSERT INTO runtime_review_lanes
      (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
       idempotency_key,prompt,degraded) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      reviewId, "codex", "auditor", "queued", "gpt-5.6-sol", "max", "routing-v5", "[]",
      `${reviewId}-session`, `${reviewId}-lane`, "audit");
    db.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES (?,?,?,?,?,?,?,?)`).run(runId, runId, "review:auditor", 4, "queued", version, version,
      JSON.stringify({ reviewId, reviewRole: "auditor", decision: { agent: "codex" } }));
    db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(reviewId, "codex", "auditor", 0, runId, version);
    db.close();
    const reviews = new RunGateUnitOfWork(path);
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect(method).toBeTypeOf("function");
    expect((method as (input: Record<string, unknown>) => Record<string, unknown>).call(reviews, {
      reviewId, runId, agent: "codex", role: "auditor", attemptOrdinal: 0,
      prelaunchReceiptId: "legacy-must-not-have-p", now: 10,
    })).toMatchObject({ status: "no_spawn", reason: "needs_reconciliation" });
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare("SELECT COUNT(*) FROM runtime_review_spawn_authorities").pluck().get()).toBe(0);
    expect(proof.prepare("SELECT COUNT(*) FROM runtime_review_no_spawn_effects").pluck().get()).toBe(0);
    expect(proof.prepare("SELECT COUNT(*) FROM runtime_review_receipts").pluck().get()).toBe(0);
    proof.close();
  });

  it("authorizes one spawn only when distinct prelaunch observations equal immutable admission observations", () => {
    const path = database();
    const { reviews, authority, sourceHash, readinessHash } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "prelaunch-r1", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    expect(canonicalHash({ sourceFingerprint: "source-v1", valid: true })).toBe(sourceHash);
    expect(canonicalHash({ harnessReady: true, valid: true })).toBe(readinessHash);
    db.close();

    const candidate = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect(candidate, "RunGateUnitOfWork must own the atomic prelaunch comparison").toBeTypeOf("function");
    const apply = (candidate as (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const first = apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-r1", now: 11 });
    expect(first).toMatchObject({ status: "authorized", attemptId: authority.attempt_id,
      authorityId: authority.authority_id });
    expect(apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-r1", now: 12 }))
      .toEqual(first);
    const contender = new RunGateUnitOfWork(path);
    const contenderMethod = (contender as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect(contenderMethod).toBeTypeOf("function");
    expect((contenderMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .call(contender, { attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-r1", now: 12 }))
      .toEqual(first);
    contender.close();
    reviews.close();

    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT attempt_id,attempt_authority_id,prelaunch_receipt_id
      FROM runtime_review_spawn_authorities WHERE attempt_id=?`).all(authority.attempt_id)).toEqual([{
      attempt_id: authority.attempt_id,
      attempt_authority_id: authority.authority_id,
      prelaunch_receipt_id: "prelaunch-r1",
    }]);
    reopened.close();
  });

  it("linearizes two SQLite processes contending on one current P receipt", async () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "prelaunch-race", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close(); reviews.close();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const fence = { attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-race", now: 12 };
    const [winner, replay] = await Promise.all([
      workerPrelaunch({ databasePath: path, role: "leader", gate, fence }),
      workerPrelaunch({ databasePath: path, role: "contender", gate,
        fence: { ...fence, now: 13 } }),
    ]);
    expect(winner).toMatchObject({ status: "authorized" });
    expect(replay).toEqual(winner);
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(1);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='prelaunch-race' AND state='consumed'`).pluck().get()).toBe(1);
    proof.close();
  });

  it.each([
    { label: "missing", observation: { harnessReady: false, state: "missing", valid: false } },
    { label: "invalid", observation: { harnessReady: true, state: "invalid", valid: false } },
  ])("classifies a $label readiness observation as provider_unavailable", ({ label, observation }) => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: `prelaunch-readiness-${label}`,
      attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: observation });
    db.close();
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    const result = (method as (input: Record<string, unknown>) => Record<string, unknown>)
      .call(reviews, { attemptId: authority.attempt_id,
        prelaunchReceiptId: `prelaunch-readiness-${label}`, now: 15 });
    expect(result).toMatchObject({ status: "no_spawn", reason: "provider_unavailable" });
    reviews.close();
  });

  it("uses durable health in the fence transaction when health changes after capture", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "health-race", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, state: "ready", valid: true } });
    db.close();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordFailoverFailure("codex", { kind: "model_unavailable" }, 14);
    health.close();

    const apply = reviews.applyPrelaunchFence.bind(reviews);
    const first = apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "health-race", now: 15 });
    expect(first).toMatchObject({ status: "no_spawn", reason: "provider_unavailable" });
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "health-race", now: 16 })).toEqual(first);
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(1);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    proof.close();
    reviews.close();
  });

  it("returns the committed spawn authority for a fresh equivalent P receipt and orphans it", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const firstDb = new Database(path);
    appendPrelaunchReceipt(firstDb, { receiptId: "prelaunch-winner", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    firstDb.close();
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    const apply = (method as (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const winner = apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "prelaunch-winner", now: 20 });
    const captureMethod = (reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    expect(captureMethod).toBeTypeOf("function");
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    const sourceObservationHash = canonicalHash(source);
    const readinessObservationHash = canonicalHash(readiness);
    (captureMethod as (input: Record<string, unknown>) => unknown).call(reviews, {
      receiptId: "prelaunch-replay", phase: "prelaunch",
      scope: `attempt/${authority.attempt_id}/prelaunch`, scopeRevision: 2,
      activationNonce: "prelaunch-replay", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null,
      observation: { source, readiness, sourceObservationHash, readinessObservationHash },
      predecessorReceiptId: "prelaunch-winner", createdAt: 21,
    });
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "prelaunch-replay", now: 22 })).toEqual(winner);
    reviews.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='prelaunch-replay'`).pluck().get()).toBe("orphaned");
    expect(db.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(1);
    db.close();
  });

  it("recaptures P after a crash before the prelaunch UoW and never uses the stale observation", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const captureMethod = (reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    const capture = (captureMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(reviews);
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    const observation = { source, readiness,
      sourceObservationHash: canonicalHash(source),
      readinessObservationHash: canonicalHash(readiness),
    };
    const scope = `attempt/${authority.attempt_id}/prelaunch`;
    capture({ receiptId: "prelaunch-before-crash", phase: "prelaunch", scope, scopeRevision: 1,
      activationNonce: "p-before-crash", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, observation, predecessorReceiptId: null, createdAt: 40 });
    const applyMethod = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    const apply = (applyMethod as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(reviews);
    expect(() => apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "prelaunch-before-crash", now: 41,
      faultInjector: (point: string) => {
        if (point === "before_prelaunch_begin") throw new Error("P captured then crashed");
      } })).toThrow(/captured then crashed/);
    capture({ receiptId: "prelaunch-after-restart", phase: "prelaunch", scope, scopeRevision: 2,
      activationNonce: "p-after-restart", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, observation, predecessorReceiptId: "prelaunch-before-crash", createdAt: 42 });
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "prelaunch-after-restart", now: 43 })).toMatchObject({ status: "authorized" });
    reviews.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT receipt_id,state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id IN ('prelaunch-before-crash','prelaunch-after-restart')
      ORDER BY receipt_id`).all()).toEqual([
      { receipt_id: "prelaunch-after-restart", state: "consumed" },
      { receipt_id: "prelaunch-before-crash", state: "superseded" },
    ]);
    expect(db.prepare(`SELECT prelaunch_receipt_id FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe("prelaunch-after-restart");
    db.close();
  });

  it("makes missing or conflicting prelaunch evidence non-authorizing without another generation", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path, { readonly: true });
    const spawnSql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_spawn_authorities'`).pluck().get());
    expect(spawnSql).toMatch(/attempt_id[^,]*primary key|unique\s*\(\s*attempt_id\s*\)/i);
    const noSpawnSql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_no_spawn_effects'`).pluck().get());
    expect(noSpawnSql).toMatch(/stale_artifact/);
    expect(noSpawnSql).toMatch(/provider_unavailable/);
    expect(noSpawnSql).toMatch(/needs_reconciliation/);
    db.close();
  });

  it.each([
    { variant: "source-mismatch", expected: "stale_artifact", laneStatus: "stale_artifact" },
    { variant: "readiness-mismatch", expected: "provider_unavailable", laneStatus: "deferred" },
    { variant: "missing", expected: "needs_reconciliation", laneStatus: "needs_reconciliation" },
    { variant: "orphaned", expected: "needs_reconciliation", laneStatus: "needs_reconciliation" },
  ])("applies the exact no-spawn contract for $variant", ({ variant, expected, laneStatus }) => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    if (variant !== "missing") {
      const db = new Database(path);
      appendPrelaunchReceipt(db, { receiptId: `prelaunch-${variant}`, attemptId: authority.attempt_id,
        sourceObservation: { sourceFingerprint: variant === "source-mismatch" ? "source-v2" : "source-v1",
          valid: true },
        readinessObservation: { harnessReady: variant !== "readiness-mismatch", valid: true } });
      if (variant === "orphaned") {
        db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
          (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
           recovery_generation,predecessor_receipt_id,recorded_at)
          SELECT receipt_id,'orphaned',scope_revision,activation_nonce,expected_tuple_json,
                 recovery_generation,predecessor_receipt_id,20
          FROM runtime_review_receipts WHERE receipt_id=?`).run(`prelaunch-${variant}`);
      }
      db.close();
    }
    const before = attemptState(path, authority.attempt_id);
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect(method).toBeTypeOf("function");
    const result = (method as (input: Record<string, unknown>) => Record<string, unknown>)
      .call(reviews, { attemptId: authority.attempt_id,
        prelaunchReceiptId: variant === "missing" ? "absent" : `prelaunch-${variant}`, now: 21 });
    expect(result).toMatchObject({ status: "no_spawn", reason: expected, attemptId: authority.attempt_id });
    reviews.close();
    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    expect(reopened.prepare(`SELECT reason FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id))
      .toBe(variant === "missing" || variant === "orphaned" ? undefined : expected);
    reopened.close();
    const after = attemptState(path, authority.attempt_id);
    expect(after.attempt).toEqual(before.attempt);
    expect(after.generationConsumptions).toEqual(before.generationConsumptions);
    if (variant === "readiness-mismatch") {
      expect(after.run).toMatchObject({
        status: "completed",
        launched: 0,
        worker_id: null,
        lease_token: null,
        lease_expires_at: null,
      });
      const envelope = JSON.parse(String((after.run as { result: string }).result)) as {
        domainEffect: string;
        providerResult: { kind: string; admissionFenceReceipt: { attemptClaimed: boolean } };
      };
      expect(envelope).toMatchObject({
        domainEffect: "applied",
        providerResult: {
          kind: "model_unavailable",
          admissionFenceReceipt: { attemptClaimed: false },
        },
      });
    } else {
      expect(after.run).toEqual(before.run);
    }
    if (variant === "missing" || variant === "orphaned") {
      expect(after.lane).toEqual(before.lane);
    } else {
      expect(after.lane).toMatchObject({ status: laneStatus });
    }
    const countDb = new Database(path, { readonly: true });
    expect(countDb.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
      WHERE review_id='prelaunch-v3'`).pluck().get()).toBe(2);
    expect(countDb.prepare(`SELECT COUNT(*) FROM runs WHERE payload LIKE '%prelaunch-v3%'`)
      .pluck().get()).toBe(2);
    countDb.close();
  });

  it.each([
    "after_prelaunch_receipt_read",
    "after_prelaunch_decision",
    "after_spawn_authority_insert",
    "before_prelaunch_commit",
  ])("rolls back prelaunch authority at %s", (faultPoint) => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "prelaunch-fault", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close();
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect(method).toBeTypeOf("function");
    expect(() => (method as (input: Record<string, unknown>) => unknown).call(reviews, {
      attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-fault", now: 30,
      faultInjector: (point: string) => {
        if (point === faultPoint) throw new Error(`injected prelaunch fault: ${faultPoint}`);
      },
    })).toThrow(/injected prelaunch fault/i);
    reviews.close();
    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare("SELECT COUNT(*) FROM runtime_review_spawn_authorities").pluck().get()).toBe(0);
    expect(reopened.prepare("SELECT COUNT(*) FROM runtime_review_no_spawn_effects").pluck().get()).toBe(0);
    expect(reopened.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='prelaunch-fault'`).pluck().get()).toBe(0);
    reopened.close();
  });

  it("fails closed on a conflicting or noncontiguous prelaunch receipt chain", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "prelaunch-corrupt", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.exec(`DROP TRIGGER IF EXISTS runtime_review_receipt_update_immutable;
      PRAGMA ignore_check_constraints=ON;`);
    db.prepare(`UPDATE runtime_review_receipts SET scope_revision=3,
      predecessor_receipt_id='missing-revision-2' WHERE receipt_id='prelaunch-corrupt'`).run();
    db.close();
    const method = (reviews as unknown as Record<string, unknown>).applyPrelaunchFence;
    expect((method as (input: Record<string, unknown>) => Record<string, unknown>).call(reviews, {
      attemptId: authority.attempt_id, prelaunchReceiptId: "prelaunch-corrupt", now: 50,
    })).toMatchObject({ status: "no_spawn", reason: "needs_reconciliation" });
    reviews.close();
  });

  it("makes a committed no-spawn decision terminal, replay-idempotent, and exclusive with spawn", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const setup = new Database(path);
    appendPrelaunchReceipt(setup, { receiptId: "terminal-no-spawn", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: false, valid: true } });
    setup.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const first = apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "terminal-no-spawn", now: 60 });
    expect(first).toMatchObject({ status: "no_spawn", reason: "provider_unavailable" });
    const before = attemptState(path, authority.attempt_id);
    const proofBefore = new Database(path, { readonly: true });
    const effectBefore = proofBefore.prepare(`SELECT * FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).get(authority.attempt_id);
    const lifecycleBefore = proofBefore.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='terminal-no-spawn'`).get();
    proofBefore.close();

    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "terminal-no-spawn", now: 61 })).toEqual(first);
    expect(attemptState(path, authority.attempt_id)).toEqual(before);

    const capture = ((reviews as unknown as Record<string, unknown>).captureReviewReceipt as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    capture({ receiptId: "terminal-valid-successor", phase: "prelaunch",
      scope: `attempt/${authority.attempt_id}/prelaunch`, scopeRevision: 2,
      activationNonce: "terminal-successor", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, predecessorReceiptId: "terminal-no-spawn", createdAt: 62,
      observation: { source, readiness,
        sourceObservationHash: canonicalHash(source),
        readinessObservationHash: canonicalHash(readiness) },
    });
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "terminal-valid-successor", now: 63 })).toEqual(first);
    expect(attemptState(path, authority.attempt_id)).toEqual(before);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT * FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).get(authority.attempt_id)).toEqual(effectBefore);
    expect(proof.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='terminal-no-spawn'`).get()).toEqual(lifecycleBefore);
    expect(lifecycleBefore).toMatchObject({ state: "consumed" });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_heads
      WHERE scope=?`).pluck().get(`attempt/${authority.attempt_id}/prelaunch`)).toBe(0);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    expect(proof.prepare(`SELECT state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='terminal-valid-successor'`).pluck().get()).toBe("orphaned");
    proof.close();
  });

  it("preserves a foreign P byte-for-byte after committed spawn replay rejection", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "foreign-original", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "foreign-original", now: 110 })).toMatchObject({ status: "authorized" });
    const foreignDb = new Database(path);
    appendPrelaunchReceipt(foreignDb, { receiptId: "foreign-p", attemptId: "other-attempt",
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    const before = JSON.stringify({
      receipt: foreignDb.prepare("SELECT * FROM runtime_review_receipts WHERE receipt_id='foreign-p'").get(),
      head: foreignDb.prepare(`SELECT * FROM runtime_review_receipt_heads
        WHERE scope='attempt/other-attempt/prelaunch'`).get(),
      lifecycle: foreignDb.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
        WHERE receipt_id='foreign-p'`).get(),
    });
    foreignDb.close();
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "foreign-p", now: 111 })).toMatchObject({ status: "no_spawn" });
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(JSON.stringify({
      receipt: proof.prepare("SELECT * FROM runtime_review_receipts WHERE receipt_id='foreign-p'").get(),
      head: proof.prepare(`SELECT * FROM runtime_review_receipt_heads
        WHERE scope='attempt/other-attempt/prelaunch'`).get(),
      lifecycle: proof.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
        WHERE receipt_id='foreign-p'`).get(),
    })).toBe(before);
    proof.close();
  });

  it("reconciles a committed spawn whose immutable attempt authority was corrupted", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "corrupt-authority-p", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "corrupt-authority-p", now: 120 })).toMatchObject({ status: "authorized" });
    const corrupt = new Database(path);
    corrupt.exec("DROP TRIGGER runtime_review_authority_update_immutable");
    corrupt.prepare(`UPDATE runtime_review_attempt_authorities SET authority_hash=?
      WHERE authority_id=?`).run("0".repeat(64), authority.authority_id);
    corrupt.close();
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "corrupt-authority-p", now: 121 }))
      .toMatchObject({ status: "no_spawn", reason: "needs_reconciliation" });
    reviews.close();
  });

  it("rolls back postcommit successor orphaning and head removal together", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "orphan-original", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "orphan-original", now: 130 })).toMatchObject({ status: "authorized" });
    const capture = ((reviews as unknown as Record<string, unknown>).captureReviewReceipt as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    capture({ receiptId: "orphan-successor", phase: "prelaunch",
      scope: `attempt/${authority.attempt_id}/prelaunch`, scopeRevision: 2,
      activationNonce: "orphan-successor", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, predecessorReceiptId: "orphan-original", createdAt: 131,
      observation: { source, readiness,
        sourceObservationHash: canonicalHash(source),
        readinessObservationHash: canonicalHash(readiness) },
    });
    expect(() => apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "orphan-successor", now: 132,
      faultInjector: (point: string) => {
        if (point === "after_replay_orphan_insert") throw new Error("orphan rollback fault");
      } })).toThrow(/orphan rollback fault/);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='orphan-successor'`).pluck().get()).toBe(0);
    expect(proof.prepare(`SELECT receipt_id FROM runtime_review_receipt_heads
      WHERE scope=?`).pluck().get(`attempt/${authority.attempt_id}/prelaunch`))
      .toBe("orphan-successor");
    proof.close();
  });

  it("linearizes opposite terminal effects across two SQLite workers", async () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    reviews.close();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const common = { databasePath: path, operation: "terminal_insert", gate,
      attemptId: authority.attempt_id, authorityId: authority.authority_id,
      authorityHash: "a".repeat(64), receiptId: "terminal-race", now: 140 };
    const results = await Promise.all([
      terminalWorker({ ...common, kind: "spawn" }),
      terminalWorker({ ...common, kind: "no_spawn" }),
    ]);
    expect(results.filter(({ ok }) => ok === true)).toHaveLength(1);
    expect(results.filter(({ ok }) => ok === false)).toHaveLength(1);
    expect(String(results.find(({ ok }) => ok === false)?.error))
      .toMatch(/terminal|spawn|no.spawn|exclusive/i);
    const proof = new Database(path, { readonly: true });
    const spawn = Number(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id));
    const noSpawn = Number(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id));
    expect(spawn + noSpawn).toBe(1);
    proof.close();
  });

  it("linearizes two distinct fresh postcommit recaptures through one receipt head", async () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "postcommit-original", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    const tuple = db.prepare(`SELECT a.review_id,a.run_id,a.agent,a.role,a.attempt_ordinal
      FROM runtime_review_lane_attempts a WHERE a.attempt_id=?`).get(authority.attempt_id) as
      { review_id: string; run_id: string; agent: string; role: string; attempt_ordinal: number };
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const committed = apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "postcommit-original", reviewId: tuple.review_id, runId: tuple.run_id,
      agent: tuple.agent, role: tuple.role, attemptOrdinal: tuple.attempt_ordinal, now: 150 });
    expect(committed).toMatchObject({ status: "authorized" });
    reviews.close();
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    const observation = { source, readiness,
      sourceObservationHash: canonicalHash(source),
      readinessObservationHash: canonicalHash(readiness) };
    const scope = `attempt/${authority.attempt_id}/prelaunch`;
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const result = await Promise.all(["fresh-a", "fresh-b"].map((receiptId, index) =>
      terminalWorker({ databasePath: path, operation: "capture_apply", gate,
        capture: { receiptId, phase: "prelaunch", scope, scopeRevision: 2,
          activationNonce: receiptId, expectedTuple: { attemptId: authority.attempt_id },
          recoveryGeneration: null, observation, predecessorReceiptId: "postcommit-original",
          createdAt: 151 + index },
        fence: { attemptId: authority.attempt_id, prelaunchReceiptId: receiptId,
          reviewId: tuple.review_id, runId: tuple.run_id, agent: tuple.agent, role: tuple.role,
          attemptOrdinal: tuple.attempt_ordinal, now: 153 + index },
      })));
    expect(result.filter(({ ok }) => ok === true)).toHaveLength(2);
    expect(result.filter(({ result: outcome }) =>
      (outcome as Record<string, unknown>)?.status === "authorized")).toHaveLength(1);
    expect(result.filter(({ result: outcome }) =>
      (outcome as Record<string, unknown>)?.status === "no_spawn")).toHaveLength(1);
    expect(result.find(({ result: outcome }) =>
      (outcome as Record<string, unknown>)?.status === "authorized")?.result)
      .toMatchObject(committed);
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id IN ('fresh-a','fresh-b') AND state='orphaned'`).pluck().get()).toBe(2);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=? AND attempt_authority_id=?`).pluck()
      .get(authority.attempt_id, authority.authority_id)).toBe(1);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_heads
      WHERE scope=?`).pluck().get(scope)).toBe(0);
    proof.close();
  });

  it.each(["original-envelope", "full-predecessor-chain"])(
    "rejects committed replay after %s corruption without rewriting immutable evidence",
    (variant) => {
      const path = database();
      const { reviews, authority } = preparedAttempt(path);
      const capture = ((reviews as unknown as Record<string, unknown>).captureReviewReceipt as
        (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
      const source = { sourceFingerprint: "source-v1", valid: true };
      const readiness = { harnessReady: true, valid: true };
      const observation = { source, readiness,
        sourceObservationHash: canonicalHash(source),
        readinessObservationHash: canonicalHash(readiness) };
      const scope = `attempt/${authority.attempt_id}/prelaunch`;
      capture({ receiptId: "chain-r1", phase: "prelaunch", scope, scopeRevision: 1,
        activationNonce: "chain-r1", expectedTuple: { attemptId: authority.attempt_id },
        recoveryGeneration: null, observation, predecessorReceiptId: null, createdAt: 160 });
      capture({ receiptId: "chain-r2", phase: "prelaunch", scope, scopeRevision: 2,
        activationNonce: "chain-r2", expectedTuple: { attemptId: authority.attempt_id },
        recoveryGeneration: null, observation, predecessorReceiptId: "chain-r1", createdAt: 161 });
      const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
        (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
      expect(apply({ attemptId: authority.attempt_id,
        prelaunchReceiptId: "chain-r2", now: 162 })).toMatchObject({ status: "authorized" });
      const corrupt = new Database(path);
      corrupt.exec(`DROP TRIGGER runtime_review_receipt_update_immutable;
        DROP TRIGGER runtime_review_receipt_lifecycle_update_immutable;`);
      if (variant === "original-envelope") {
        corrupt.prepare(`UPDATE runtime_review_receipts SET envelope_hash=?
          WHERE receipt_id='chain-r2'`).run("0".repeat(64));
      } else {
        corrupt.prepare(`UPDATE runtime_review_receipts SET envelope_hash=?
          WHERE receipt_id='chain-r1'`).run("1".repeat(64));
        corrupt.prepare(`UPDATE runtime_review_receipt_lifecycle SET predecessor_receipt_id='missing'
          WHERE receipt_id='chain-r2'`).run();
      }
      const immutableBefore = JSON.stringify({
        receipts: corrupt.prepare(`SELECT * FROM runtime_review_receipts
          WHERE receipt_id IN ('chain-r1','chain-r2') ORDER BY receipt_id`).all(),
        lifecycle: corrupt.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
          WHERE receipt_id IN ('chain-r1','chain-r2') ORDER BY receipt_id`).all(),
      });
      corrupt.close();
      expect(apply({ attemptId: authority.attempt_id,
        prelaunchReceiptId: "chain-r2", now: 163 }))
        .toMatchObject({ status: "no_spawn", reason: "needs_reconciliation" });
      reviews.close();
      const proof = new Database(path, { readonly: true });
      expect(JSON.stringify({
        receipts: proof.prepare(`SELECT * FROM runtime_review_receipts
          WHERE receipt_id IN ('chain-r1','chain-r2') ORDER BY receipt_id`).all(),
        lifecycle: proof.prepare(`SELECT * FROM runtime_review_receipt_lifecycle
          WHERE receipt_id IN ('chain-r1','chain-r2') ORDER BY receipt_id`).all(),
      })).toBe(immutableBefore);
      proof.close();
    },
  );

  it("enforces spawn XOR no-spawn and terminal immutability at the schema boundary", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    reviews.close();
    const db = new Database(path);
    db.prepare(`INSERT INTO runtime_review_no_spawn_effects
      (attempt_id,reason,recorded_at) VALUES (?,'needs_reconciliation',70)`)
      .run(authority.attempt_id);
    expect(() => db.prepare(`INSERT INTO runtime_review_spawn_authorities
      (attempt_id,attempt_authority_id,prelaunch_receipt_id,authority_hash,created_at)
      VALUES (?,?,?,?,71)`).run(authority.attempt_id, authority.authority_id,
        "foreign", "f".repeat(64))).toThrow(/terminal|spawn|no.spawn|exclusive/i);
    expect(() => db.prepare(`UPDATE runtime_review_no_spawn_effects SET recorded_at=72
      WHERE attempt_id=?`).run(authority.attempt_id)).toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).run(authority.attempt_id)).toThrow(/immutable/i);
    db.close();

    const reversePath = database();
    const reverse = preparedAttempt(reversePath);
    const reverseDb = new Database(reversePath);
    reverseDb.prepare(`INSERT INTO runtime_review_spawn_authorities
      (attempt_id,attempt_authority_id,prelaunch_receipt_id,authority_hash,created_at)
      VALUES (?,?,?,?,73)`).run(reverse.authority.attempt_id, reverse.authority.authority_id,
        "spawn-first", "a".repeat(64));
    expect(() => reverseDb.prepare(`INSERT INTO runtime_review_no_spawn_effects
      (attempt_id,reason,recorded_at) VALUES (?,'needs_reconciliation',74)`)
      .run(reverse.authority.attempt_id)).toThrow(/terminal|spawn|no.spawn|exclusive/i);
    expect(() => reverseDb.prepare(`UPDATE runtime_review_spawn_authorities SET created_at=75
      WHERE attempt_id=?`).run(reverse.authority.attempt_id)).toThrow(/immutable/i);
    expect(() => reverseDb.prepare(`DELETE FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).run(reverse.authority.attempt_id)).toThrow(/immutable/i);
    reverseDb.close();
    reverse.reviews.close();
  });

  it("rolls back a no-spawn effect and lane projection at the terminal decision failpoint", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "no-spawn-fault", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: false, valid: true } });
    db.close();
    const before = attemptState(path, authority.attempt_id);
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(() => apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "no-spawn-fault",
      now: 76, faultInjector: (point: string) => {
        if (point === "after_no_spawn_effect_insert") throw new Error("no-spawn insert fault");
      } })).toThrow(/no-spawn insert fault/);
    expect(attemptState(path, authority.attempt_id)).toEqual(before);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_receipt_lifecycle
      WHERE receipt_id='no-spawn-fault'`).pluck().get()).toBe(0);
    proof.close();
  });

  it("does not let a stale invalid P commit no-spawn after a valid successor became current", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "stale-invalid", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: false, valid: true } });
    db.close();
    const capture = ((reviews as unknown as Record<string, unknown>).captureReviewReceipt as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    const source = { sourceFingerprint: "source-v1", valid: true };
    const readiness = { harnessReady: true, valid: true };
    capture({ receiptId: "current-valid", phase: "prelaunch",
      scope: `attempt/${authority.attempt_id}/prelaunch`, scopeRevision: 2,
      activationNonce: "current-valid", expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, predecessorReceiptId: "stale-invalid", createdAt: 77,
      observation: { source, readiness,
        sourceObservationHash: canonicalHash(source),
        readinessObservationHash: canonicalHash(readiness) },
    });
    const before = attemptState(path, authority.attempt_id);
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: "stale-invalid", now: 78 })).toMatchObject({ status: "no_spawn" });
    expect(attemptState(path, authority.attempt_id)).toEqual(before);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    proof.close();
  });

  it("does not return a committed spawn authority for missing or cross-tuple replay evidence", () => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "committed-original", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    const tuple = db.prepare(`SELECT a.review_id,a.run_id,a.agent,a.role,a.attempt_ordinal
      FROM runtime_review_lane_attempts a WHERE a.attempt_id=?`).get(authority.attempt_id) as
      { review_id: string; run_id: string; agent: string; role: string; attempt_ordinal: number };
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "committed-original",
      reviewId: tuple.review_id, runId: tuple.run_id, agent: tuple.agent, role: tuple.role,
      attemptOrdinal: tuple.attempt_ordinal, now: 80 })).toMatchObject({ status: "authorized" });
    expect(apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "missing-after-commit",
      reviewId: tuple.review_id, runId: tuple.run_id, agent: tuple.agent, role: tuple.role,
      attemptOrdinal: tuple.attempt_ordinal, now: 81 })).toMatchObject({ status: "no_spawn" });
    expect(apply({ attemptId: authority.attempt_id, prelaunchReceiptId: "committed-original",
      reviewId: tuple.review_id, runId: tuple.run_id, agent: tuple.agent, role: "critic",
      attemptOrdinal: tuple.attempt_ordinal, now: 82 })).toMatchObject({ status: "no_spawn" });
    reviews.close();
  });

  it.each([
    ["attemptId", (input: Record<string, unknown>) => { input.attemptId = "foreign-attempt"; }],
    ["reviewId", (input: Record<string, unknown>) => { input.reviewId = "foreign-review"; }],
    ["runId", (input: Record<string, unknown>) => { input.runId = "foreign-run"; }],
    ["agent", (input: Record<string, unknown>) => { input.agent = "grok"; }],
    ["role", (input: Record<string, unknown>) => { input.role = "critic"; }],
    ["attemptOrdinal", (input: Record<string, unknown>) => { input.attemptOrdinal = 99; }],
  ] as const)("rejects a prelaunch %s mismatch with zero durable mutation", (_field, mutate) => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: "tuple-p", attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    const tuple = db.prepare(`SELECT a.review_id,a.run_id,a.agent,a.role,a.attempt_ordinal
      FROM runtime_review_lane_attempts a WHERE a.attempt_id=?`).get(authority.attempt_id) as
      { review_id: string; run_id: string; agent: string; role: string; attempt_ordinal: number };
    const immutableBefore = JSON.stringify({
      receipt: db.prepare("SELECT * FROM runtime_review_receipts WHERE receipt_id='tuple-p'").get(),
      head: db.prepare(`SELECT * FROM runtime_review_receipt_heads
        WHERE scope=?`).get(`attempt/${authority.attempt_id}/prelaunch`),
      effect: db.prepare(`SELECT * FROM runtime_review_no_spawn_effects
        WHERE attempt_id=?`).get(authority.attempt_id),
      spawn: db.prepare(`SELECT * FROM runtime_review_spawn_authorities
        WHERE attempt_id=?`).get(authority.attempt_id),
    });
    db.close();
    const before = attemptState(path, authority.attempt_id);
    const input: Record<string, unknown> = { attemptId: authority.attempt_id,
      prelaunchReceiptId: "tuple-p", reviewId: tuple.review_id, runId: tuple.run_id,
      agent: tuple.agent, role: tuple.role, attemptOrdinal: tuple.attempt_ordinal, now: 90 };
    mutate(input);
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply(input)).toMatchObject({ status: "no_spawn", reason: "needs_reconciliation" });
    expect(attemptState(path, authority.attempt_id)).toEqual(before);
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(JSON.stringify({
      receipt: proof.prepare("SELECT * FROM runtime_review_receipts WHERE receipt_id='tuple-p'").get(),
      head: proof.prepare(`SELECT * FROM runtime_review_receipt_heads
        WHERE scope=?`).get(`attempt/${authority.attempt_id}/prelaunch`),
      effect: proof.prepare(`SELECT * FROM runtime_review_no_spawn_effects
        WHERE attempt_id=?`).get(authority.attempt_id),
      spawn: proof.prepare(`SELECT * FROM runtime_review_spawn_authorities
        WHERE attempt_id=?`).get(authority.attempt_id),
    })).toBe(immutableBefore);
    proof.close();
  });

  it.each([
    { label: "stale source", source: { sourceFingerprint: "source-v2", valid: true },
      readiness: { harnessReady: true, valid: true } },
    { label: "unavailable readiness", source: { sourceFingerprint: "source-v1", valid: true },
      readiness: { harnessReady: false, valid: true } },
  ])("does not replay committed spawn for a current $label successor", ({ label, source, readiness }) => {
    const path = database();
    const { reviews, authority } = preparedAttempt(path);
    const db = new Database(path);
    appendPrelaunchReceipt(db, { receiptId: `original-${label}`, attemptId: authority.attempt_id,
      sourceObservation: { sourceFingerprint: "source-v1", valid: true },
      readinessObservation: { harnessReady: true, valid: true } });
    db.close();
    const apply = ((reviews as unknown as Record<string, unknown>).applyPrelaunchFence as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: `original-${label}`, now: 100 })).toMatchObject({ status: "authorized" });
    const capture = ((reviews as unknown as Record<string, unknown>).captureReviewReceipt as
      (input: Record<string, unknown>) => Record<string, unknown>).bind(reviews);
    capture({ receiptId: `successor-${label}`, phase: "prelaunch",
      scope: `attempt/${authority.attempt_id}/prelaunch`, scopeRevision: 2,
      activationNonce: `successor-${label}`, expectedTuple: { attemptId: authority.attempt_id },
      recoveryGeneration: null, predecessorReceiptId: `original-${label}`, createdAt: 101,
      observation: { source, readiness,
        sourceObservationHash: canonicalHash(source),
        readinessObservationHash: canonicalHash(readiness) },
    });
    expect(apply({ attemptId: authority.attempt_id,
      prelaunchReceiptId: `successor-${label}`, now: 102 })).toMatchObject({ status: "no_spawn" });
    reviews.close();
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id=?`).pluck().get(`successor-${label}`)).toBe("orphaned");
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(0);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(authority.attempt_id)).toBe(1);
    proof.close();
  });
});
