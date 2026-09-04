import { setTimeout as delay } from "node:timers/promises";

import type { ProviderRecoveryResult } from "../runtime/provider-recovery-loop.js";
import type { ReviewEffectReplayResult } from "./review-worker-runtime.js";

export interface ReviewWorkerLoopRuntime {
  runOnce(now?: number): Promise<unknown | undefined>;
  stop(): void;
  close(): void;
}

export interface ReviewControlLoopRuntime {
  recover(now?: number): Promise<{ expired: number; replay: ReviewEffectReplayResult }>;
  recoverProviders(now?: number): Promise<readonly ProviderRecoveryResult[]>;
  stop(): void;
  close(): void;
}

export interface ReviewWorkerOperationalObservation {
  readonly expired: number;
  readonly replay: ReviewEffectReplayResult;
  readonly providers: readonly ProviderRecoveryResult[];
}

export class ReviewWorkerService {
  private stopping = false;

  constructor(private readonly input: {
    readonly workers: readonly ReviewWorkerLoopRuntime[];
    readonly control: ReviewControlLoopRuntime;
    readonly recoveryIntervalMs?: number;
    readonly idleIntervalMs?: number;
    readonly now?: () => number;
    readonly delay?: (milliseconds: number) => Promise<void>;
    readonly onRecovery?: (observation: ReviewWorkerOperationalObservation) => void;
  }) {
    if (input.workers.length === 0) throw new Error("review worker service requires an execution worker");
    const recoveryIntervalMs = input.recoveryIntervalMs ?? 30_000;
    const idleIntervalMs = input.idleIntervalMs ?? 500;
    if (!Number.isSafeInteger(recoveryIntervalMs) || recoveryIntervalMs <= 0 ||
        !Number.isSafeInteger(idleIntervalMs) || idleIntervalMs <= 0) {
      throw new Error("review worker service intervals must be positive integers");
    }
  }

  async run(): Promise<void> {
    if (this.stopping) throw new Error("review worker service is already stopped");
    const now = this.input.now ?? Date.now;
    const pause = this.input.delay ?? ((milliseconds) => delay(milliseconds));
    const idleIntervalMs = this.input.idleIntervalMs ?? 500;
    const recoveryIntervalMs = this.input.recoveryIntervalMs ?? 30_000;
    let lastRecovery: number | undefined;
    const controlLoop = async (): Promise<void> => {
      while (!this.stopping) {
        const observedAt = now();
        if (lastRecovery === undefined || observedAt - lastRecovery >= recoveryIntervalMs) {
          const queue = await this.input.control.recover(observedAt);
          const providers = await this.input.control.recoverProviders(observedAt);
          this.input.onRecovery?.({ ...queue, providers });
          lastRecovery = observedAt;
        }
        if (!this.stopping) await pause(idleIntervalMs);
      }
    };
    const executionLoop = async (worker: ReviewWorkerLoopRuntime): Promise<void> => {
      while (!this.stopping) {
        if (await worker.runOnce(now()) === undefined && !this.stopping) {
          await pause(idleIntervalMs);
        }
      }
    };
    const guarded = async (loop: () => Promise<void>): Promise<void> => {
      try { await loop(); }
      catch (error) {
        if (this.stopping) return;
        this.stop();
        throw error;
      }
    };
    const loops = [guarded(controlLoop), ...this.input.workers.map((worker) =>
      guarded(() => executionLoop(worker)))];
    try {
      const settled = await Promise.allSettled(loops);
      const failure = settled.find((result): result is PromiseRejectedResult =>
        result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      this.stop();
      await Promise.allSettled(loops);
      this.input.control.close();
      for (const worker of this.input.workers) worker.close();
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.input.control.stop();
    for (const worker of this.input.workers) worker.stop();
  }
}
