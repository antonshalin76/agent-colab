import { parentPort, workerData } from "node:worker_threads";
import { RunGateUnitOfWork } from "../../src/runtime/run-gate-unit-of-work.ts";

const gate = new Int32Array(workerData.gate);
const reviews = new RunGateUnitOfWork(workerData.databasePath);

try {
  const invoke = (faultInjector) => workerData.operation === "prelaunch"
    ? reviews.applyPrelaunchFence({ ...workerData.input, ...(faultInjector ? { faultInjector } : {}) })
    : reviews.activateDeferred({ ...workerData.input, ...(faultInjector ? { faultInjector } : {}) });
  if (workerData.role === "leader") {
    const result = invoke((point) => {
        const barrierPoint = workerData.operation === "prelaunch"
          ? "after_prelaunch_begin" : "after_activation_begin";
        if (point !== barrierPoint) return;
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
    });
    parentPort.postMessage({ ok: true, result });
  } else {
    while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    parentPort.postMessage({ ok: true, result: invoke() });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  reviews.close();
}
