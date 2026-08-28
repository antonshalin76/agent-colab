import Database from "better-sqlite3";
import { classifyOutcome, type ProviderOutcome } from "../domain/outcomes.js";
import {
  REVIEW_PROVIDER_IDS,
  type ProviderHealth,
  type ReviewProviderId,
} from "../domain/routing.js";

const AGENTS = REVIEW_PROVIDER_IDS;
const TRANSIENT_CAPABILITY_FAILURES: ReadonlySet<ProviderOutcome["kind"]> = new Set([
  "quota", "rate_limit", "overload", "network_timeout",
]);

const assertFreshV3Schema = (db: Database.Database): void => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_provider_health'",
  ).get() as { sql: string } | undefined;
  const sql = row?.sql.toLowerCase() ?? "";
  if (!sql.includes("'grok'") || !sql.includes("'claude'") || !sql.includes("'codex'") ||
      !sql.includes("capability_verified")) {
    throw new Error("runtime_provider_health requires offline v2-to-v3 migration");
  }
};

export interface ProviderHealthState {
  agent: ReviewProviderId;
  health: ProviderHealth;
  retryAt: number | null;
  failureCount: number;
  attemptClaimed: boolean;
  capabilityVerified: boolean;
  updatedAt: number;
}

export interface ProviderAdmission {
  runnable: boolean;
  claimedAt?: number | undefined;
}

interface ProviderHealthRow {
  agent: ReviewProviderId;
  health: ProviderHealth;
  retry_at: number | null;
  failure_count: number;
  attempt_claimed: 0 | 1;
  capability_verified: 0 | 1;
  updated_at: number;
}

interface ProviderHealthOptions {
  cooldownMs: number;
  attemptLeaseMs?: number;
  enabled?: Record<ReviewProviderId, boolean>;
}

const toState = (row: ProviderHealthRow): ProviderHealthState => ({
  agent: row.agent,
  health: row.health,
  retryAt: row.retry_at,
  failureCount: row.failure_count,
  attemptClaimed: row.attempt_claimed === 1,
  capabilityVerified: row.capability_verified === 1,
  updatedAt: row.updated_at,
});

export class ProviderHealthStore {
  private readonly db: Database.Database;
  private readonly cooldownMs: number;
  private readonly attemptLeaseMs: number;

