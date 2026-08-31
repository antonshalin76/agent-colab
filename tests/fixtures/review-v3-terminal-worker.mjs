import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { RunGateUnitOfWork } from "../../src/runtime/run-gate-unit-of-work.ts";

const gate = new Int32Array(workerData.gate);

const rendezvous = () => {
  Atomics.add(gate, 0, 1);
  Atomics.notify(gate, 0);
  while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, Atomics.load(gate, 0));
};

try {
  rendezvous();
  if (workerData.operation === "terminal_insert") {
    const db = new Database(workerData.databasePath);
    db.pragma("busy_timeout = 5000");
    const transaction = db.transaction(() => {
      if (workerData.kind === "spawn") {
        db.prepare(`INSERT INTO runtime_review_spawn_authorities
          (attempt_id,attempt_authority_id,prelaunch_receipt_id,authority_hash,created_at)
          VALUES (?,?,?,?,?)`).run(workerData.attemptId, workerData.authorityId,
            workerData.receiptId, workerData.authorityHash, workerData.now);
      } else {
        db.prepare(`INSERT INTO runtime_review_no_spawn_effects
          (attempt_id,reason,prelaunch_receipt_id,recorded_at)
          VALUES (?,'needs_reconciliation',?,?)`).run(
            workerData.attemptId, workerData.receiptId, workerData.now);
      }
    });
    transaction.immediate();
    db.close();
    parentPort.postMessage({ ok: true, kind: workerData.kind });
  } else {
    const reviews = new RunGateUnitOfWork(workerData.databasePath);
    const captured = reviews.captureReviewReceipt(workerData.capture);
    const result = captured.lifecycle === "orphaned"
      ? { status: "no_spawn", reason: "superseded_receipt" }
      : reviews.applyPrelaunchFence(workerData.fence);
    reviews.close();
    parentPort.postMessage({ ok: true, receiptId: workerData.capture.receiptId, captured, result });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, kind: workerData.kind,
    error: error instanceof Error ? error.message : String(error) });
}
