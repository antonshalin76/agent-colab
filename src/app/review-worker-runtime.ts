import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { isFailoverOutcome } from "../domain/outcomes.js";
import { normalizeReviewProviderResult } from "../domain/review-verdict.js";
import {
  REVIEW_PROVIDER_IDS,
  type ReviewProviderId,
} from "../domain/routing.js";
import type { ProcessTask } from "../runners/agent-runner.js";
import { activateRecoveredReviewLanes } from "../runtime/review-rejoin.js";
import { executeReviewLaunchWithFence } from "../runtime/review-launch-admission.js";
import type { ReviewEvidenceCapture } from "../runtime/review-evidence-capture.js";
import {
  runAutomaticProviderRecovery,
  type AutomaticProviderProbeResult,
  type ProviderRecoveryResult,
} from "../runtime/provider-recovery-loop.js";
import { ProviderHealthStore } from "../runtime/provider-health-store.js";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import type {
  StateDatabaseAccess,
  StateStoreInput,
} from "../store/state-database-fence.js";
import { RunStore, type RunRecord } from "../store/run-store.js";
import {
  assertPersistedDomainEffectMatchesRun,
  isTransientSqliteError,
  parsePersistedDomainEffect,
  type PersistedDomainEffect,
} from "../worker/domain-effect.js";
import {
  DurableWorker,
  type CommitDomainEffect,
} from "../worker/durable-worker.js";

type ReviewRole = "auditor" | "critic";

