import type Database from "better-sqlite3";

import { REVIEW_BARRIER_POLICY } from "../domain/review.js";
import { REVIEW_PROVIDER_IDS, type ReviewProviderId } from "../domain/routing.js";
import { assertReviewV3SchemaSignature } from "../migration/review-v3-schema.js";
import type { ReviewStatusOnlyService } from "../mcp/review-status-only-server.js";
import type { StateDatabaseAccess } from "../store/state-database-fence.js";

interface ProviderStatusRow {
  agent: ReviewProviderId;
  health: string;
  retry_at: number | null;
  failure_count: number;
  attempt_claimed: 0 | 1;
  capability_verified: 0 | 1;
  updated_at: number;
  recovery_generation: number;
  deferred_review_count: number;
}

export class ReviewStatusQuery implements ReviewStatusOnlyService {
  readonly #access: StateDatabaseAccess;
  readonly #db: Database.Database;
  #closed = false;

  constructor(access: StateDatabaseAccess) {
    access.assertUsable();
    assertReviewV3SchemaSignature(access.database);
    this.#access = access;
    this.#db = access.database;
  }

  async status(): Promise<unknown> {
    if (this.#closed) throw new Error("review status query is closed");
    this.#access.assertUsable();
    const rows = this.#db.prepare(`
      SELECT p.agent,p.health,p.retry_at,p.failure_count,p.attempt_claimed,
             p.capability_verified,p.updated_at,
             COALESCE((SELECT MAX(g.generation)
                       FROM runtime_provider_recovery_generations g
                       WHERE g.agent=p.agent),0) AS recovery_generation,
             (SELECT COUNT(DISTINCT lane.review_id)
              FROM runtime_review_lanes lane
              WHERE lane.agent=p.agent AND lane.status='deferred') AS deferred_review_count
        FROM runtime_provider_health p
       ORDER BY CASE p.agent WHEN 'grok' THEN 0 WHEN 'claude' THEN 1 ELSE 2 END
    `).all() as ProviderStatusRow[];
    if (rows.length !== REVIEW_PROVIDER_IDS.length ||
        rows.some((row, index) => row.agent !== REVIEW_PROVIDER_IDS[index])) {
      throw new Error("review provider status topology is invalid");
    }
    const queueRows = this.#db.prepare(`
      SELECT r.status,COUNT(*) AS count
        FROM runs r
        JOIN runtime_review_lane_attempts attempt ON attempt.run_id=r.id
        JOIN runtime_review_barriers barrier ON barrier.review_id=attempt.review_id
       WHERE r.stage=('review:' || attempt.role)
         AND r.approval_scope='workspace-read'
         AND r.approval_scope IS barrier.approval_scope
         AND r.artifact_hash IS barrier.artifact_hash
         AND json_extract(r.payload,'$.reviewId') IS attempt.review_id
         AND json_extract(r.payload,'$.reviewRole') IS attempt.role
         AND json_extract(r.payload,'$.decision.agent') IS attempt.agent
       GROUP BY r.status
    `).all() as Array<{ status: string; count: number }>;
    const queue = Object.fromEntries(
      ["queued", "claimed", "completed", "failed", "cancelled", "needs_reconciliation"]
        .map((status) => [status, queueRows.find((row) => row.status === status)?.count ?? 0]),
    );
    return {
      providers: Object.fromEntries(rows.map((row) => [row.agent, {
        required: row.agent === REVIEW_BARRIER_POLICY.requiredAgent,
        health: row.health,
        capabilityVerified: row.capability_verified === 1,
        retryAt: row.retry_at,
        failureCount: row.failure_count,
        attemptClaimed: row.attempt_claimed === 1,
        updatedAt: row.updated_at,
        recoveryGeneration: row.recovery_generation,
        deferredReviewCount: row.deferred_review_count,
      }])),
      reviewPolicy: {
        required: REVIEW_BARRIER_POLICY.requiredRoles.map(
          (role) => `${REVIEW_BARRIER_POLICY.requiredAgent}:${role}`,
        ),
        optional: REVIEW_BARRIER_POLICY.optionalAgents.flatMap(
          (agent) => REVIEW_BARRIER_POLICY.requiredRoles.map((role) => `${agent}:${role}`),
        ),
        optionalUnavailableBlocks: REVIEW_BARRIER_POLICY.optionalUnavailableBlocks,
        optionalChangesRequestedBlocks: REVIEW_BARRIER_POLICY.optionalChangesRequestedBlocks,
        optionalNeedsReconciliationBlocks: REVIEW_BARRIER_POLICY.optionalNeedsReconciliationBlocks,
      },
      queue,
      protocol: "agent-collab-review-status-only/v1",
      capabilities: { reviewOnly: true, readOnly: true },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#access.close();
  }
}