  constructor(path: string, options: ProviderHealthOptions) {
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs <= 0) {
      throw new Error("cooldownMs must be a positive integer");
    }
    this.cooldownMs = options.cooldownMs;
    this.attemptLeaseMs = options.attemptLeaseMs ?? 31 * 60_000;
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error("attemptLeaseMs must be a positive integer");
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const existing = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_provider_health'",
    ).get();
    if (existing !== undefined) {
      try {
        assertFreshV3Schema(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'claude', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      )
    `);
    try {
      assertFreshV3Schema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.initialize(options.enabled ?? { grok: true, claude: true, codex: true });
  }

  private initialize(enabled: Record<ReviewProviderId, boolean>): void {
    const initialize = this.db.transaction(() => {
      for (const agent of AGENTS) {
        const row = this.row(agent);
        if (row === undefined) {
          this.db.prepare(`
            INSERT INTO runtime_provider_health
              (agent, health, retry_at, failure_count, attempt_claimed, capability_verified, updated_at)
            VALUES (?, ?, NULL, 0, 0, 0, 0)
          `).run(agent, enabled[agent] ? "probing" : "disabled");
          continue;
        }
        if (!enabled[agent] && row.health !== "disabled") {
          this.db.prepare(`
            UPDATE runtime_provider_health
               SET health = 'disabled', retry_at = NULL, failure_count = 0,
                   attempt_claimed = 0, capability_verified = 0, updated_at = 0
             WHERE agent = ?
          `).run(agent);
        } else if (enabled[agent] && row.health === "disabled") {
          this.db.prepare(`
            UPDATE runtime_provider_health
               SET health = 'probing', retry_at = NULL, failure_count = 0,
                   attempt_claimed = 0, capability_verified = 0, updated_at = 0
             WHERE agent = ?
          `).run(agent);
        } else if (enabled[agent] && row.health === "healthy" && row.capability_verified === 0) {
          this.db.prepare(`
            UPDATE runtime_provider_health
               SET health = 'probing', retry_at = NULL, failure_count = 0,
                   attempt_claimed = 0, updated_at = 0
             WHERE agent = ?
          `).run(agent);
        }
      }
    });
    initialize.immediate();
  }

  private row(agent: ReviewProviderId): ProviderHealthRow | undefined {
    return this.db.prepare(`
      SELECT agent, health, retry_at, failure_count, attempt_claimed, capability_verified, updated_at
        FROM runtime_provider_health
       WHERE agent = ?
    `).get(agent) as ProviderHealthRow | undefined;
  }

  get(agent: ReviewProviderId): ProviderHealthState {
    const row = this.row(agent);
    if (row === undefined) throw new Error(`Provider health is not initialized: ${agent}`);
    return toState(row);
  }

  snapshot(): Record<ReviewProviderId, ProviderHealthState> {
    return {
      grok: this.get("grok"),
      claude: this.get("claude"),
      codex: this.get("codex"),
    };
  }

  acquireAdmission(agent: ReviewProviderId, now: number): ProviderAdmission {
    const current = this.get(agent);
    if (current.health === "healthy") return { runnable: true };
    if (current.health === "disabled") return { runnable: false };
    const changed = this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'probing', retry_at = NULL, attempt_claimed = 1, updated_at = ?
       WHERE agent = ?
         AND (
           (health = 'probing' AND (attempt_claimed = 0 OR updated_at <= ?))
           OR (health = 'unavailable' AND retry_at IS NOT NULL AND retry_at <= ?)
         )
    `).run(now, agent, now - this.attemptLeaseMs, now).changes;
    return changed === 1 ? { runnable: true, claimedAt: now } : { runnable: false };
  }

  acquireExplicitProbeAdmission(agent: ReviewProviderId, now: number): ProviderAdmission {
    const changed = this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'probing', attempt_claimed = 1, updated_at = ?
       WHERE agent = ? AND health != 'disabled' AND attempt_claimed = 0
         AND (health = 'healthy'
           OR (health = 'probing' AND (updated_at = 0 OR updated_at <= ?))
           OR (health = 'unavailable' AND retry_at IS NOT NULL AND retry_at <= ?))
    `).run(now, agent, now - this.attemptLeaseMs, now).changes;
    return changed === 1 ? { runnable: true, claimedAt: now } : { runnable: false };
  }

  canAttempt(agent: ReviewProviderId, now: number): boolean {
    return this.acquireAdmission(agent, now).runnable;
  }

  recordSuccess(agent: ReviewProviderId, now: number, expectedClaimedAt?: number): ProviderHealthState {
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'healthy', retry_at = NULL, failure_count = 0,
             attempt_claimed = 0, capability_verified = 1, updated_at = ?
       WHERE agent = ?
         AND updated_at <= ?
         AND ((? IS NULL AND attempt_claimed = 0 AND (health = 'healthy'
               OR (health = 'probing' AND capability_verified = 0 AND updated_at = 0)))
           OR (? IS NOT NULL AND attempt_claimed = 1 AND updated_at = ?))
    `).run(now, agent, now, expectedClaimedAt ?? null, expectedClaimedAt ?? null, expectedClaimedAt ?? null);
    return this.get(agent);
  }

  recordAuthReady(agent: ReviewProviderId, now: number): ProviderHealthState {
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = CASE capability_verified WHEN 1 THEN 'healthy' ELSE 'probing' END,
             retry_at = NULL, failure_count = 0,
             attempt_claimed = 0, updated_at = ?
       WHERE agent = ?
    `).run(now, agent);
    return this.get(agent);
  }

  releaseAttempt(agent: ReviewProviderId, now: number, expectedClaimedAt?: number): ProviderHealthState {
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    this.db.prepare(`UPDATE runtime_provider_health SET attempt_claimed = 0, updated_at = ?
      WHERE agent = ? AND (? IS NULL OR (attempt_claimed = 1 AND updated_at = ?))`)
      .run(now, agent, expectedClaimedAt ?? null, expectedClaimedAt ?? null);
    return this.get(agent);
  }

  recordFailoverFailure(
    agent: ReviewProviderId,
    outcome: ProviderOutcome,
    now: number,
    expectedClaimedAt?: number,
  ): ProviderHealthState {
    if (!classifyOutcome(outcome).failoverEligible) {
      throw new Error(`Outcome is not failover eligible: ${outcome.kind}`);
    }
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    const preserveCapability = current.capabilityVerified && TRANSIENT_CAPABILITY_FAILURES.has(outcome.kind);
    const retryAt = Math.max(now + this.cooldownMs,
      Number.isSafeInteger(outcome.retryAt) && outcome.retryAt! > now ? outcome.retryAt! : 0);
    this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'unavailable', retry_at = ?, failure_count = failure_count + 1,
             attempt_claimed = 0, capability_verified = ?, updated_at = ?
       WHERE agent = ?
         AND updated_at <= ?
         AND ((? IS NULL AND health = 'healthy' AND attempt_claimed = 0)
           OR (? IS NOT NULL AND attempt_claimed = 1 AND updated_at = ?))
    `).run(retryAt, preserveCapability ? 1 : 0, now, agent, now,
      expectedClaimedAt ?? null, expectedClaimedAt ?? null, expectedClaimedAt ?? null);
    return this.get(agent);
  }

  close(): void {
    this.db.close();
  }
}
