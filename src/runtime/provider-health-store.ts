import Database from "better-sqlite3";
import { classifyOutcome, type ProviderOutcome } from "../domain/outcomes.js";
import type { AgentId, ProviderHealth } from "../domain/routing.js";

const AGENTS: readonly AgentId[] = ["grok", "codex"];
const TRANSIENT_CAPABILITY_FAILURES: ReadonlySet<ProviderOutcome["kind"]> = new Set([
  "quota", "rate_limit", "overload", "network_timeout",
]);

const assertFreshV2Schema = (db: Database.Database): void => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_provider_health'",
  ).get() as { sql: string } | undefined;
  const sql = row?.sql.toLowerCase() ?? "";
  if (!sql.includes("'grok'") || sql.includes("'claude'") || !sql.includes("capability_verified")) {
    throw new Error("runtime_provider_health requires offline v1-to-v2 migration");
  }
};

export interface ProviderHealthState {
  agent: AgentId;
  health: ProviderHealth;
  retryAt: number | null;
  failureCount: number;
  attemptClaimed: boolean;
  capabilityVerified: boolean;
  updatedAt: number;
}

interface ProviderHealthRow {
  agent: AgentId;
  health: ProviderHealth;
  retry_at: number | null;
  failure_count: number;
  attempt_claimed: 0 | 1;
  capability_verified: 0 | 1;
  updated_at: number;
}

interface ProviderHealthOptions {
  cooldownMs: number;
  enabled?: Record<AgentId, boolean>;
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

  constructor(path: string, options: ProviderHealthOptions) {
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs <= 0) {
      throw new Error("cooldownMs must be a positive integer");
    }
    this.cooldownMs = options.cooldownMs;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const existing = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_provider_health'",
    ).get();
    if (existing !== undefined) {
      try {
        assertFreshV2Schema(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      )
    `);
    try {
      assertFreshV2Schema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.initialize(options.enabled ?? { grok: true, codex: true });
  }

  private initialize(enabled: Record<AgentId, boolean>): void {
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

  private row(agent: AgentId): ProviderHealthRow | undefined {
    return this.db.prepare(`
      SELECT agent, health, retry_at, failure_count, attempt_claimed, capability_verified, updated_at
        FROM runtime_provider_health
       WHERE agent = ?
    `).get(agent) as ProviderHealthRow | undefined;
  }

  get(agent: AgentId): ProviderHealthState {
    const row = this.row(agent);
    if (row === undefined) throw new Error(`Provider health is not initialized: ${agent}`);
    return toState(row);
  }

  snapshot(): Record<AgentId, ProviderHealthState> {
    return {
      grok: this.get("grok"),
      codex: this.get("codex"),
    };
  }

  canAttempt(agent: AgentId, now: number): boolean {
    const current = this.get(agent);
    if (current.health === "healthy") return true;
    if (current.health === "disabled") return false;
    const changed = this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'probing', retry_at = NULL, attempt_claimed = 1, updated_at = ?
       WHERE agent = ?
         AND (
           (health = 'probing' AND (attempt_claimed = 0 OR updated_at <= ?))
           OR (health = 'unavailable' AND retry_at IS NOT NULL AND retry_at <= ?)
         )
    `).run(now, agent, now - this.cooldownMs, now).changes;
    return changed === 1;
  }

  isRunnable(agent: AgentId, now: number): boolean {
    const current = this.get(agent);
    if (current.health === "healthy") return true;
    if (current.health === "probing") return !current.attemptClaimed || current.updatedAt <= now - this.cooldownMs;
    return current.health === "unavailable" && current.retryAt !== null && current.retryAt <= now && !current.attemptClaimed;
  }

  recordSuccess(agent: AgentId, now: number): ProviderHealthState {
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'healthy', retry_at = NULL, failure_count = 0,
             attempt_claimed = 0, capability_verified = 1, updated_at = ?
       WHERE agent = ?
    `).run(now, agent);
    return this.get(agent);
  }

  recordAuthReady(agent: AgentId, now: number): ProviderHealthState {
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

  releaseAttempt(agent: AgentId, now: number): ProviderHealthState {
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    this.db.prepare(`UPDATE runtime_provider_health SET attempt_claimed = 0, updated_at = ? WHERE agent = ?`)
      .run(now, agent);
    return this.get(agent);
  }

  recordFailoverFailure(agent: AgentId, outcome: ProviderOutcome, now: number): ProviderHealthState {
    if (!classifyOutcome(outcome).failoverEligible) {
      throw new Error(`Outcome is not failover eligible: ${outcome.kind}`);
    }
    const current = this.get(agent);
    if (current.health === "disabled") return current;
    const preserveCapability = current.capabilityVerified && TRANSIENT_CAPABILITY_FAILURES.has(outcome.kind);
    this.db.prepare(`
      UPDATE runtime_provider_health
         SET health = 'unavailable', retry_at = ?, failure_count = failure_count + 1,
             attempt_claimed = 0, capability_verified = ?, updated_at = ?
       WHERE agent = ?
    `).run(now + this.cooldownMs, preserveCapability ? 1 : 0, now, agent);
    return this.get(agent);
  }

  close(): void {
    this.db.close();
  }
}
