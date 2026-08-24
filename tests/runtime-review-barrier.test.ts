import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { ReviewBarrierStore } from "../src/runtime/review-barrier-store.js";

const roots: string[] = [];
const database = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-"));
  roots.push(root);
  return join(root, "state.db");
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const artifact = Buffer.from("immutable runtime review packet", "utf8");
const artifactHash = createHash("sha256").update(artifact).digest("hex");
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
  createdAt: 100,
};

const attemptIdFor = (
  store: ReviewBarrierStore,
  agent: "grok" | "codex",
  role: "auditor" | "critic",
): string => store.attempts(input.reviewId, agent, role).at(-1)!.attemptId;

describe("runtime durable review barrier", () => {
  it("rejects v1 review tables instead of mutating them in the constructor", () => {
    const path = database();
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

    expect(() => new ReviewBarrierStore(path)).toThrow(/offline v1-to-v3 migration/i);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_review_lanes'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("migrates a routing-v2 review database without relabeling historical decisions", () => {
    const path = database();
    const source = new ReviewBarrierStore(path);
    source.create({ ...input, health: { grok: "healthy", codex: "healthy" } });
    source.close();

    const schema = new Database(path);
    schema.unsafeMode(true);
    schema.pragma("writable_schema = ON");
    schema.prepare(`
      UPDATE sqlite_master
         SET sql = replace(sql, '''routing-v3''', '''routing-v2''')
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
    legacy.prepare("UPDATE runtime_review_lane_attempts SET policy_version = 'routing-v2'").run();
    legacy.close();

    const migrated = new ReviewBarrierStore(path);
    const historical = migrated.get(input.reviewId)!;
    expect(historical.lanes).toHaveLength(4);
    expect(historical.lanes.every((lane) => String(lane.policyVersion) === "routing-v2")).toBe(true);
    expect(historical.lanes.flatMap((lane) => lane.attempts)
      .every((attempt) => String(attempt.policyVersion) === "routing-v2")).toBe(true);
    expect(historical.lanes.every((lane) => lane.status === "failed")).toBe(true);
    expect(historical.lanes.flatMap((lane) => lane.attempts)
      .every((attempt) => attempt.status === "needs_reconciliation")).toBe(true);
    expect(migrated.enqueueDescriptors(input.reviewId)).toEqual([]);

    const next = migrated.create({
      ...input,
      reviewId: "review-runtime-v3",
      idempotencyKey: "review-runtime-v3:artifact",
      health: { grok: "healthy", codex: "healthy" },
    });
    expect(next.lanes.every((lane) => String(lane.policyVersion) === "routing-v3")).toBe(true);
    migrated.close();

    const verified = new Database(path, { readonly: true });
    const versions = verified.prepare(`
      SELECT policy_version AS version, count(*) AS count
        FROM runtime_review_lanes
       GROUP BY policy_version
       ORDER BY policy_version
    `).all();
    expect(versions).toEqual([
      { version: "routing-v2", count: 4 },
      { version: "routing-v3", count: 4 },
    ]);
    const tableSql = (verified.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_review_lanes'
    `).get() as { sql: string }).sql;
    expect(tableSql).toContain("'routing-v2'");
    expect(tableSql).toContain("'routing-v3'");
    verified.close();
  });

  it("rolls back a corrupt routing-v2 migration and rejects every reopen", () => {
    const path = database();
    const source = new ReviewBarrierStore(path);
    source.create({ ...input, health: { grok: "healthy", codex: "healthy" } });
    source.close();

    const schema = new Database(path);
    schema.unsafeMode(true);
    schema.pragma("writable_schema = ON");
    schema.prepare(`
      UPDATE sqlite_master
         SET sql = replace(sql, '''routing-v3''', '''routing-v2''')
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
    corrupt.prepare("UPDATE runtime_review_lane_attempts SET policy_version = 'routing-v2'").run();
    corrupt.prepare("DELETE FROM runtime_review_barriers WHERE review_id = ?").run(input.reviewId);
    corrupt.close();

    expect(() => new ReviewBarrierStore(path)).toThrow(/foreign key|integrity/i);
    expect(() => new ReviewBarrierStore(path)).toThrow(/foreign key|integrity/i);

    const unchanged = new Database(path, { readonly: true });
    const tableSql = (unchanged.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_review_lanes'
    `).get() as { sql: string }).sql;
    expect(tableSql).toContain("'routing-v2'");
    expect(tableSql).not.toContain("'routing-v3'");
    unchanged.close();
  });

  it("persists exact four full-review lanes over copied bytes and exposes enqueue descriptors", () => {
    const store = new ReviewBarrierStore(database());
    const source = Buffer.from(artifact);
    const review = store.create({
      ...input,
      artifact: source,
      health: { grok: "healthy", codex: "healthy" },
    });
    source.fill(0);

    expect(review.runState).toBe("FULL_CROSS_PROVIDER");
    expect(review.artifactHash).toBe(artifactHash);
    expect(review.artifact).toEqual(artifact);
    expect(review.lanes).toHaveLength(4);
    expect(review.lanes.map((lane) => `${lane.agent}:${lane.role}:${lane.status}`)).toEqual([
      "grok:auditor:queued",
      "grok:critic:queued",
      "codex:auditor:queued",
      "codex:critic:queued",
    ]);

    const descriptors = store.enqueueDescriptors(input.reviewId);
    expect(descriptors).toHaveLength(4);
    expect(new Set(descriptors.map((lane) => lane.sessionId)).size).toBe(4);
    expect(new Set(descriptors.map((lane) => lane.idempotencyKey)).size).toBe(4);
    expect(descriptors.every((lane) => lane.artifactHash === artifactHash)).toBe(true);
    expect(descriptors.every((lane) => lane.artifact.equals(artifact))).toBe(true);
    expect(descriptors.map(({ agent, role, model, effort, policyVersion, reasons }) => ({
      agent, role, model, effort, policyVersion, reasons,
    }))).toEqual([
      { agent: "grok", role: "auditor", model: "grok-4.6", effort: "high", policyVersion: "routing-v3", reasons: ["stage_baseline:code_audit:high"] },
      { agent: "grok", role: "critic", model: "grok-4.6", effort: "xhigh", policyVersion: "routing-v3", reasons: ["stage_baseline:code_critic:xhigh"] },
      { agent: "codex", role: "auditor", model: "gpt-5.6-sol", effort: "high", policyVersion: "routing-v3", reasons: ["stage_baseline:code_audit:high"] },
      { agent: "codex", role: "critic", model: "gpt-5.6-sol", effort: "xhigh", policyVersion: "routing-v3", reasons: ["stage_baseline:code_critic:xhigh"] },
    ]);
    descriptors[0]!.artifact.fill(1);
    expect(store.enqueueDescriptors(input.reviewId)[0]!.artifact).toEqual(artifact);
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: false,
      terminalCount: 0,
      requiredCount: 4,
    });
    store.close();
  });

  it("is idempotent across reopen but rejects a conflicting immutable artifact", () => {
    const path = database();
    const first = new ReviewBarrierStore(path);
    const created = first.create({
      ...input,
      health: { grok: "healthy", codex: "healthy" },
    });
    first.close();

    const reopened = new ReviewBarrierStore(path);
    const same = reopened.create({
      ...input,
      artifact: Buffer.from(artifact),
      health: { grok: "unavailable", codex: "healthy" },
    });
    expect(same).toEqual(created);
    expect(() =>
      reopened.create({
        ...input,
        artifact: Buffer.from("changed bytes"),
        health: { grok: "healthy", codex: "healthy" },
      }),
    ).toThrow(/immutable review conflict/i);
    reopened.close();
  });

  it("durably records mixed terminal states and opens the barrier only after all four", () => {
    const path = database();
    const store = new ReviewBarrierStore(path);
    store.create({ ...input, health: { grok: "healthy", codex: "healthy" } });

    store.recordTerminal({
      reviewId: input.reviewId,
      agent: "grok",
      role: "auditor",
      attemptId: attemptIdFor(store, "grok", "auditor"),
      status: "completed",
      result: { verdict: "pass" },
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
      result: { verdict: "request_changes" },
      terminalAt: 203,
    });
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: true,
      terminalCount: 4,
      requiredCount: 4,
    });
    store.close();

    const reopened = new ReviewBarrierStore(path);
    expect(reopened.get(input.reviewId)?.lanes.map(({ status }) => status).sort()).toEqual([
      "completed",
      "completed",
      "failed",
      "timed_out",
    ]);
    expect(reopened.recordTerminal({
      reviewId: input.reviewId,
      agent: "codex",
      role: "critic",
      attemptId: attemptIdFor(reopened, "codex", "critic"),
      status: "completed",
      result: { verdict: "request_changes" },
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

  it("creates two active and two deferred lanes, activating deferred only after provider cooldown", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.canAttempt("grok", 0)).toBe(true);
    health.recordFailoverFailure("grok", { kind: "quota" }, 100);
    health.recordSuccess("codex", 100);

    const store = new ReviewBarrierStore(path);
    const review = store.create({
      ...input,
      health: { grok: "unavailable", codex: "healthy" },
    });
    expect(review.runState).toBe("DEGRADED_SINGLE_PROVIDER");
    expect(review.lanes.map((lane) => `${lane.agent}:${lane.role}:${lane.status}`)).toEqual([
      "grok:auditor:deferred",
      "grok:critic:deferred",
      "codex:auditor:queued",
      "codex:critic:queued",
    ]);
    expect(store.enqueueDescriptors(input.reviewId).map((lane) => lane.agent)).toEqual([
      "codex",
      "codex",
    ]);

    expect(store.activateDeferred({
      reviewId: input.reviewId,
      agent: "grok",
      currentArtifactHash: artifactHash,
      now: 1_099,
      providerHealth: health,
    })).toEqual({ status: "provider_unavailable", lanes: [] });
    const activated = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "grok",
      currentArtifactHash: artifactHash,
      now: 1_100,
      providerHealth: health,
    });
    expect(activated.status).toBe("activated");
    expect(activated.lanes.map((lane) => `${lane.agent}:${lane.role}`).sort()).toEqual([
      "grok:auditor",
      "grok:critic",
    ]);
    expect(health.get("grok").attemptClaimed).toBe(false);
    expect(store.activateDeferred({ reviewId: input.reviewId, agent: "grok", currentArtifactHash: artifactHash,
      now: 1_100, providerHealth: health }).status).toBe("activated");
    expect(store.confirmDeferredEnqueued(input.reviewId, "grok")).toBe(2);
    expect(store.enqueueDescriptors(input.reviewId)).toHaveLength(4);
    expect(store.activateDeferred({
      reviewId: input.reviewId,
      agent: "grok",
      currentArtifactHash: artifactHash,
      now: 1_100,
      providerHealth: health,
    })).toEqual({ status: "none", lanes: [] });

    store.close();
    health.close();
  });

  it("preserves the failed review attempt and creates a new adaptive decision after recovery", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    health.recordSuccess("codex", 1);
    const store = new ReviewBarrierStore(path);
    store.create({ ...input, health: { grok: "healthy", codex: "healthy" } });
    const initial = store.enqueueDescriptors(input.reviewId)
      .find((lane) => lane.agent === "grok" && lane.role === "auditor")!;

    const deferred = store.recordProviderUnavailable({
      reviewId: input.reviewId,
      agent: "grok",
      role: "auditor",
      attemptId: initial.attemptId,
      error: { kind: "quota" },
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
      agent: "grok",
      role: "auditor",
      attemptId: initial.attemptId,
      error: { kind: "quota" },
      terminalAt: 100,
    }).attempts).toHaveLength(1);

    health.recordSuccess("grok", 1_100);
    const activated = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "grok",
      currentArtifactHash: artifactHash,
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
    expect(store.attempts(input.reviewId, "grok", "auditor")).toHaveLength(2);
    expect(() => store.recordTerminal({
      reviewId: input.reviewId,
      agent: "grok",
      role: "auditor",
      attemptId: initial.attemptId,
      status: "completed",
      result: { verdict: "late" },
      terminalAt: 1_101,
    })).toThrow(/active attempt/i);
    expect(store.attempts(input.reviewId, "grok", "auditor").at(-1)?.status).toBe("scheduled");
    expect(store.activateDeferred({ reviewId: input.reviewId, agent: "grok",
      currentArtifactHash: artifactHash, now: 1_101, providerHealth: health }).lanes
      .find((lane) => lane.role === "auditor")?.attemptId).toBe(retry.attemptId);
    store.close();
    health.close();
  });

  it("marks deferred lanes stale on artifact drift without consuming a provider probe", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.canAttempt("grok", 0)).toBe(true);
    health.recordFailoverFailure("grok", { kind: "model_unavailable" }, 100);
    health.recordSuccess("codex", 100);
    const store = new ReviewBarrierStore(path);
    store.create({ ...input, health: { grok: "unavailable", codex: "healthy" } });

    const stale = store.activateDeferred({
      reviewId: input.reviewId,
      agent: "grok",
      currentArtifactHash: createHash("sha256").update("new artifact").digest("hex"),
      now: 1_100,
      providerHealth: health,
    });
    expect(stale.status).toBe("stale_artifact");
    expect(stale.lanes).toHaveLength(0);
    expect(health.snapshot().grok).toMatchObject({
      health: "unavailable",
      retryAt: 1_100,
      attemptClaimed: false,
    });

    for (const role of ["auditor", "critic"] as const) {
      store.recordTerminal({
        reviewId: input.reviewId,
        agent: "codex",
        role,
        attemptId: attemptIdFor(store, "codex", role),
        status: "completed",
        result: { role },
        terminalAt: 1_101,
      });
    }
    expect(store.get(input.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
      .every((lane) => lane.status === "stale_artifact")).toBe(true);
    expect(store.barrier(input.reviewId)).toEqual({
      satisfied: true,
      terminalCount: 4,
      requiredCount: 4,
    });

    store.close();
    health.close();
  });

  it("makes a post-launch unknown attempt explicit and resolves it only by exact attempt id", () => {
    const store = new ReviewBarrierStore(database());
    store.create({ ...input, health: { grok: "healthy", codex: "healthy" } });
    const attemptId = attemptIdFor(store, "grok", "auditor");
    expect(store.markAttemptNeedsReconciliation({ reviewId: input.reviewId, agent: "grok",
      role: "auditor", attemptId, at: 200 }).status).toBe("needs_reconciliation");
    expect(store.barrier(input.reviewId).satisfied).toBe(false);
    expect(() => store.resolveAttemptReconciliation({ reviewId: input.reviewId, agent: "grok",
      role: "auditor", attemptId: `${attemptId}:stale`, status: "completed",
      evidence: { verdict: "pass" }, at: 201 })).toThrow(/not awaiting reconciliation/i);
    expect(store.resolveAttemptReconciliation({ reviewId: input.reviewId, agent: "grok",
      role: "auditor", attemptId, status: "completed", evidence: { verdict: "pass" }, at: 202 }).status)
      .toBe("completed");
    store.close();
  });

  it("marks deferred lanes stale when the source workspace fingerprint changed", () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.canAttempt("grok", 0); health.recordFailoverFailure("grok", { kind: "quota" }, 100);
    health.recordSuccess("codex", 100);
    const store = new ReviewBarrierStore(path);
    store.create({ ...input, sourceFingerprint: "workspace-v1", health: { grok: "unavailable", codex: "healthy" } });
    expect(store.activateDeferred({ reviewId: input.reviewId, agent: "grok", currentArtifactHash: artifactHash,
      currentSourceFingerprint: "workspace-v2", now: 1_100, providerHealth: health })).toEqual({ status: "stale_artifact", lanes: [] });
    expect(health.get("grok").attemptClaimed).toBe(false);
    store.close(); health.close();
  });
});
