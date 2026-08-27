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
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000 });

    expect(first.canAttempt("grok", 10)).toBe(true);
    expect(first.canAttempt("grok", 10)).toBe(false);
    first.close();

    const reopened = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(reopened.snapshot().grok).toMatchObject({
      health: "probing",
      attemptClaimed: true,
      updatedAt: 10,
    });
    expect(reopened.canAttempt("grok", 11)).toBe(false);
    expect(reopened.canAttempt("grok", 1_010)).toBe(true);
    reopened.close();
  });

  it("persists failover failure and admits only one probe after cooldown under contention", () => {
    const path = database();
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const second = new ProviderHealthStore(path, { cooldownMs: 1_000 });

    expect(first.canAttempt("grok", 0)).toBe(true);
    expect(first.recordFailoverFailure("grok", { kind: "rate_limit" }, 100)).toMatchObject({
      health: "unavailable",
      retryAt: 1_100,
      failureCount: 1,
      attemptClaimed: false,
      capabilityVerified: false,
    });
    expect(second.canAttempt("grok", 1_099)).toBe(false);
    expect(first.canAttempt("grok", 1_100)).toBe(true);
    expect(second.canAttempt("grok", 1_100)).toBe(false);
    expect(second.snapshot().grok).toMatchObject({
      health: "probing",
      retryAt: null,
      attemptClaimed: true,
    });

    first.close();
    second.close();
  });

  it("records recovery and never penalizes a provider for a non-failover outcome", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.canAttempt("codex", 0)).toBe(true);
    store.recordFailoverFailure("codex", { kind: "auth" }, 50);

    expect(() =>
      store.recordFailoverFailure("codex", { kind: "permission_denial" }, 60),
    ).toThrow(/not failover eligible/i);
    expect(store.snapshot().codex).toMatchObject({
      health: "unavailable",
      retryAt: 1_050,
      failureCount: 1,
    });

    expect(store.recordSuccess("codex", 1_051)).toMatchObject({
      health: "healthy",
      retryAt: null,
      failureCount: 0,
      attemptClaimed: false,
      capabilityVerified: true,
      updatedAt: 1_051,
    });
    expect(store.canAttempt("codex", 1_052)).toBe(true);
    store.close();
  });

  it("keeps auth-only readiness probing until an exact capability response succeeds", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    expect(store.canAttempt("codex", 1)).toBe(true);
    expect(store.recordAuthReady("codex", 2)).toMatchObject({
      health: "probing", attemptClaimed: false, capabilityVerified: false,
    });
    expect(store.canAttempt("codex", 3)).toBe(true);
    expect(store.recordSuccess("codex", 4)).toMatchObject({
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
    expect(store.canAttempt("grok", 1_020)).toBe(true);
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
    expect(reopened.canAttempt("claude", 1_019)).toBe(false);
    expect(reopened.canAttempt("claude", 1_020)).toBe(true);
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
