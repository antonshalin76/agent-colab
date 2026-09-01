import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const graphTables = (): string[] => [...readFileSync(
  resolve("docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql"),
  "utf8",
).matchAll(/CREATE TABLE ([a-z0-9_]+)/g)].map((match) => match[1]!);

export function installGraphV4Schema(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(readFileSync(resolve("docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql"), "utf8"));
  } finally {
    db.close();
  }
}

export function dropGraphV4Schema(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const table of graphTables().reverse()) {
        db.exec(`DROP TABLE IF EXISTS "${table.replaceAll('"', '""')}"`);
      }
    }).exclusive();
  } finally {
    db.close();
  }
}

export function dropReviewV3Extension(path: string): void {
  const db = new Database(path);
  try {
    const extensionTriggers = db.prepare(`SELECT name FROM sqlite_schema
      WHERE type='trigger' AND name NOT IN (
        'runtime_review_attempt_v2_insert',
        'runtime_review_attempt_v2_update',
        'runtime_review_barrier_v2_update'
      ) AND (name LIKE 'runtime_review_%' OR name LIKE 'runtime_provider_recovery_%')`)
      .pluck().all() as string[];
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const trigger of extensionTriggers) db.exec(`DROP TRIGGER "${trigger.replaceAll('"', '""')}"`);
      for (const table of [
        "runtime_review_no_spawn_effects",
        "runtime_review_spawn_authorities",
        "runtime_review_generation_consumptions",
        "runtime_review_attempt_authorities",
        "runtime_review_receipt_lifecycle",
        "runtime_review_receipt_heads",
        "runtime_review_receipts",
        "runtime_review_attempt_base_policies",
        "runtime_provider_recovery_generations",
        "runtime_schema_capabilities",
      ]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }).exclusive();
  } finally {
    db.close();
  }
}
