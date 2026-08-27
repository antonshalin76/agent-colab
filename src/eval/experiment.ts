import { createHash } from "node:crypto";

type EvalProvider = "grok" | "codex";
type ProviderAvailability = "healthy" | "unavailable";
type AttemptStatus = "planned" | "launched" | "completed" | "failed" | "invalidated";

interface EvalAttemptRecord {
  readonly id: string;
  readonly blockId: string;
  readonly provider: EvalProvider;
  readonly repetition: number;
  readonly status: AttemptStatus;
  readonly launchReceiptHash?: string | undefined;
  readonly evidenceHash?: string | undefined;
}

interface EvalBlockRecord {
  readonly id: string;
  readonly state: string;
  readonly manifestHash?: string;
  readonly seed?: number;
  readonly snapshotHash?: string;
  readonly parityReceiptHash?: string;
}

export interface ExperimentStore {
  getBlock(blockId: string): EvalBlockRecord | undefined;
  listAttempts(blockId: string): readonly EvalAttemptRecord[];
  markAttemptLaunched(attemptId: string, input: { launchReceiptHash: string }): unknown;
  invalidateAttempt(attemptId: string, input: { evidenceHash: string }): unknown;
  finishAttempt(attemptId: string, input: {
    status: "completed" | "failed";
    evidenceHash: string;
  }): unknown;
  advanceBlock(blockId: string, state: string, input: { receiptHash: string }): unknown;
}

export type ExperimentAction =
  | Readonly<{ kind: "mark_block_inconclusive"; reason: "provider_unavailable" | "source_integrity_mismatch" }>
  | Readonly<{ kind: "launch_attempt"; attemptId: string }>
  | Readonly<{
    kind: "reconciliation_required";
    attemptId: string;
    reason: "persisted_launched_attempt";
  }>
  | Readonly<{ kind: "block_not_runnable"; state: string }>
  | Readonly<{ kind: "attempt_completed"; attemptId: string }>
  | Readonly<{ kind: "attempt_failed"; attemptId: string }>
  | Readonly<{ kind: "check_block" }>;

export const nextExperimentAction = (input: {
  readonly blockId: string;
  readonly blockStatus: string;
  readonly providers: Readonly<Record<EvalProvider, ProviderAvailability>>;
  readonly launchOrder: readonly [EvalProvider, EvalProvider];
  readonly attempts: readonly Readonly<{
    attemptId: string;
    provider: EvalProvider;
    status: AttemptStatus;
  }>[];
}): ExperimentAction => {
  const uncertain = input.attempts.find((attempt) => attempt.status === "launched");
  if (uncertain) {
    return {
      kind: "reconciliation_required",
      attemptId: uncertain.attemptId,
      reason: "persisted_launched_attempt",
    };
  }

  const planned = input.attempts.filter((attempt) => attempt.status === "planned");
  if (planned.length === 0) return { kind: "check_block" };
  if (["completed", "inconclusive", "failed"].includes(input.blockStatus)) {
    return { kind: "block_not_runnable", state: input.blockStatus };
  }
  if (input.launchOrder.some((provider) => input.providers[provider] !== "healthy")) {
    return { kind: "mark_block_inconclusive", reason: "provider_unavailable" };
  }
  if (input.blockStatus !== "running") {
    return { kind: "block_not_runnable", state: input.blockStatus };
  }
  for (const provider of input.launchOrder) {
    const attempt = planned.find((item) => item.provider === provider);
    if (attempt) return { kind: "launch_attempt", attemptId: attempt.attemptId };
  }
  throw new Error("schedule launch order does not cover every planned provider");
};

export interface LaunchRequest {
  readonly attemptId: string;
  readonly provider: EvalProvider;
  readonly launchReceiptHash: string;
}

export interface LaunchResult {
  readonly status: "completed" | "failed";
  readonly evidenceHash: string;
}

type IntegrityVerifier = () => Promise<Readonly<{
  unchanged: boolean;
  mismatches: readonly string[];
}>>;
type ExperimentLauncher = (request: LaunchRequest) => Promise<LaunchResult>;
type ProviderHealthReader = () => Promise<Readonly<Record<EvalProvider, ProviderAvailability>>>;

