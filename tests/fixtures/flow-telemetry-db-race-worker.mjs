import { rmSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

const READY = 0;
const START = 1;
const TRANSACTION_ATTEMPT = 2;
const COMPLETED = 6;
const sync = new Int32Array(workerData.control);
const timeoutMs = Number(workerData.timeoutMs);

const signal = (cell) => {
  Atomics.store(sync, cell, 1);
  Atomics.notify(sync, cell);
};

let database;
try {
  database = new Database(workerData.databasePath);
  database.exec("BEGIN IMMEDIATE");
  signal(READY);
  if (Atomics.wait(sync, START, 0, timeoutMs) === "timed-out") {
    throw new Error("database race worker timed out waiting for start");
  }
  if (Atomics.wait(sync, TRANSACTION_ATTEMPT, 0, timeoutMs) === "timed-out") {
    throw new Error("database race worker timed out waiting for transaction attempt");
  }
  rmSync(workerData.archivePath);
  writeFileSync(workerData.archivePath, Buffer.from(workerData.archiveBase64, "base64"), { mode: 0o600 });
  database.exec("COMMIT");
  parentPort?.postMessage({ ok: true });
} catch (error) {
  try { if (database?.inTransaction) database.exec("ROLLBACK"); } catch { /* best effort */ }
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  database?.close();
  signal(COMPLETED);
}
