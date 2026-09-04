import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];

function makeDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-only-store-"));
  roots.push(root);
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function insertLinkedReview(input: {
  database: Database.Database;
  reviewId: string;
  runId: string;
  role?: "auditor" | "critic";
  priority?: number;
  authorityVersion?: 1 | 2;
}): void {
  const role = input.role ?? "auditor";
  const authorityVersion = input.authorityVersion ?? 2;
  input.database.prepare(`INSERT INTO runtime_review_barriers
    (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
     run_state,created_at,launch_authority_version)
    VALUES (?,?,X'01',?,?,?,?,?,?)`).run(
    input.reviewId,
    "stg04",
    `${input.reviewId}-hash`,
    "workspace-read",
    `${input.reviewId}-barrier-key`,
    "DEGRADED_REVIEW_SET",
    1,
    authorityVersion,
  );
  input.database.prepare(`INSERT INTO runtime_review_lanes
    (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
     idempotency_key,prompt,degraded)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`).run(
    input.reviewId,
    "codex",
    role,
    "queued",
    "gpt-5.6-sol",
    "max",
    "routing-v5",
    "[]",
    `${input.reviewId}-session`,
    `${input.reviewId}-lane-key`,
    "review",
  );
  input.database.prepare(`INSERT INTO runs
    (id,idempotency_key,stage,priority,status,artifact_hash,approval_scope,
     created_at,next_attempt_at,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    input.runId,
    `${input.reviewId}-run-key`,
    `review:${role}`,
    input.priority ?? 10,
    "queued",
    `${input.reviewId}-hash`,
    "workspace-read",
    1,
    1,
    JSON.stringify({
      reviewId: input.reviewId,
      reviewRole: role,
      artifactHash: `${input.reviewId}-hash`,
      approvalScope: "workspace-read",
      decision: { agent: "codex" },
    }),
  );
  input.database.prepare(`INSERT INTO runtime_review_lane_attempts
    (review_id,agent,role,attempt_ordinal,run_id,created_at)
    VALUES (?,?,?,?,?,?)`).run(input.reviewId, "codex", role, 0, input.runId, 1);
}

function rawRun(database: Database.Database, id: string): Record<string, unknown> {
  return database.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown>;
}

describe("review-only run store scope", () => {
  it("rejects an invalid runtime scope instead of silently widening authority", () => {
    const path = makeDatabase();
    expect(() => new RunStore(path, { scope: "workflow" as "review" }))
      .toThrow(/scope is invalid/i);
  });

  it("claims only an exactly linked review while preserving workflow rows and review authority checks", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES ('workflow-run','workflow-key','coding',-100,'queued',0,0,'{"prompt":"code"}'),
             ('unlinked-review','unlinked-review-key','review:auditor',-75,'queued',0,0,
              '{"reviewId":"missing-link","reviewRole":"auditor","decision":{"agent":"codex"}}')`).run();
    insertLinkedReview({ database: setup, reviewId: "invalid-v1", runId: "invalid-v1-run",
      priority: -50, authorityVersion: 1 });
    insertLinkedReview({ database: setup, reviewId: "valid-v2", runId: "valid-v2-run",
      priority: 10, authorityVersion: 2 });
    const workflowBefore = rawRun(setup, "workflow-run");
    const unlinkedBefore = rawRun(setup, "unlinked-review");
    const invalidBefore = rawRun(setup, "invalid-v1-run");
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    expect(reviews.claimNext({ workerId: "review-only", leaseMs: 1_000, now: 10 })?.id)
      .toBe("valid-v2-run");
    reviews.close();

    const proof = new Database(path, { readonly: true });
    expect(rawRun(proof, "workflow-run")).toEqual(workflowBefore);
    expect(rawRun(proof, "unlinked-review")).toEqual(unlinkedBefore);
    expect(rawRun(proof, "invalid-v1-run")).toEqual(invalidBefore);
    proof.close();
  });

  it("recovers only exactly linked reviews across pre-launch and ambiguous-launch crash windows", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    insertLinkedReview({ database: setup, reviewId: "review-before-launch",
      runId: "review-before-launch-run" });
    insertLinkedReview({ database: setup, reviewId: "review-after-launch",
      runId: "review-after-launch-run", role: "critic" });
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES ('workflow-before-launch','workflow-before-key','coding',0,'claimed',0,0,'{}'),
             ('workflow-after-launch','workflow-after-key','testing',0,'claimed',0,0,'{}')`).run();
    setup.prepare(`UPDATE runs SET status='claimed',lease_token=id || '-lease',
      lease_expires_at=5,worker_id='old-worker',launched=0
      WHERE id IN ('review-before-launch-run','workflow-before-launch')`).run();
    setup.prepare(`UPDATE runs SET status='claimed',lease_token=id || '-lease',
      lease_expires_at=5,worker_id='old-worker',launched=1,launch_info='{"phase":"started"}'
      WHERE id IN ('review-after-launch-run','workflow-after-launch')`).run();
    const workflowBeforeLaunch = rawRun(setup, "workflow-before-launch");
    const workflowAfterLaunch = rawRun(setup, "workflow-after-launch");
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    expect(reviews.recoverExpired(10)).toBe(2);
    reviews.close();

    const proof = new Database(path, { readonly: true });
    expect(rawRun(proof, "workflow-before-launch")).toEqual(workflowBeforeLaunch);
    expect(rawRun(proof, "workflow-after-launch")).toEqual(workflowAfterLaunch);
    expect(rawRun(proof, "review-before-launch-run")).toMatchObject({
      status: "needs_reconciliation",
      lease_token: null,
      lease_expires_at: null,
      worker_id: null,
    });
    expect(rawRun(proof, "review-after-launch-run")).toMatchObject({
      status: "needs_reconciliation",
      lease_token: null,
      lease_expires_at: null,
      worker_id: null,
    });
    proof.close();
  });

  it("keeps the existing all-work scope as the constructor default", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES ('workflow-default','workflow-default-key','coding',0,'queued',0,0,'{}')`).run();
    setup.close();

    const allWork = new RunStore(path);
    expect(allWork.claimNext({ workerId: "default-worker", leaseMs: 1_000, now: 10 })?.id)
      .toBe("workflow-default");
    allWork.close();
  });

  it("hides ordinary and unlinked runs from every review-scoped read", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    insertLinkedReview({ database: setup, reviewId: "visible-review", runId: "visible-review-run" });
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload)
      VALUES ('hidden-workflow','hidden-workflow-key','coding',0,'queued',0,0,'{}'),
             ('hidden-unlinked-review','hidden-unlinked-review-key','review:critic',0,'queued',0,0,'{}')`).run();
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    expect(reviews.get("visible-review-run")?.id).toBe("visible-review-run");
    expect(reviews.get("hidden-workflow")).toBeUndefined();
    expect(reviews.getByIdempotencyKey("visible-review-run-key")?.id).toBe("visible-review-run");
    expect(reviews.getByIdempotencyKey("hidden-workflow-key")).toBeUndefined();
    expect(reviews.getByIdempotencyKey("hidden-unlinked-review-key")).toBeUndefined();
    expect(reviews.list().map((run) => run.id)).toEqual(["visible-review-run"]);
    reviews.close();

    const allWork = new RunStore(path);
    expect(allWork.get("hidden-workflow")?.id).toBe("hidden-workflow");
    expect(allWork.getByIdempotencyKey("hidden-unlinked-review-key")?.id)
      .toBe("hidden-unlinked-review");
    expect(allWork.list().map((run) => run.id).sort()).toEqual([
      "hidden-unlinked-review",
      "hidden-workflow",
      "visible-review-run",
    ]);
    allWork.close();
  });

  it("exposes only linked review work to reconciliation and domain-effect replay queries", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    insertLinkedReview({ database: setup, reviewId: "review-effect", runId: "review-effect-run" });
    insertLinkedReview({ database: setup, reviewId: "review-reconciliation",
      runId: "review-reconciliation-run", role: "critic" });
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload,result)
      VALUES ('workflow-effect','workflow-effect-key','coding',0,'completed',0,0,'{}',
                '{"domainEffect":"pending","providerResult":{},"effect":{}}'),
             ('workflow-reconciliation','workflow-reconciliation-key','testing',0,
                'needs_reconciliation',0,0,'{}',NULL)`).run();
    setup.prepare(`UPDATE runs SET status='completed',
      result='{"domainEffect":"pending","providerResult":{},"effect":{}}'
      WHERE id='review-effect-run'`).run();
    setup.prepare(`UPDATE runs SET status='needs_reconciliation'
      WHERE id='review-reconciliation-run'`).run();
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    expect(reviews.pendingDomainEffects(10).map((run) => run.id)).toEqual(["review-effect-run"]);
    expect(reviews.needsReconciliation().map((run) => run.id))
      .toEqual(["review-reconciliation-run"]);
    reviews.close();

    const allWork = new RunStore(path);
    expect(allWork.pendingDomainEffects(10).map((run) => run.id).sort()).toEqual([
      "review-effect-run",
      "workflow-effect",
    ]);
    expect(allWork.needsReconciliation().map((run) => run.id).sort()).toEqual([
      "review-reconciliation-run",
      "workflow-reconciliation",
    ]);
    allWork.close();
  });

  it("rejects every generic queue mutation without changing ordinary or unlinked rows", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload,
       lease_token,lease_expires_at,worker_id,launched,launch_info,result)
      VALUES
        ('ordinary-claimed','ordinary-claimed-key','coding',0,'claimed',0,0,'{}',
          'ordinary-token',100,'workflow-worker',0,NULL,NULL),
        ('ordinary-queued','ordinary-queued-key','planning',0,'queued',0,0,'{}',
          NULL,NULL,NULL,0,NULL,NULL),
        ('unlinked-review','unlinked-review-key','review:auditor',0,'queued',0,0,
          '{"reviewId":"unlinked","reviewRole":"auditor","decision":{"agent":"codex"}}',
          NULL,NULL,NULL,0,NULL,NULL),
        ('ordinary-effect','ordinary-effect-key','testing',0,'completed',0,0,'{}',
          NULL,NULL,NULL,0,NULL,
          '{"domainEffect":"applying","providerResult":{},"effect":{},"replayLease":{"owner":"owner","expiresAt":100}}'),
        ('ordinary-reconciliation','ordinary-reconciliation-key','testing',0,
          'needs_reconciliation',0,0,'{}',NULL,NULL,NULL,1,
          '{"phase":"started"}',NULL)`).run();
    const before = setup.prepare("SELECT * FROM runs ORDER BY id").all();
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    const operations: Array<() => unknown> = [
      () => reviews.enqueue({ idempotencyKey: "forbidden-enqueue", stage: "review:auditor",
        priority: 1 }),
      () => reviews.enqueueExact({ idempotencyKey: "forbidden-enqueue-exact",
        stage: "review:critic", priority: 1 }),
      () => reviews.cancel("ordinary-queued", "forbidden"),
      () => reviews.cancel("unlinked-review", "forbidden"),
      () => reviews.reconcileClaimedReviewIdentity(
        "ordinary-claimed", "ordinary-token", "forbidden",
      ),
      () => reviews.releaseForRetry("ordinary-claimed", "ordinary-token", {
        nextAttemptAt: 200,
      }),
      () => reviews.markLaunchIntent("ordinary-claimed", "ordinary-token", { agent: "codex" }),
      () => reviews.clearLaunchIntent("ordinary-claimed", "ordinary-token"),
      () => reviews.markLaunched("ordinary-claimed", "ordinary-token", { pid: 123 }),
      () => reviews.recordExecutionContext(
        "ordinary-claimed", "ordinary-token", { traceId: "forbidden" },
      ),
      () => reviews.renewLease("ordinary-claimed", "ordinary-token", 200),
      () => reviews.complete("ordinary-claimed", "ordinary-token", { kind: "success" }),
      () => reviews.persistResult("ordinary-claimed", "ordinary-token", { kind: "success" }),
      () => reviews.fail("ordinary-claimed", "ordinary-token", { kind: "task_failure" }),
      () => reviews.commitDomainEffect({
        id: "ordinary-claimed",
        token: "ordinary-token",
        providerResult: { kind: "success" },
        effect: { type: "workflow" },
        status: "completed",
      }),
      () => reviews.markNeedsReconciliation(
        "ordinary-claimed", "ordinary-token", new Error("forbidden"),
      ),
      () => reviews.claimDomainEffect("ordinary-effect", {
        owner: "owner", now: 1, leaseMs: 100,
      }),
      () => reviews.markDomainEffectApplied("ordinary-effect", "owner"),
      () => reviews.releaseDomainEffectClaim("ordinary-effect", "owner", new Error("forbidden")),
      () => reviews.quarantineDomainEffect("ordinary-effect", "owner", new Error("forbidden")),
      () => reviews.resolveReconciliation({
        id: "ordinary-reconciliation",
        providerResult: { kind: "success" },
        effect: { type: "workflow" },
        status: "completed",
      }),
    ];
    for (const operation of operations) expect(operation).toThrow(/review scope/i);
    reviews.close();

    const proof = new Database(path, { readonly: true });
    expect(proof.prepare("SELECT * FROM runs ORDER BY id").all()).toEqual(before);
    expect(proof.prepare(`SELECT COUNT(*) FROM runs
      WHERE idempotency_key IN ('forbidden-enqueue','forbidden-enqueue-exact')`).pluck().get())
      .toBe(0);
    proof.close();
  });

  it("treats a linked run with a mismatched review tuple as outside the capability", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    insertLinkedReview({ database: setup, reviewId: "tuple-mismatch", runId: "tuple-run" });
    setup.prepare(`UPDATE runs SET stage='review:critic',status='claimed',
      lease_token='tuple-token',lease_expires_at=1,worker_id='old-worker'
      WHERE id='tuple-run'`).run();
    const before = rawRun(setup, "tuple-run");
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    expect(reviews.get("tuple-run")).toBeUndefined();
    expect(() => reviews.renewLease("tuple-run", "tuple-token", 100)).toThrow(/review scope/i);
    expect(() => reviews.markNeedsReconciliation(
      "tuple-run", "tuple-token", new Error("forbidden"),
    )).toThrow(/review scope/i);
    expect(reviews.recoverExpired(10)).toBe(0);
    reviews.close();

    const proof = new Database(path, { readonly: true });
    expect(rawRun(proof, "tuple-run")).toEqual(before);
    proof.close();
  });

  it("does not let a linked review failure cascade into ordinary workflow descendants", () => {
    const path = makeDatabase();
    const setup = new Database(path);
    insertLinkedReview({ database: setup, reviewId: "direct-failure", runId: "direct-review",
      priority: 1 });
    insertLinkedReview({ database: setup, reviewId: "effect-failure", runId: "effect-review",
      role: "critic", priority: 2 });
    setup.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,payload,depends_on_run_id)
      VALUES ('direct-workflow-child','direct-workflow-child-key','coding',10,'queued',2,2,'{}',
                'direct-review'),
             ('effect-workflow-child','effect-workflow-child-key','testing',10,'queued',2,2,'{}',
                'effect-review')`).run();
    setup.close();

    const reviews = new RunStore(path, { scope: "review" });
    const direct = reviews.claimNext({ workerId: "review-worker", leaseMs: 1_000, now: 10 })!;
    expect(direct.id).toBe("direct-review");
    reviews.fail(direct.id, direct.leaseToken!, { kind: "task_failure" });
    const effect = reviews.claimNext({ workerId: "review-worker", leaseMs: 1_000, now: 11 })!;
    expect(effect.id).toBe("effect-review");
    reviews.commitDomainEffect({
      id: effect.id,
      token: effect.leaseToken!,
      providerResult: { kind: "task_failure" },
      effect: { type: "review" },
      status: "failed",
    });
    reviews.close();

    const proof = new Database(path, { readonly: true });
    expect(rawRun(proof, "direct-review").status).toBe("failed");
    expect(rawRun(proof, "effect-review").status).toBe("failed");
    expect(rawRun(proof, "direct-workflow-child")).toMatchObject({
      status: "queued",
      cancel_reason: null,
    });
    expect(rawRun(proof, "effect-workflow-child")).toMatchObject({
      status: "queued",
      cancel_reason: null,
    });
    proof.close();
  });
});
