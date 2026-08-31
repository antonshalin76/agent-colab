import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";

const roots: string[] = [];

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-receipt-ledger-"));
  roots.push(root);
  return join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const envelope = {
  receiptId: "receipt-1",
  phase: "admission",
  scope: "review/review-1/claude/auditor/source",
  scopeRevision: 1,
  activationNonce: "nonce-1",
  expectedTuple: { laneRevision: 2, latestOrdinal: 0, latestEvidenceHash: "evidence-0" },
  recoveryGeneration: 101,
  observation: { sourceFingerprint: "source-v1", valid: true },
  predecessorReceiptId: null,
};

const canonicalBytes = JSON.stringify(envelope);
const envelopeHash = createHash("sha256").update(canonicalBytes).digest("hex");
const observationJson = JSON.stringify(envelope.observation);
const observationHash = createHash("sha256").update(observationJson).digest("hex");
const expectedTupleJson = JSON.stringify(envelope.expectedTuple);

describe("immutable review receipt ledger", () => {
  it("publishes source/readiness as one atomic pair and never exposes mixed heads", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const store = new RunGateUnitOfWork(path);
    const method = (store as unknown as Record<string, unknown>).captureReviewReceiptPair;
    expect(method, "admission evidence pair must have one transaction owner").toBeTypeOf("function");
    const capturePair = (method as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(store);
    const pair = {
      pairId: "pair-1", phase: "admission", activationNonce: "pair-nonce",
      scopeRevision: 1, recoveryGeneration: 101,
      expectedTuple: envelope.expectedTuple, predecessorReceiptIds: { source: null, readiness: null },
      receipts: {
        source: { receiptId: "pair-source", scope: `${envelope.scope}/source`,
          observation: envelope.observation },
        readiness: { receiptId: "pair-readiness", scope: `${envelope.scope}/readiness`,
          observation: { harnessReady: true, valid: true } },
      }, createdAt: 90,
    };
    expect(() => capturePair({ ...pair, faultInjector: (point: string) => {
      if (point === "after_first_pair_envelope") throw new Error("pair split fault");
    } })).toThrow(/pair split fault/);
    let db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_receipts").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_receipt_heads").pluck().get()).toBe(0);
    db.close();
    expect(capturePair(pair)).toMatchObject({ pairId: "pair-1", lifecycle: "pending" });
    db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT receipt_id,activation_nonce FROM runtime_review_receipt_heads
      ORDER BY scope`).all()).toEqual([
      { receipt_id: "pair-readiness", activation_nonce: "pair-nonce" },
      { receipt_id: "pair-source", activation_nonce: "pair-nonce" },
    ]);
    expect(db.prepare(`SELECT COUNT(DISTINCT activation_nonce) FROM runtime_review_receipt_heads`)
      .pluck().get()).toBe(1);
    db.close(); store.close();
  });

  it("keeps envelope bytes immutable and records exactly one terminal lifecycle row", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO runtime_review_receipts
      (receipt_id,phase,scope,scope_revision,activation_nonce,expected_tuple_json,
       recovery_generation,observation_json,observation_hash,predecessor_receipt_id,
       canonical_bytes,envelope_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      envelope.receiptId, envelope.phase, envelope.scope, envelope.scopeRevision,
      envelope.activationNonce, expectedTupleJson, envelope.recoveryGeneration,
      observationJson, observationHash, null, canonicalBytes, envelopeHash, 100,
    );
    db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
      (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
       recovery_generation,predecessor_receipt_id,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      envelope.receiptId, "consumed", envelope.scopeRevision, envelope.activationNonce,
      expectedTupleJson, envelope.recoveryGeneration, null, 101,
    );

    expect(() => db.prepare(`INSERT INTO runtime_review_receipt_lifecycle
      (receipt_id,state,scope_revision,activation_nonce,expected_tuple_json,
       recovery_generation,predecessor_receipt_id,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      envelope.receiptId, "superseded", envelope.scopeRevision, envelope.activationNonce,
      expectedTupleJson, envelope.recoveryGeneration, null, 102,
    )).toThrow(/unique|constraint/i);
    const immutableMutations: Array<[string, unknown]> = [
      ["phase", "prelaunch"], ["scope", `${envelope.scope}/mutated`], ["scope_revision", 2],
      ["activation_nonce", "mutated"], ["expected_tuple_json", "{}"],
      ["recovery_generation", 102], ["observation_json", "{}"],
      ["observation_hash", "f".repeat(64)], ["predecessor_receipt_id", "other"],
      ["canonical_bytes", "{}"], ["envelope_hash", "e".repeat(64)], ["created_at", 999],
    ];
    for (const [column, value] of immutableMutations) {
      expect(() => db.prepare(`UPDATE runtime_review_receipts SET ${column}=?
        WHERE receipt_id=?`).run(value, envelope.receiptId), column).toThrow(/immutable/i);
    }
    expect(() => db.prepare(`DELETE FROM runtime_review_receipts WHERE receipt_id=?`)
      .run(envelope.receiptId)).toThrow(/immutable/i);
    expect(() => db.prepare(`UPDATE runtime_review_receipt_lifecycle SET state='orphaned'
      WHERE receipt_id=?`).run(envelope.receiptId)).toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM runtime_review_receipt_lifecycle WHERE receipt_id=?`)
      .run(envelope.receiptId)).toThrow(/immutable/i);
    db.close();

    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT canonical_bytes,envelope_hash,observation_hash
      FROM runtime_review_receipts WHERE receipt_id=?`).get(envelope.receiptId)).toEqual({
      canonical_bytes: canonicalBytes,
      envelope_hash: envelopeHash,
      observation_hash: observationHash,
    });
    expect(reopened.prepare(`SELECT receipt_id,state,scope_revision,activation_nonce,
      expected_tuple_json,recovery_generation,predecessor_receipt_id
      FROM runtime_review_receipt_lifecycle WHERE receipt_id=?`).all(envelope.receiptId)).toEqual([{
      receipt_id: envelope.receiptId,
      state: "consumed",
      scope_revision: envelope.scopeRevision,
      activation_nonce: envelope.activationNonce,
      expected_tuple_json: expectedTupleJson,
      recovery_generation: envelope.recoveryGeneration,
      predecessor_receipt_id: null,
    }]);
    reopened.close();
  });

  it("enforces one pending head per exact scope and leaves losing captures non-authorizing", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    const sql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_receipt_heads'`).pluck().get());
    expect(sql).toMatch(/scope[^,]*primary key|unique\s*\(\s*scope\s*\)/i);
    const lifecycleSql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_receipt_lifecycle'`).pluck().get());
    expect(lifecycleSql).toMatch(/receipt_id[^,]*primary key|unique\s*\(\s*receipt_id\s*\)/i);
    expect(lifecycleSql).toMatch(/consumed/);
    expect(lifecycleSql).toMatch(/superseded/);
    expect(lifecycleSql).toMatch(/orphaned/);
    db.prepare(`INSERT INTO runtime_review_receipt_heads
      (scope,receipt_id,scope_revision,activation_nonce) VALUES ('genesis','r1',1,'n1')`).run();
    expect(() => db.prepare(`INSERT INTO runtime_review_receipt_heads
      (scope,receipt_id,scope_revision,activation_nonce) VALUES ('genesis','r2',1,'n2')`).run())
      .toThrow(/unique|primary key|constraint/i);
    db.close();
  });

  it("performs predecessor CAS, atomic supersession, orphaning, and response replay on real SQLite", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const firstStore = new RunGateUnitOfWork(path);
    const contenderStore = new RunGateUnitOfWork(path);
    const captureOf = (store: RunGateUnitOfWork) => {
      const method = (store as unknown as Record<string, unknown>).captureReviewReceipt;
      expect(method, "receipt capture must use the durable repository seam").toBeTypeOf("function");
      return (method as (input: Record<string, unknown>) => Record<string, unknown>).bind(store);
    };
    const captureFirst = captureOf(firstStore);
    const captureContender = captureOf(contenderStore);
    const base = {
      receiptId: "cas-r1", phase: "admission", scope: envelope.scope, scopeRevision: 1,
      activationNonce: "cas-n1", expectedTuple: envelope.expectedTuple,
      recoveryGeneration: envelope.recoveryGeneration, observation: envelope.observation,
      predecessorReceiptId: null, createdAt: 200,
    };
    const r1 = captureFirst(base);
    expect(r1).toMatchObject({ receiptId: "cas-r1", lifecycle: "pending" });
    expect(captureFirst(base)).toEqual(r1);

    const r2 = captureContender({ ...base, receiptId: "cas-r2", scopeRevision: 2,
      activationNonce: "cas-n2", predecessorReceiptId: "cas-r1", createdAt: 201 });
    expect(r2).toMatchObject({ receiptId: "cas-r2", lifecycle: "pending" });
    const loser = captureFirst({ ...base, receiptId: "cas-loser", scopeRevision: 2,
      activationNonce: "cas-loser", predecessorReceiptId: "cas-r1", createdAt: 201 });
    expect(loser).toMatchObject({ receiptId: "cas-loser", lifecycle: "orphaned",
      currentHeadReceiptId: "cas-r2" });
    firstStore.close();
    contenderStore.close();

    const db = new Database(path, { readonly: true });
    expect(db.prepare(`SELECT scope,receipt_id,scope_revision FROM runtime_review_receipt_heads
      WHERE scope=?`).get(envelope.scope)).toEqual({
      scope: envelope.scope, receipt_id: "cas-r2", scope_revision: 2,
    });
    expect(db.prepare(`SELECT receipt_id,state FROM runtime_review_receipt_lifecycle
      WHERE receipt_id IN ('cas-r1','cas-r2','cas-loser') ORDER BY receipt_id`).all()).toEqual([
      { receipt_id: "cas-loser", state: "orphaned" },
      { receipt_id: "cas-r1", state: "superseded" },
    ]);
    db.close();
  });

  it("fences a managed predecessor-read/head-CAS interleaving across two SQLite owners", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const firstStore = new RunGateUnitOfWork(path);
    const secondStore = new RunGateUnitOfWork(path);
    const capture = (store: RunGateUnitOfWork) => {
      const method = (store as unknown as Record<string, unknown>).captureReviewReceipt;
      expect(method).toBeTypeOf("function");
      return (method as (input: Record<string, unknown>) => Record<string, unknown>).bind(store);
    };
    const first = capture(firstStore);
    const second = capture(secondStore);
    const base = { ...envelope, receiptId: "race-base", activationNonce: "race-base",
      predecessorReceiptId: null, createdAt: 400 };
    first(base);
    expect(() => first({ ...base, receiptId: "race-a", scopeRevision: 2,
      activationNonce: "race-a", predecessorReceiptId: "race-base", createdAt: 401,
      faultInjector: (point: string) => {
        if (point === "after_receipt_predecessor_read_before_head_cas") {
          throw new Error("managed CAS pause");
        }
      } })).toThrow(/managed CAS pause/);
    const winner = second({ ...base, receiptId: "race-b", scopeRevision: 2,
      activationNonce: "race-b", predecessorReceiptId: "race-base", createdAt: 402 });
    expect(winner).toMatchObject({ receiptId: "race-b", lifecycle: "pending" });
    const loser = first({ ...base, receiptId: "race-a-retry", scopeRevision: 2,
      activationNonce: "race-a-retry", predecessorReceiptId: "race-base", createdAt: 403 });
    expect(loser).toMatchObject({ lifecycle: "orphaned", currentHeadReceiptId: "race-b" });
    firstStore.close();
    secondStore.close();
  });

  it.each([
    "after_envelope_insert",
    "after_predecessor_terminal",
    "before_head_cas",
    "before_receipt_commit",
  ])("rolls back receipt capture at %s", (faultPoint) => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const store = new RunGateUnitOfWork(path);
    const method = (store as unknown as Record<string, unknown>).captureReviewReceipt;
    expect(method).toBeTypeOf("function");
    const capture = (method as (input: Record<string, unknown>) => unknown).bind(store);
    expect(() => capture({ ...envelope, observation: envelope.observation, createdAt: 300,
      faultInjector: (point: string) => {
        if (point === faultPoint) throw new Error(`injected receipt fault: ${faultPoint}`);
      } })).toThrow(/injected receipt fault/i);
    store.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_receipts").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_receipt_lifecycle").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM runtime_review_receipt_heads").pluck().get()).toBe(0);
    db.close();
  });
});
