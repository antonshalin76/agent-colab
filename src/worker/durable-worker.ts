import type { RunRecord, RunStore } from "../store/run-store.js";
import { sanitizeResult } from "../security/redaction.js";
import { isFailoverOutcome } from "../domain/outcomes.js";

export type CommitDomainEffect = (input: {
  providerResult: Record<string, unknown>;
  effect: Record<string, unknown>;
  status: "completed" | "failed";
}) => void;
export type Runner = (
  run: RunRecord,
  onLaunch: (info: Record<string, unknown>) => void,
  commitDomainEffect: CommitDomainEffect,
  persistExecutionContext: (context: Record<string, unknown>) => void,
  onLaunchIntent: (info: Record<string, unknown>) => void,
  onProvenNoSpawn: () => void,
) => Promise<Record<string, unknown>>;
export class DurableWorker {
  private readonly store: RunStore; private readonly workerId: string; private readonly runner: Runner; private readonly leaseMs: number;
  constructor(input: { store: RunStore; workerId: string; runner: Runner; leaseMs?: number }) {
    this.store = input.store; this.workerId = input.workerId; this.runner = input.runner; this.leaseMs = input.leaseMs ?? 120_000;
  }
  async runOnce(now = Date.now()): Promise<RunRecord | undefined> {
    const claimed = this.store.claimNext({ workerId: this.workerId, leaseMs: this.leaseMs, now });
    if (!claimed) return undefined;
    const heartbeat = setInterval(() => {
      this.store.renewLease(claimed.id, claimed.leaseToken!, Date.now() + this.leaseMs);
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    let domainCommitted = false;
    try {
      const result = sanitizeResult(await this.runner(
        claimed,
        (info) => this.store.markLaunched(claimed.id, claimed.leaseToken!, { workerId: this.workerId, ...info }),
        (input) => {
          if (domainCommitted) throw new Error("domain effect was already committed");
          this.store.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, ...input });
          domainCommitted = true;
        },
        (context) => this.store.recordExecutionContext(claimed.id, claimed.leaseToken!, context),
        (info) => this.store.markLaunchIntent(
          claimed.id,
          claimed.leaseToken!,
          { workerId: this.workerId, ...info },
        ),
        () => this.store.clearLaunchIntent(claimed.id, claimed.leaseToken!),
      ));
      if (domainCommitted) return this.store.get(claimed.id);
      const current = this.store.get(claimed.id);
      if (current?.launched &&
          result.kind !== "success") {
        this.store.markNeedsReconciliation(claimed.id, claimed.leaseToken!, result);
        return this.store.get(claimed.id);
      }
      if (isFailoverOutcome(result.kind)) {
        const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, claimed.attemptCount - 1));
        this.store.releaseForRetry(claimed.id, claimed.leaseToken!, { nextAttemptAt: now + delayMs });
        return this.store.get(claimed.id);
      }
      if (result.kind === "success") this.store.persistResult(claimed.id, claimed.leaseToken!, result);
      else this.store.fail(claimed.id, claimed.leaseToken!, result);
    } catch (error) {
      if (!domainCommitted) {
        try {
          const failure = sanitizeResult({
            kind: "task_failure", error: error instanceof Error ? error.message : String(error),
          });
          if (this.store.get(claimed.id)?.launched) {
            this.store.markNeedsReconciliation(claimed.id, claimed.leaseToken!, failure);
          } else {
            this.store.fail(claimed.id, claimed.leaseToken!, failure);
          }
        } catch { /* a reconciler may already have fenced the queue lease */ }
      }
    }
    finally { clearInterval(heartbeat); }
    return this.store.get(claimed.id);
  }
  close(): void { this.store.close(); }
}
