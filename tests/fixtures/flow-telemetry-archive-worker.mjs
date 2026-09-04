import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const CELL = {
  ready: 0,
  start: 1,
  beforeAcquire: 2,
  contended: 3,
  acquired: 4,
  release: 5,
  completed: 6,
};
const sync = new Int32Array(workerData.control);
const timeoutMs = Number(workerData.timeoutMs);

const signal = (cell) => {
  Atomics.store(sync, cell, 1);
  Atomics.notify(sync, cell);
};
const wait = (cell, label) => {
  const result = Atomics.wait(sync, cell, 0, timeoutMs);
  if (result === "timed-out") throw new Error(`archive worker timed out waiting for ${label}`);
};

signal(CELL.ready);

let store;
let files;
let outcome;
let lockObservation = null;
try {
  wait(CELL.start, "start");
  const [{ FlowTelemetryStore }, { StateFileDurability }, { FlowTelemetryArchiveService }] = await Promise.all([
    import("../../src/store/flow-telemetry-store.ts"),
    import("../../src/store/state-file-durability.ts"),
    import("../../src/app/flow-telemetry-archive-service.ts"),
  ]);
  store = new FlowTelemetryStore(workerData.databasePath);
  files = new StateFileDurability({
    stateRoot: dirname(workerData.databasePath),
    faultInjector(point, details) {
      if (details && typeof details === "object" &&
          typeof details.lockBasename === "string" && typeof details.lockKey === "string") {
        lockObservation = {
          lockBasename: details.lockBasename,
          lockKey: details.lockKey,
        };
      }
      if (point === workerData.faultPoints.beforeLock) signal(CELL.beforeAcquire);
      if (point === workerData.faultPoints.contendedLock) signal(CELL.contended);
      if (point !== workerData.faultPoints.acquiredLock) return;
      signal(CELL.acquired);
      if (workerData.hangAfterAcquire === true) {
        Atomics.wait(sync, CELL.completed, 0, Math.min(Math.max(timeoutMs * 2, 5_000), 60_000));
      }
      if (workerData.holdAfterAcquire === true) wait(CELL.release, "release");
    },
  });
  const service = new FlowTelemetryArchiveService({ store, files });
  const result = service.archive(workerData.input);
  outcome = { ok: true, result, lockObservation };
} catch (error) {
  outcome = { ok: false, error: error instanceof Error ? error.message : String(error), lockObservation };
} finally {
  const cleanupErrors = [];
  try {
    files?.close?.();
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    store?.close();
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (cleanupErrors.length > 0) {
    outcome = { ok: false, error: `worker cleanup failed: ${cleanupErrors.join("; ")}`, priorOutcome: outcome };
  }
  try {
    signal(CELL.completed);
  } finally {
    parentPort?.postMessage(outcome);
  }
}
