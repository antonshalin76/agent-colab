import { parentPort, workerData } from "node:worker_threads";

const sync = new Int32Array(workerData.barrier);
Atomics.add(sync, 0, 1);
Atomics.notify(sync, 0);
Atomics.wait(sync, 1, 0);

let store;
try {
  const module = await import("../../src/store/flow-telemetry-store.ts");
  store = new module.FlowTelemetryStore(workerData.databasePath);
  const result = store[workerData.method](workerData.input);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  store?.close();
}