const digest = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

export class ExperimentRunner {
  readonly #store: ExperimentStore;
  readonly #verifyIntegrity: IntegrityVerifier;
  readonly #providerHealth: ProviderHealthReader;
  readonly #launchOrder: readonly [EvalProvider, EvalProvider];
  readonly #launcher: ExperimentLauncher;

  constructor(input: {
    readonly store: ExperimentStore;
    readonly verifyIntegrity: IntegrityVerifier;
    readonly providerHealth: ProviderHealthReader;
    readonly launchOrder: readonly [EvalProvider, EvalProvider];
    readonly launcher: ExperimentLauncher;
  }) {
    if (input.launchOrder[0] === input.launchOrder[1]) {
      throw new Error("schedule launch order must contain both providers");
    }
    this.#store = input.store;
    this.#verifyIntegrity = input.verifyIntegrity;
    this.#providerHealth = input.providerHealth;
    this.#launchOrder = Object.freeze([...input.launchOrder]);
    this.#launcher = input.launcher;
  }

  async runNext(blockId: string): Promise<ExperimentAction> {
    const block = this.#store.getBlock(blockId);
    if (!block) throw new Error("unknown eval block");
    const attempts = this.#store.listAttempts(blockId);
    const uncertain = attempts.find((attempt) => attempt.status === "launched");
    if (uncertain) {
      return {
        kind: "reconciliation_required",
        attemptId: uncertain.id,
        reason: "persisted_launched_attempt",
      };
    }

    const plannedAttempts = attempts.filter((attempt) => attempt.status === "planned");
    if (plannedAttempts.length === 0) return { kind: "check_block" };

    const health = await this.#providerHealth();
    const action = nextExperimentAction({
      blockId,
      blockStatus: block.state,
      providers: health,
      launchOrder: this.#launchOrder,
      attempts: attempts.map((attempt) => ({
        attemptId: attempt.id,
        provider: attempt.provider,
        status: attempt.status,
      })),
    });
    if (action.kind === "mark_block_inconclusive") {
      for (const attempt of plannedAttempts) {
        this.#store.invalidateAttempt(attempt.id, {
          evidenceHash: digest({ blockId, attemptId: attempt.id, reason: action.reason }),
        });
      }
      this.#store.advanceBlock(blockId, "inconclusive", {
        receiptHash: digest({ blockId, reason: action.reason, health }),
      });
      return action;
    }
    if (action.kind !== "launch_attempt") return action;
    const planned = plannedAttempts.find((attempt) => attempt.id === action.attemptId);
    if (!planned) throw new Error("scheduled attempt is not launchable");

    const integrity = await this.#verifyIntegrity();
    if (!integrity.unchanged) {
      for (const attempt of attempts) {
        if (attempt.status !== "planned") continue;
        this.#store.invalidateAttempt(attempt.id, {
          evidenceHash: digest({
            blockId,
            attemptId: attempt.id,
            reason: "source_integrity_mismatch",
            mismatches: integrity.mismatches,
          }),
        });
      }
      this.#store.advanceBlock(blockId, "inconclusive", {
        receiptHash: digest({
          blockId,
          reason: "source_integrity_mismatch",
          mismatches: integrity.mismatches,
        }),
      });
      return { kind: "mark_block_inconclusive", reason: "source_integrity_mismatch" };
    }

    const launchReceiptHash = digest({
      blockId,
      attemptId: planned.id,
      provider: planned.provider,
      repetition: planned.repetition,
      block,
      launchOrder: this.#launchOrder,
    });
    this.#store.markAttemptLaunched(planned.id, { launchReceiptHash });
    const result = await this.#launcher({
      attemptId: planned.id,
      provider: planned.provider,
      launchReceiptHash,
    });
    this.#store.finishAttempt(planned.id, result);
    return result.status === "completed"
      ? { kind: "attempt_completed", attemptId: planned.id }
      : { kind: "attempt_failed", attemptId: planned.id };
  }
}
