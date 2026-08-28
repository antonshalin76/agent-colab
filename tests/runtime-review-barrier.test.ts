import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { createReviewRunInput, RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { RunStore } from "../src/store/run-store.js";
import { formatMapLearningLaunchBindingContext } from "../src/flow/map-admin.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

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
  const runs = new RunStore(path);
  const descriptor = store.enqueueDescriptors(review.reviewId).find(
    (candidate) => candidate.agent === agent && candidate.role === role,
  )!;
  const queued = runs.enqueueExact(createReviewRunInput(descriptor));
  const claimed = runs.claimNext({ workerId: "review-test", leaseMs: 1_000, now: Date.now() + 1_000 })!;
  runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent });
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

describe("runtime durable review barrier", () => {
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
    source.create({ ...input, health: healthyReviewProviders });
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
    source.create({ ...input, health: healthyReviewProviders });
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
    const review = store.create({
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
      requiredCount: 6,
    });
    const runs = new RunStore(path);
    expect(runs.list()).toHaveLength(6);
    runs.close();
    store.close();
  });

  it("is idempotent across reopen but rejects a conflicting immutable artifact", () => {
    const path = database();
    const first = new RunGateUnitOfWork(path);
    const created = first.create({
      ...input,
      health: healthyReviewProviders,
    });
    first.close();

    const reopened = new RunGateUnitOfWork(path);
    const same = reopened.create({
      ...input,
      artifact: Buffer.from(artifact),
      health: { ...healthyReviewProviders, grok: "unavailable" },
    });
    expect(same).toEqual(created);
    expect(() =>
      reopened.create({
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

    expect(() => store.create({
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
    store.create({ ...input, health: healthyReviewProviders });

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
      terminalCount: 6,
      requiredCount: 6,
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
    store.create({ ...input, health: healthyReviewProviders });
    const blockedAgent = "grok" as const;
    const blockedRole = "auditor" as const;
    for (const agent of ["grok", "claude", "codex"] as const) {
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
      terminalCount: 6,
      requiredCount: 6,
    });
    store.close();
  });

  it("opens the semantic barrier only when every required lane completes with PASS", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, health: healthyReviewProviders });
    for (const agent of ["grok", "claude", "codex"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        completeLaneWithEvidence(path, store, agent, role);
      }
    }
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: true,
      terminalCount: 6,
      requiredCount: 6,
    });
    store.close();
  });

  it("rejects completed runner rows whose payload is not the exact canonical review packet", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, health: healthyReviewProviders });
    for (const agent of ["grok", "claude", "codex"] as const) {
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
    store.create({ ...input, health: healthyReviewProviders });
    for (const agent of ["grok", "claude", "codex"] as const) {
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
    expect(health.canAttempt("claude", 0)).toBe(true);
    health.recordFailoverFailure("claude", { kind: "quota" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);

    const store = new RunGateUnitOfWork(path);
    const project = process.cwd();
    const sourceFingerprint = captureWorkspaceFingerprint(project).fingerprint;
    const review = store.create({
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
    for (const agent of ["grok", "codex"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        completeLaneWithEvidence(path, store, agent, role);
      }
    }
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 4,
      requiredCount: 6,
    });
    const competing = new RunGateUnitOfWork(path);

    expect(store.activateDeferred({
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_099,
      providerHealth: health,
    })).toEqual({ status: "provider_unavailable", lanes: [] });
    const activated = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes.map((lane) => `${lane.agent}:${lane.role}`)).toEqual([
      "claude:auditor",
    ]);
    for (const lane of activated.lanes) {
      const run = createReviewRunInput(lane);
      expect(run.payload.mapLearning.consumer).toBe("claude");
      const context = formatMapLearningLaunchBindingContext(run.payload.mapLearning);
      expect(run.payload.prompt.split(context)).toHaveLength(2);
    }
    expect(health.get("claude").attemptClaimed).toBe(true);
    expect(competing.activateDeferred({ reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: sourceFingerprint, now: 1_100, providerHealth: health }).status).toBe("provider_unavailable");
    expect(store.enqueueDescriptors(input.reviewId)).toHaveLength(1);
    expect(store.activateDeferred({
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
    })).toEqual({ status: "provider_unavailable", lanes: [] });

    store.close();
    competing.close();
    health.close();
  });

  it("preserves the failed review attempt and creates a new adaptive decision after recovery", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    health.recordSuccess("claude", 1);
    health.recordSuccess("codex", 1);
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, health: healthyReviewProviders });
    const initial = store.enqueueDescriptors(input.reviewId)
      .find((lane) => lane.agent === "claude" && lane.role === "auditor")!;
    const attemptRuns = new RunStore(path);
    let claimedInitial = attemptRuns.claimNext({ workerId: "provider-unavailable", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    while (claimedInitial.idempotencyKey !== initial.idempotencyKey) {
      attemptRuns.releaseForRetry(claimedInitial.id, claimedInitial.leaseToken!, {
        nextAttemptAt: Date.now() + 60_000,
      });
      claimedInitial = attemptRuns.claimNext({ workerId: "provider-unavailable", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
    }
    expect(claimedInitial.idempotencyKey).toBe(initial.idempotencyKey);
    attemptRuns.markLaunchIntent(claimedInitial.id, claimedInitial.leaseToken!, { agent: "claude" });
    attemptRuns.markLaunched(claimedInitial.id, claimedInitial.leaseToken!, { pid: 1234 });
    attemptRuns.commitDomainEffect({
      id: claimedInitial.id,
      token: claimedInitial.leaseToken!,
      providerResult: { kind: "quota", agent: "claude" },
      effect: { type: "review", reviewId: input.reviewId, attemptId: initial.attemptId,
        role: "auditor", agent: "claude", resultKind: "quota", terminalAt: 100 },
      status: "completed",
    });
    attemptRuns.close();

    const deferred = store.recordProviderUnavailable({
      reviewId: input.reviewId,
      agent: "claude",
      role: "auditor",
      attemptId: initial.attemptId,
      error: { kind: "quota", agent: "claude" },
      terminalAt: 100,
    });
    expect(deferred.status).toBe("deferred");
    expect(deferred.attempts).toEqual([
      expect.objectContaining({
        attemptId: initial.attemptId,
        attemptOrdinal: 0,
        status: "provider_unavailable",
        effort: "high",
        reasons: ["stage_baseline:code_audit:high"],
      }),
    ]);
    expect(store.recordProviderUnavailable({
      reviewId: input.reviewId,
      agent: "claude",
      role: "auditor",
      attemptId: initial.attemptId,
      error: { kind: "quota", agent: "claude" },
      terminalAt: 100,
    }).attempts).toHaveLength(1);

    health.recordSuccess("claude", 1_100);
    const activated = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
    });
    const retry = activated.lanes.find((lane) => lane.role === "auditor")!;
    expect(retry).toMatchObject({
      attemptOrdinal: 1,
      effort: "xhigh",
      reasons: ["stage_baseline:code_audit:high", "retry"],
    });
    expect(retry.attemptId).not.toBe(initial.attemptId);
    expect(retry.sessionId).not.toBe(initial.sessionId);
    expect(retry.idempotencyKey).not.toBe(initial.idempotencyKey);
    expect(store.attempts(input.reviewId, "claude", "auditor")).toHaveLength(2);
    expect(store.recordProviderUnavailable({
      reviewId: input.reviewId,
      agent: "claude",
      role: "auditor",
      attemptId: initial.attemptId,
      error: { kind: "quota", agent: "claude" },
      terminalAt: 100,
    }).status).toBe("queued");
    expect(store.attempts(input.reviewId, "claude", "auditor")).toHaveLength(2);
    expect(() => store.recordTerminal({
      reviewId: input.reviewId,
      agent: "claude",
      role: "auditor",
      attemptId: initial.attemptId,
      status: "completed",
      result: { verdict: "late" },
      terminalAt: 1_101,
    })).toThrow(/active attempt/i);
    expect(store.attempts(input.reviewId, "claude", "auditor").at(-1)?.status).toBe("scheduled");
    expect(store.activateDeferred({ reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_101, providerHealth: health })).toEqual({ status: "none", lanes: [] });
    expect(store.enqueueDescriptors(input.reviewId)
      .find((lane) => lane.agent === "claude" && lane.role === "auditor")?.attemptId)
      .toBe(retry.attemptId);
    store.close();
    health.close();
  });

  it("activates against the immutable persisted artifact without a caller-supplied hash", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.canAttempt("claude", 0)).toBe(true);
    health.recordFailoverFailure("claude", { kind: "model_unavailable" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, health: { ...healthyReviewProviders, claude: "unavailable" } });

    const activated = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "claude",
      currentSourceFingerprint: sourceFingerprint,
      now: 1_100,
      providerHealth: health,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes).toHaveLength(1);
    expect(store.get(input.reviewId)?.artifactHash).toBe(artifactHash);

    store.close();
    health.close();
  });

  it("makes a post-launch unknown attempt explicit and resolves it only by exact attempt id", () => {
    const path = database();
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, health: healthyReviewProviders });
    const attemptId = attemptIdFor(store, "grok", "auditor");
    const runs = new RunStore(path);
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
  });

  it("marks deferred lanes stale when the source workspace fingerprint changed", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.canAttempt("claude", 0); health.recordFailoverFailure("claude", { kind: "quota" }, 100, 0);
    health.recordSuccess("grok", 100);
    health.recordSuccess("codex", 100);
    const store = new RunGateUnitOfWork(path);
    store.create({ ...input, sourceFingerprint: "workspace-v1", health: { ...healthyReviewProviders, claude: "unavailable" } });
    expect(store.activateDeferred({ reviewId: input.reviewId, agent: "claude",
      currentSourceFingerprint: "workspace-v2", now: 1_100, providerHealth: health })).toEqual({ status: "stale_artifact", lanes: [] });
    expect(health.get("claude").attemptClaimed).toBe(false);
    store.close(); health.close();
  });
});