export interface ReviewAgentRunner {
  run(
    task: ProcessTask,
    onLaunch: (info: Record<string, unknown>) => void,
    onLaunchIntent: (info: Record<string, unknown>) => void,
    onProvenNoSpawn: () => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ReviewWorkerRuntimeOptions {
  stateDatabase: StateStoreInput;
  workerId: string;
  runner: ReviewAgentRunner;
  evidenceCapture: ReviewEvidenceCapture;
  probe: (agent: ReviewProviderId, signal?: AbortSignal) => Promise<AutomaticProviderProbeResult>;
  leaseMs?: number;
  cooldownMs?: number;
  replayLeaseMs?: number;
}

export interface ReviewEffectReplayResult {
  applied: number;
  deferred: number;
  quarantined: number;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isReviewProvider = (value: unknown): value is ReviewProviderId =>
  value === "grok" || value === "claude" || value === "codex";

const isRole = (value: unknown): value is ReviewRole =>
  value === "auditor" || value === "critic";

const borrow = (input: StateStoreInput): StateStoreInput =>
  typeof input !== "string" && "assertUsable" in input
    ? (input as StateDatabaseAccess).borrow()
    : input;

const taskFrom = (run: RunRecord): ProcessTask => ({
  id: run.id,
  stage: run.stage,
  ...(run.artifactHash === undefined ? {} : { artifactHash: run.artifactHash }),
  idempotencyKey: run.idempotencyKey,
  ...(run.approvalScope === undefined ? {} : { approvalScope: run.approvalScope }),
  ...(run.payload === undefined ? {} : { payload: run.payload }),
});

interface ReviewIdentity {
  reviewId: string;
  attemptId: string;
  attemptOrdinal: number;
  role: ReviewRole;
  agent: ReviewProviderId;
}

class PersistedReviewEffectError extends Error {}

export class ReviewWorkerRuntime {
  private readonly runs: RunStore;
  private readonly reviews: RunGateUnitOfWork;
  private readonly health: ProviderHealthStore;
  private readonly worker: DurableWorker;
  private readonly replayOwner: string;
  private readonly replayLeaseMs: number;
  private readonly shutdown = new AbortController();
  private stopping = false;
  private closed = false;

  constructor(private readonly options: ReviewWorkerRuntimeOptions) {
    if (!options.workerId) throw new Error("review worker id must not be empty");
    this.replayLeaseMs = options.replayLeaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.replayLeaseMs) || this.replayLeaseMs <= 0) {
      throw new Error("review replay lease must be a positive integer");
    }
    this.replayOwner = `review-domain-replay:${options.workerId}:${randomUUID()}`;
    const runs = new RunStore(borrow(options.stateDatabase), { scope: "review" });
    let reviews: RunGateUnitOfWork | undefined;
    let health: ProviderHealthStore | undefined;
    try {
      reviews = new RunGateUnitOfWork(borrow(options.stateDatabase));
      health = new ProviderHealthStore(borrow(options.stateDatabase), {
        cooldownMs: options.cooldownMs ?? 60_000,
      });
      this.runs = runs;
      this.reviews = reviews;
      this.health = health;
      this.worker = new DurableWorker({
        store: runs,
        workerId: options.workerId,
        runner: this.executeClaimedReview.bind(this),
        leaseMs: options.leaseMs ?? 31 * 60_000,
      });
    } catch (error) {
      health?.close();
      reviews?.close();
      runs.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("review worker runtime is closed");
  }

  private poison(message: string): never {
    throw new PersistedReviewEffectError(message);
  }

  private identity(run: RunRecord): ReviewIdentity | null {
    const payload = run.payload;
    const decision = object(payload?.decision);
    const dispatch = object(payload?.reviewDispatchIdentity);
    const reviewId = payload?.reviewId;
    const attemptId = payload?.reviewAttemptId;
    const attemptOrdinal = payload?.reviewAttemptOrdinal;
    const role = payload?.reviewRole;
    const agent = decision?.agent;
    if (decision === null || dispatch === null || typeof reviewId !== "string" ||
        typeof attemptId !== "string" ||
        !Number.isSafeInteger(attemptOrdinal) || !isRole(role) || !isReviewProvider(agent) ||
        run.stage !== `review:${role}` || dispatch.agent !== agent ||
        dispatch.attemptId !== attemptId || dispatch.attemptOrdinal !== attemptOrdinal) {
      return null;
    }
    let snapshot;
    try {
      snapshot = this.reviews.get(reviewId);
    } catch {
      return null;
    }
    const lane = snapshot?.lanes.find((candidate) =>
      candidate.agent === agent && candidate.role === role);
    const attempt = lane?.attempts.at(-1);
    if (!lane || lane.status !== "queued" || !attempt || attempt.status !== "scheduled" ||
        attempt.attemptId !== attemptId || attempt.attemptOrdinal !== attemptOrdinal ||
        payload?.sessionId !== attempt.sessionId || dispatch.sessionId !== attempt.sessionId ||
        payload?.preferredAgent !== agent || payload?.approvalScope !== "workspace-read" ||
        run.approvalScope !== "workspace-read" || payload?.artifactHash !== run.artifactHash ||
        payload?.sourceFingerprint !== snapshot?.sourceFingerprint ||
        decision.model !== attempt.model || decision.effort !== attempt.effort ||
        decision.policyVersion !== attempt.policyVersion ||
        !isDeepStrictEqual(decision.reasons, attempt.reasons) ||
        dispatch.model !== attempt.model || dispatch.effort !== attempt.effort ||
        dispatch.policyVersion !== attempt.policyVersion ||
        !isDeepStrictEqual(dispatch.reasons, attempt.reasons)) {
      return null;
    }
    return { reviewId, attemptId, attemptOrdinal: Number(attemptOrdinal), role, agent };
  }

  private reconcileIdentity(run: RunRecord, reason: string): void {
    if (!run.leaseToken) throw new Error("claimed review is missing its queue lease");
    this.runs.reconcileClaimedReviewIdentity(run.id, run.leaseToken, reason);
  }

  private async executeClaimedReview(
    run: RunRecord,
    onLaunch: (info: Record<string, unknown>) => void,
    commitDomainEffect: CommitDomainEffect,
    _persistExecutionContext: (context: Record<string, unknown>) => void,
    onLaunchIntent: (info: Record<string, unknown>) => void,
    onProvenNoSpawn: () => void,
  ): Promise<Record<string, unknown>> {
    const identity = this.identity(run);
    if (!identity) {
      this.reconcileIdentity(run, "review-only worker rejected a non-exact review identity");
      return { kind: "task_failure", duplicateSpawnPrevented: true };
    }

    const launchDecision = await executeReviewLaunchWithFence({
      run,
      health: this.health,
      observedAt: Date.now(),
      evidenceCapture: this.options.evidenceCapture,
      reviews: this.reviews,
      reconcile: (reason) => this.reconcileIdentity(run, reason),
      launch: (spawnAuthority) => {
        const authority = object(spawnAuthority) ?? {};
        return this.options.runner.run(
          taskFrom(run),
          onLaunch,
          (info) => onLaunchIntent({ ...info, ...authority }),
          onProvenNoSpawn,
          this.shutdown.signal,
        );
      },
    });
    const rawResult = object(launchDecision.providerResult) ?? {
      kind: "task_failure",
      error: "review launch fence returned no provider result",
    };
    if (rawResult.agent !== undefined && rawResult.agent !== identity.agent) {
      throw new Error("runner result agent does not match the durable review assignment");
    }
    let result: Record<string, unknown> = { ...rawResult, agent: identity.agent };
    if (result.kind === "success") {
      try {
        result = normalizeReviewProviderResult(result);
      } catch (error) {
        result = {
          kind: "task_failure",
          agent: identity.agent,
          reviewOutputInvalid: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const resultKind = typeof result.kind === "string" ? result.kind : "task_failure";
    const durableLaunch = this.runs.get(run.id);
    const launchInfo = object(durableLaunch?.launchInfo);
    if (durableLaunch?.launched && launchInfo?.phase !== "started") return result;
    if (launchDecision.status !== "launched") {
      if (this.runs.get(run.id)?.status === "claimed") {
        this.reconcileIdentity(run, "review prelaunch no-spawn lacks a terminal run-effect projection");
      }
      return { kind: "task_failure", agent: identity.agent, duplicateSpawnPrevented: true };
    }
    const effect = {
      type: "review",
      reviewId: identity.reviewId,
      attemptId: identity.attemptId,
      role: identity.role,
      agent: identity.agent,
      resultKind,
      terminalAt: Date.now(),
      ...(typeof run.payload?.providerAdmissionClaimedAt === "number"
        ? { providerAdmissionClaimedAt: run.payload.providerAdmissionClaimedAt }
        : {}),
    };
    commitDomainEffect({
      providerResult: result,
      effect,
      status: resultKind === "success" || isFailoverOutcome(resultKind) ? "completed" : "failed",
    });
    const committed = this.runs.get(run.id);
    if (!committed || !this.runs.claimDomainEffect(run.id, {
      owner: this.replayOwner,
      now: Date.now(),
      leaseMs: this.replayLeaseMs,
    })) {
      throw new Error("committed review domain effect could not be claimed");
    }
    await this.replayClaimedDomainEffect(committed);
    return result;
  }

  private async applyReviewEffect(
    run: RunRecord,
    providerResult: Record<string, unknown>,
    effect: PersistedDomainEffect,
  ): Promise<void> {
    if (effect.type !== "review") this.poison("review-only worker rejected a non-review domain effect");
    const { reviewId, attemptId, role, agent, resultKind, terminalAt } = effect;
    try {
      const attempt = this.reviews.attempts(reviewId, agent, role)
        .find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) this.poison("unknown persisted review attempt");
      if (resultKind === "success") {
        this.reviews.recordTerminal({ reviewId, agent, role, attemptId,
          status: "completed", result: providerResult, terminalAt });
      } else if (isFailoverOutcome(resultKind)) {
        this.reviews.recordProviderUnavailable({ reviewId, agent, role, attemptId,
          error: providerResult, terminalAt });
      } else {
        this.reviews.recordTerminal({ reviewId, agent, role, attemptId,
          status: "failed", error: providerResult, terminalAt });
      }
      const admissionClaimedAt = effect.providerAdmissionClaimedAt;
      if (resultKind === "success") {
        this.health.recordSuccess(agent, terminalAt, admissionClaimedAt);
        activateRecoveredReviewLanes({
          agent,
          now: terminalAt,
          reviews: this.reviews,
          health: this.health,
          evidenceCapture: this.options.evidenceCapture,
        });
      } else if (isFailoverOutcome(resultKind)) {
        const retryAt = typeof providerResult.retryAt === "number"
          ? providerResult.retryAt
          : undefined;
        this.health.recordFailoverFailure(agent, {
          kind: resultKind,
          ...(retryAt === undefined ? {} : { retryAt }),
        }, terminalAt, admissionClaimedAt);
      } else if (admissionClaimedAt !== undefined) {
        this.health.releaseAttempt(agent, terminalAt, admissionClaimedAt);
      }
    } catch (error) {
      if (error instanceof PersistedReviewEffectError || isTransientSqliteError(error)) throw error;
      this.poison(error instanceof Error ? error.message : String(error));
    }
  }

  private async replayClaimedDomainEffect(run: RunRecord): Promise<void> {
    try {
      const envelope = object(run.result);
      const providerResult = object(envelope?.providerResult);
      if (!providerResult || envelope?.effect === undefined) {
        this.poison(`invalid pending review domain effect: ${run.id}`);
      }
      let effect: PersistedDomainEffect;
      try {
        effect = parsePersistedDomainEffect(envelope.effect);
        assertPersistedDomainEffectMatchesRun(run, providerResult, effect);
      } catch (error) {
        this.poison(error instanceof Error ? error.message : String(error));
      }
      await this.applyReviewEffect(run, providerResult, effect);
      if (!this.runs.markDomainEffectApplied(run.id, this.replayOwner)) {
        const latest = object(this.runs.get(run.id)?.result);
        if (latest?.domainEffect !== "applied") {
          throw new Error(`review domain effect lost its replay claim: ${run.id}`);
        }
      }
    } catch (error) {
      if (error instanceof PersistedReviewEffectError) {
        this.runs.quarantineDomainEffect(run.id, this.replayOwner, error);
      } else {
        this.runs.releaseDomainEffectClaim(run.id, this.replayOwner, error);
      }
      throw error;
    }
  }

  async replayPendingDomainEffects(now = Date.now()): Promise<ReviewEffectReplayResult> {
    this.assertOpen();
    const result: ReviewEffectReplayResult = { applied: 0, deferred: 0, quarantined: 0 };
    for (const pending of this.runs.pendingDomainEffects(now)) {
      if (!this.runs.claimDomainEffect(pending.id, {
        owner: this.replayOwner,
        now,
        leaseMs: this.replayLeaseMs,
      })) continue;
      const claimed = this.runs.get(pending.id);
      if (!claimed) continue;
      try {
        await this.replayClaimedDomainEffect(claimed);
        result.applied += 1;
      } catch (error) {
        if (error instanceof PersistedReviewEffectError) result.quarantined += 1;
        else result.deferred += 1;
      }
    }
    return result;
  }

  async runOnce(now = Date.now()): Promise<RunRecord | undefined> {
    this.assertOpen();
    if (this.stopping) return undefined;
    await this.replayPendingDomainEffects(now);
    if (this.stopping) return undefined;
    return this.worker.runOnce(now);
  }

  async recover(now = Date.now()): Promise<{
    expired: number;
    replay: ReviewEffectReplayResult;
  }> {
    this.assertOpen();
    const expired = this.runs.recoverExpired(now);
    const replay = await this.replayPendingDomainEffects(now);
    return { expired, replay };
  }

  async recoverProviders(now = Date.now()): Promise<readonly ProviderRecoveryResult[]> {
    this.assertOpen();
    const demanded = REVIEW_PROVIDER_IDS.filter((agent) =>
      this.reviews.deferredReviewIds(agent).length > 0);
    if (demanded.length === 0) return [];
    return runAutomaticProviderRecovery({
      now,
      health: this.health,
      reviews: this.reviews,
      evidenceCapture: this.options.evidenceCapture,
      probe: this.options.probe,
      agents: demanded,
      signal: this.shutdown.signal,
    });
  }

  close(): void {
    if (this.closed) return;
    this.stop();
    this.closed = true;
    this.worker.close();
    this.reviews.close();
    this.health.close();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.shutdown.abort();
  }
}

export const createReviewWorkerRuntime = (
  options: ReviewWorkerRuntimeOptions,
): ReviewWorkerRuntime => new ReviewWorkerRuntime(options);
