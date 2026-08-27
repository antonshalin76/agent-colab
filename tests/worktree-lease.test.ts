import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("routing-v5 persistent worktree lease store", () => {
  it("rejects a v1 lease schema instead of mutating it in the constructor", () => {
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
    expect(() => new WorktreeLeaseStore(path)).toThrow(/offline routing-v5 migration/i);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_handoffs'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("persists the Codex lease and fencing token across store restart", async () => {
    const path = makeDb();
    const first = new WorktreeLeaseStore(path);
    const acquired = await first.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "codex",
      now: 100,
      ttlMs: 30_000,
    });
    expect(acquired).toMatchObject({
      status: "acquired",
      lease: { holder: "codex", fencingToken: 1, expiresAt: 30_100 },
    });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    first.close();
    const restored = new WorktreeLeaseStore(path);
    expect(await restored.get(worktreePath)).toEqual(acquired.lease);
    restored.close();
  });

  it("reuses only the exact persisted Codex lease identity", async () => {
    const store = new WorktreeLeaseStore(makeDb());
    const acquired = await store.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "codex",
      now: 100,
      ttlMs: 30_000,
    });
    if (acquired.status !== "acquired") throw new Error("expected lease acquisition");
    await expect(store.reuse({
      lease: acquired.lease,
      taskId: "task-42",
      holder: "codex",
      now: 200,
      ttlMs: 30_000,
    })).resolves.toEqual({
      status: "acquired",
      lease: { ...acquired.lease, expiresAt: 30_200 },
    });
    await expect(store.reuse({
      lease: { ...acquired.lease, fencingToken: 99 },
      taskId: "task-42",
      holder: "codex",
      now: 300,
      ttlMs: 30_000,
    })).resolves.toMatchObject({
      status: "contended",
      currentLease: { fencingToken: acquired.lease.fencingToken },
    });
    store.close();
  });

  it("uses atomic CAS so two Codex contenders cannot both acquire one worktree", async () => {
    const path = makeDb();
    const first = new WorktreeLeaseStore(path);
    const second = new WorktreeLeaseStore(path);
    const results = await Promise.all([
      first.acquire({ worktreePath, taskId: "task-42:a", holder: "codex", now: 100, ttlMs: 30_000 }),
      second.acquire({ worktreePath, taskId: "task-42:b", holder: "codex", now: 100, ttlMs: 30_000 }),
    ]);
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "contended")).toHaveLength(1);
    expect(new Set(results.map((result) => result.status === "acquired"
      ? result.lease.leaseId
      : result.currentLease.leaseId)).size).toBe(1);
    first.close();
    second.close();
  });

  it("rejects Grok acquisition and exposes no writer transfer path", async () => {
    const store = new WorktreeLeaseStore(makeDb());
    await expect(store.acquire({
      worktreePath,
      taskId: "task-42",
      holder: "grok",
      now: 100,
      ttlMs: 30_000,
    })).rejects.toThrow(/sole writer/i);
    expect((store as unknown as { transfer?: unknown }).transfer).toBeUndefined();
    expect(await store.listHandoffs("task-42")).toEqual([]);
    store.close();
  });

  it("fences an expired Codex holder after a fresh acquisition", async () => {
    const store = new WorktreeLeaseStore(makeDb());
    const first = await store.acquire({
      worktreePath,
      taskId: "task-42:first",
      holder: "codex",
      now: 100,
      ttlMs: 100,
    });
    if (first.status !== "acquired") throw new Error("expected first lease");
    const second = await store.acquire({
      worktreePath,
      taskId: "task-42:second",
      holder: "codex",
      now: 201,
      ttlMs: 30_000,
    });
    if (second.status !== "acquired") throw new Error("expected replacement lease");
    expect(second.lease.fencingToken).toBe(first.lease.fencingToken + 1);
    await expect(store.renew({
      worktreePath,
      leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken,
      holder: "codex",
      now: 300,
      ttlMs: 30_000,
    })).resolves.toMatchObject({
      status: "fenced",
      currentFencingToken: second.lease.fencingToken,
    });
    await expect(store.release({
      worktreePath,
      leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken,
      holder: "codex",
    })).resolves.toMatchObject({
      status: "fenced",
      currentFencingToken: second.lease.fencingToken,
    });
    store.close();
  });
});
