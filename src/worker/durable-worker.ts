import type { RunRecord, RunStore } from "../store/run-store.js";
import { sanitizeResult } from "../security/redaction.js";

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
) => Promise<Record<string, unknown>>;
const retryable = new Set(["quota", "rate_limit", "overload", "network_timeout", "model_unavailable", "cli_missing", "auth"]);
const deliveryCompleted = new Set(["success", "handoff_dispatched"]);
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
      ));
      if (domainCommitted) return this.store.get(claimed.id);
      if (typeof result.kind === "string" && retryable.has(result.kind)) {
        const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, claimed.attemptCount - 1));
        this.store.releaseForRetry(claimed.id, claimed.leaseToken!, { nextAttemptAt: now + delayMs });
        return this.store.get(claimed.id);
      }
      if (typeof result.kind === "string" && deliveryCompleted.has(result.kind)) this.store.persistResult(claimed.id, claimed.leaseToken!, result);
      else this.store.fail(claimed.id, claimed.leaseToken!, result);
      if (result.kind === "success" && result.deferredReplay && typeof result.deferredReplay === "object") {
        this.store.enqueue({
          idempotencyKey: `${claimed.idempotencyKey}:cross-provider-replay`,
          stage: `${claimed.stage}:replay`, priority: claimed.priority + 10,
          ...(claimed.artifactHash ? { artifactHash: claimed.artifactHash } : {}),
          ...(claimed.approvalScope ? { approvalScope: claimed.approvalScope } : {}),
          payload: result.deferredReplay as Record<string, unknown>,
          notBefore: now + 60_000,
        });
      }
    } catch (error) {
      if (!domainCommitted) {
        try {
          this.store.fail(claimed.id, claimed.leaseToken!, sanitizeResult({
            kind: "task_failure", error: error instanceof Error ? error.message : String(error),
          }));
        } catch { /* a reconciler may already have fenced the queue lease */ }
      }
    }
    finally { clearInterval(heartbeat); }
    return this.store.get(claimed.id);
  }
  close(): void { this.store.close(); }
}
