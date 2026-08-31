import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";

const roots: string[] = [];
const database = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-health-"));
  roots.push(root);
  return join(root, "state.db");
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime provider health persistence", () => {
  it("keeps ordinary launch eligibility read-only and reserves mutation for explicit probes", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    const before = store.get("grok");

    expect(store.acquireAdmission("grok", 10)).toEqual({ runnable: false });
    expect(store.canAttempt("grok", 11)).toBe(false);
    expect(store.get("grok")).toEqual(before);

    expect(store.acquireExplicitProbeAdmission("grok", 12)).toEqual({ runnable: true, claimedAt: 12 });
    expect(store.recordSuccess("grok", 13, 12)).toMatchObject({
      health: "healthy",
      capabilityVerified: true,
      attemptClaimed: false,
    });
    expect(store.acquireAdmission("grok", 14)).toEqual({ runnable: true });
    expect(store.get("grok")).toMatchObject({ updatedAt: 13, attemptClaimed: false });
    store.close();
  });
  it("claims automatic probes only for initial or due recovery state, never for healthy providers", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.acquireRecoveryProbeAdmission("grok", 1)).toEqual({ runnable: true, claimedAt: 1 });
    expect(store.recordSuccess("grok", 2, 1).health).toBe("healthy");
    expect(store.acquireRecoveryProbeAdmission("grok", 3)).toEqual({ runnable: false });
    store.recordFailoverFailure("grok", { kind: "quota" }, 10);
    expect(store.acquireRecoveryProbeAdmission("grok", 1_009)).toEqual({ runnable: false });
    expect(store.acquireRecoveryProbeAdmission("grok", 1_010)).toEqual({ runnable: true, claimedAt: 1_010 });
    store.close();
  });
  it("fences explicit provider probes before launch", () => {
    const path = database();
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const second = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(first.acquireExplicitProbeAdmission("claude", 10)).toEqual({ runnable: true, claimedAt: 10 });
    expect(second.acquireExplicitProbeAdmission("claude", 10)).toEqual({ runnable: false });
    expect(first.recordFailoverFailure("claude", { kind: "quota" }, 20, 10).health).toBe("unavailable");
    expect(first.acquireExplicitProbeAdmission("claude", 1_019)).toEqual({ runnable: false });
    expect(first.acquireExplicitProbeAdmission("claude", 1_020)).toEqual({ runnable: true, claimedAt: 1_020 });
    expect(first.recordSuccess("claude", 1_021, 1_020).health).toBe("healthy");
    first.close(); second.close();
  });
  it("rejects a pre-v3 provider schema instead of migrating it in the constructor", () => {
    const path = database();
    const db = new Database(path);
    db.exec(`CREATE TABLE runtime_provider_health (
      agent TEXT PRIMARY KEY CHECK (agent IN ('claude', 'codex')),
      health TEXT NOT NULL,
      retry_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      attempt_claimed INTEGER NOT NULL DEFAULT 0,
      capability_verified INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    const before = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_provider_health'",
    ).get() as { sql: string }).sql;
    db.close();

    expect(() => new ProviderHealthStore(path, { cooldownMs: 1_000 })).toThrow(
      /offline v2-to-v3 migration/i,
    );
    const unchanged = new Database(path, { readonly: true });
    expect((unchanged.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_provider_health'",
    ).get() as { sql: string }).sql).toBe(before);
    unchanged.close();
  });

  it("initializes enabled providers as probing and disabled providers as non-ready", () => {
    const store = new ProviderHealthStore(database(), {
      cooldownMs: 1_000,
      enabled: { grok: true, claude: true, codex: false },
    });

    expect(store.snapshot()).toEqual({
      grok: {
        agent: "grok",
        health: "probing",
        retryAt: null,
        failureCount: 0,
        attemptClaimed: false,
        capabilityVerified: false,
        updatedAt: 0,
      },
      claude: {
        agent: "claude",
        health: "probing",
        retryAt: null,
        failureCount: 0,
        attemptClaimed: false,
        capabilityVerified: false,
        updatedAt: 0,
      },
      codex: {
        agent: "codex",
        health: "disabled",
        retryAt: null,
        failureCount: 0,
        attemptClaimed: false,
        capabilityVerified: false,
        updatedAt: 0,
      },
    });
    expect(store.canAttempt("codex", 0)).toBe(false);
    store.close();
  });

  it("allows exactly one initial probe and persists its claim across reopen", () => {
    const path = database();
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000, attemptLeaseMs: 1_000 });

    expect(first.acquireExplicitProbeAdmission("grok", 10)).toEqual({ runnable: true, claimedAt: 10 });
    expect(first.acquireExplicitProbeAdmission("grok", 10)).toEqual({ runnable: false });
    first.close();

    const reopened = new ProviderHealthStore(path, { cooldownMs: 1_000, attemptLeaseMs: 1_000 });
    expect(reopened.snapshot().grok).toMatchObject({
      health: "probing",
      attemptClaimed: true,
      updatedAt: 10,
    });
    expect(reopened.acquireExplicitProbeAdmission("grok", 11)).toEqual({ runnable: false });
    expect(reopened.acquireExplicitProbeAdmission("grok", 1_010)).toEqual({ runnable: true, claimedAt: 1_010 });
    reopened.close();
  });

  it("does not expire a live admission claim on the shorter failure cooldown", () => {
    const store = new ProviderHealthStore(database(), {
      cooldownMs: 1_000,
      attemptLeaseMs: 31 * 60_000,
    });
    expect(store.acquireExplicitProbeAdmission("grok", 0)).toEqual({ runnable: true, claimedAt: 0 });
    expect(store.acquireExplicitProbeAdmission("grok", 1_000)).toEqual({ runnable: false });
    expect(store.acquireExplicitProbeAdmission("grok", 31 * 60_000)).toEqual({
      runnable: true, claimedAt: 31 * 60_000,
    });
    store.close();
  });

  it("lets only the owning admission token transition provider health", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.acquireExplicitProbeAdmission("grok", 10)).toEqual({ runnable: true, claimedAt: 10 });

    store.recordSuccess("grok", 20, 9);
    expect(store.get("grok")).toMatchObject({ health: "probing", attemptClaimed: true, updatedAt: 10 });

    store.recordSuccess("grok", 21, 10);
    expect(store.get("grok")).toMatchObject({
      health: "healthy", attemptClaimed: false, capabilityVerified: true, updatedAt: 21,
    });
    store.close();
  });

  it("persists failover failure and admits only one probe after cooldown under contention", () => {
    const path = database();
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const second = new ProviderHealthStore(path, { cooldownMs: 1_000 });

    expect(first.acquireExplicitProbeAdmission("grok", 0)).toEqual({ runnable: true, claimedAt: 0 });
    expect(first.recordFailoverFailure("grok", { kind: "rate_limit" }, 100, 0)).toMatchObject({
      health: "unavailable",
      retryAt: 1_100,
      failureCount: 1,
      attemptClaimed: false,
      capabilityVerified: false,
    });
    expect(second.acquireExplicitProbeAdmission("grok", 1_099)).toEqual({ runnable: false });
    expect(first.acquireExplicitProbeAdmission("grok", 1_100)).toEqual({ runnable: true, claimedAt: 1_100 });
    expect(second.acquireExplicitProbeAdmission("grok", 1_100)).toEqual({ runnable: false });
    expect(second.snapshot().grok).toMatchObject({
      health: "probing",
      retryAt: null,
      attemptClaimed: true,
    });

    first.close();
    second.close();
  });

  it("backs off repeated optional-provider probes with a bounded exponential delay", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.acquireExplicitProbeAdmission("grok", 0)).toEqual({ runnable: true, claimedAt: 0 });
    expect(store.recordFailoverFailure("grok", { kind: "quota" }, 100, 0).retryAt).toBe(1_100);
    expect(store.acquireExplicitProbeAdmission("grok", 1_100)).toEqual({ runnable: true, claimedAt: 1_100 });
    expect(store.recordFailoverFailure("grok", { kind: "quota" }, 1_200, 1_100).retryAt).toBe(3_200);
    expect(store.acquireExplicitProbeAdmission("grok", 3_200)).toEqual({ runnable: true, claimedAt: 3_200 });
    expect(store.recordFailoverFailure("grok", { kind: "quota" }, 3_300, 3_200).retryAt).toBe(7_300);
    store.close();
  });

  it("records recovery and never penalizes a provider for a non-failover outcome", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.acquireExplicitProbeAdmission("codex", 0)).toEqual({ runnable: true, claimedAt: 0 });
    store.recordFailoverFailure("codex", { kind: "auth" }, 50, 0);

    expect(() =>
      store.recordFailoverFailure("codex", { kind: "permission_denial" }, 60),
    ).toThrow(/not failover eligible/i);
    expect(store.snapshot().codex).toMatchObject({
      health: "unavailable",
      retryAt: 1_050,
      failureCount: 1,
    });

    expect(store.acquireExplicitProbeAdmission("codex", 1_051)).toEqual({ runnable: true, claimedAt: 1_051 });
    expect(store.recordSuccess("codex", 1_052, 1_051)).toMatchObject({
      health: "healthy",
      retryAt: null,
      failureCount: 0,
      attemptClaimed: false,
      capabilityVerified: true,
      updatedAt: 1_052,
    });
    expect(store.canAttempt("codex", 1_052)).toBe(true);
    store.close();
  });

  it("keeps auth-only readiness probing until an exact capability response succeeds", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.acquireExplicitProbeAdmission("codex", 1)).toEqual({ runnable: true, claimedAt: 1 });
    expect(store.recordAuthReady("codex", 2)).toMatchObject({
      health: "probing", attemptClaimed: false, capabilityVerified: false,
    });
    expect(store.acquireExplicitProbeAdmission("codex", 3)).toEqual({ runnable: true, claimedAt: 3 });
    expect(store.recordSuccess("codex", 4, 3)).toMatchObject({
      health: "healthy", capabilityVerified: true, attemptClaimed: false,
    });
    store.close();
  });

  it("automatically restores a previously verified provider after a transient outage", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    store.recordSuccess("grok", 10);
    expect(store.recordFailoverFailure("grok", { kind: "quota" }, 20)).toMatchObject({
      health: "unavailable", capabilityVerified: true, retryAt: 1_020,
    });
    expect(store.acquireExplicitProbeAdmission("grok", 1_020)).toEqual({ runnable: true, claimedAt: 1_020 });
    expect(store.recordAuthReady("grok", 1_021)).toMatchObject({
      health: "healthy", capabilityVerified: true, attemptClaimed: false,
    });
    store.recordFailoverFailure("grok", { kind: "auth" }, 2_000);
    expect(store.recordAuthReady("grok", 3_001)).toMatchObject({
      health: "probing", capabilityVerified: false,
    });
    store.close();
  });

  it("persists Claude outage and recovery with the same bounded health lifecycle", () => {
    const path = database();
    const store = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    store.recordSuccess("claude", 10);
    expect(store.recordFailoverFailure("claude", { kind: "network_timeout" }, 20)).toMatchObject({
      agent: "claude",
      health: "unavailable",
      capabilityVerified: true,
      retryAt: 1_020,
    });
    store.close();

    const reopened = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(reopened.acquireExplicitProbeAdmission("claude", 1_019)).toEqual({ runnable: false });
    expect(reopened.acquireExplicitProbeAdmission("claude", 1_020)).toEqual({ runnable: true, claimedAt: 1_020 });
    expect(reopened.recordAuthReady("claude", 1_021)).toMatchObject({
      agent: "claude",
      health: "healthy",
      retryAt: null,
      attemptClaimed: false,
    });
    reopened.close();
  });

  it("preserves state on reopen and changes disabled readiness only through configuration", () => {
    const path = database();
    const disabled = new ProviderHealthStore(path, {
      cooldownMs: 1_000,
      enabled: { grok: false, claude: false, codex: true },
    });
    disabled.close();

    const enabled = new ProviderHealthStore(path, {
      cooldownMs: 1_000,
      enabled: { grok: true, claude: true, codex: true },
    });
    expect(enabled.snapshot().grok).toMatchObject({
      health: "probing",
      retryAt: null,
      attemptClaimed: false,
    });
    expect(enabled.snapshot().claude).toMatchObject({
      health: "probing",
      retryAt: null,
      attemptClaimed: false,
    });
    enabled.close();
  });
});
