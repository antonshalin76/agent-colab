import { sanitizeTelemetryProjection } from "./flow-telemetry.js";

export interface TelemetryExportDispatch {
  readonly dispatched: true;
  readonly delivery: "best_effort_duplicate_or_loss_possible";
}

const DISPATCHED: TelemetryExportDispatch = Object.freeze({
  dispatched: true,
  delivery: "best_effort_duplicate_or_loss_possible",
});

export function dispatchTelemetryExport(input: {
  readonly exporter: (payload: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}): TelemetryExportDispatch {
  if (typeof input.exporter !== "function") throw new Error("telemetry exporter must be callable");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("telemetry export timeout must be a positive safe integer");
  }
  const payload = sanitizeTelemetryProjection(input.payload);
  queueMicrotask(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("telemetry export deadline exceeded")), input.timeoutMs);
      timer.unref();
    });
    const delivery = Promise.resolve().then(() => input.exporter(payload));
    void Promise.race([delivery, deadline])
      .catch(() => undefined)
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  });
  return DISPATCHED;
}
