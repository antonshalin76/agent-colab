import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeLeaseStore } from "../src/worktree/lease-store.js";

const roots: string[] = [];
const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-lease-"));
  roots.push(root);
  return join(root, "leases.db");
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const worktreePath = "/repo/worktrees/task-42";
const exactHandoffEvidence = {
  checkpoint: {
    artifactHash: "artifact-sha-42",
    headSha: "head-sha-42",
    diffHash: "diff-sha-42",
    changedFiles: ["src/domain/workflow.ts", "tests/workflow.test.ts"],
    testEvidence: [{ command: "npm test -- tests/workflow.test.ts", exitCode: 0 }],
    sourceSessionId: "grok-session-42",
    approvals: [
      {
        approvalId: "approval-read-42",
        grantedBy: "user",
        scope: "workspace-read",
        grantedAt: 1_756_000_000_000,
      },
    ],
    nextAction: {
      kind: "continue_stage",
      stageId: "coding-42",
      instruction: "Continue TDD from the verified checkpoint without widening scope",
    },
  },
  approvalScope: "workspace-read",
  idempotencyKey: "task-42:coding-42:artifact-sha-42",
};

describe("BDD-6A persistent worktree lease store", () => {
  it("rejects a v1 lease schema instead of migrating it in the constructor", () => {
    const path = makeDb();
    const db = new Database(path);
    db.exec(`CREATE TABLE worktree_leases (
      worktree_path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      holder TEXT NOT NULL CHECK (holder IN ('claude', 'codex')),
      fencing_token INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    db.close();

    expect(() => new WorktreeLeaseStore(path)).toThrow(/offline v1-to-v2 migration/i);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_handoffs'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("persists the active lease and fencing token across store restart", async () => {
    const db = makeDb();
    const first = new WorktreeLeaseStore(db);
    const acquired = await first.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "grok",
      now: 100,
      ttlMs: 30_000,
    });
    expect(acquired).toMatchObject({
      status: "acquired",
      lease: {
        worktreePath,
        taskId: "task-42",
        holder: "grok",
        fencingToken: 1,
        expiresAt: 30_100,
      },
    });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    first.close();

    const restored = new WorktreeLeaseStore(db);
    expect(await restored.get(worktreePath)).toEqual(acquired.lease);
    restored.close();
  });

  it("reuses only the exact persisted pre-launch lease identity", async () => {
    const store = new WorktreeLeaseStore(makeDb());
    const acquired = await store.acquire({ worktreePath, taskId: "task-42", holder: "grok",
      now: 100, ttlMs: 30_000 });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    await expect(store.reuse({ lease: acquired.lease, taskId: "task-42", holder: "grok",
      now: 200, ttlMs: 30_000 })).resolves.toEqual({ status: "acquired",
      lease: { ...acquired.lease, expiresAt: 30_200 } });
    await expect(store.reuse({ lease: { ...acquired.lease, fencingToken: 99 }, taskId: "task-42",
      holder: "grok", now: 300, ttlMs: 30_000 })).resolves.toMatchObject({
      status: "contended", currentLease: { fencingToken: acquired.lease.fencingToken },
    });
    store.close();
  });

  it("uses atomic CAS so two contenders cannot both acquire the same worktree", async () => {
    const db = makeDb();
    const grokStore = new WorktreeLeaseStore(db);
    const codexStore = new WorktreeLeaseStore(db);

    const results = await Promise.all([
      grokStore.acquire({
        worktreePath,
        taskId: "task-42",
        holder: "grok",
        now: 100,
        ttlMs: 30_000,
      }),
      codexStore.acquire({
        worktreePath,
        taskId: "task-42",
        holder: "codex",
        now: 100,
        ttlMs: 30_000,
      }),
    ]);

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "contended")).toHaveLength(1);
    expect(
      new Set(
        results.map((result) =>
          result.status === "acquired" ? result.lease.leaseId : result.currentLease.leaseId,
        ),
      ).size,
    ).toBe(1);

    grokStore.close();
    codexStore.close();
  });

  it("transfers by lease-id/token CAS, increments the fence, and persists exact handoff evidence", async () => {
    const db = makeDb();
    const store = new WorktreeLeaseStore(db);
    const acquired = await store.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "grok",
      now: 100,
      ttlMs: 30_000,
    });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    const original = acquired.lease;

    const transferred = await store.transfer({
      worktreePath,
      expectedLeaseId: original.leaseId,
      expectedFencingToken: original.fencingToken,
      from: "grok",
      to: "codex",
      now: 200,
      ttlMs: 30_000,
      evidence: exactHandoffEvidence,
    });

    expect(transferred).toEqual({
      status: "transferred",
      lease: {
        ...original,
        holder: "codex",
        fencingToken: original.fencingToken + 1,
        expiresAt: 30_200,
      },
      handoff: {
        from: "grok",
        to: "codex",
        previousLeaseId: original.leaseId,
        fencingToken: original.fencingToken + 1,
        evidence: exactHandoffEvidence,
        recordedAt: 200,
      },
    });
    if (transferred.status !== "transferred") throw new Error("expected lease transfer");
    store.close();

    const restored = new WorktreeLeaseStore(db);
    expect(await restored.get(worktreePath)).toEqual(transferred.lease);
    expect(await restored.listHandoffs("task-42")).toEqual([transferred.handoff]);
    restored.close();
  });

  it("fences stale holders from renew, release, and a second transfer", async () => {
    const store = new WorktreeLeaseStore(makeDb());
    const acquired = await store.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "grok",
      now: 100,
      ttlMs: 30_000,
    });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    const stale = acquired.lease;
    await store.transfer({
      worktreePath,
      expectedLeaseId: stale.leaseId,
      expectedFencingToken: stale.fencingToken,
      from: "grok",
      to: "codex",
      now: 200,
      ttlMs: 30_000,
      evidence: exactHandoffEvidence,
    });

    await expect(
      store.renew({
        worktreePath,
        leaseId: stale.leaseId,
        fencingToken: stale.fencingToken,
        holder: "grok",
        now: 300,
        ttlMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "fenced", currentFencingToken: stale.fencingToken + 1 });
    await expect(
      store.release({
        worktreePath,
        leaseId: stale.leaseId,
        fencingToken: stale.fencingToken,
        holder: "grok",
      }),
    ).resolves.toMatchObject({ status: "fenced", currentFencingToken: stale.fencingToken + 1 });
    await expect(
      store.transfer({
        worktreePath,
        expectedLeaseId: stale.leaseId,
        expectedFencingToken: stale.fencingToken,
        from: "grok",
        to: "codex",
        now: 400,
        ttlMs: 30_000,
        evidence: exactHandoffEvidence,
      }),
    ).resolves.toMatchObject({ status: "fenced", currentFencingToken: stale.fencingToken + 1 });

    store.close();
  });
});
