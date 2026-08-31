import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import * as reviewRuntime from "../src/runtime/run-gate-unit-of-work.js";

const roots: string[] = [];
const domain = Buffer.from("agent-collab/review-attempt/v1\0");

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-attempt-identity-"));
  roots.push(root);
  return join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type IdentityFactory = (input: {
  reviewId: string;
  barrierIdempotencyKey: string;
  agent: "grok" | "claude" | "codex";
  role: "auditor" | "critic";
  ordinal: number;
  legacySessionId?: string;
  legacyIdempotencyKey?: string;
}) => { attemptId: string; sessionId: string; idempotencyKey: string; canonicalIdentity: string };

const identityFactory = (): IdentityFactory => {
  const candidate = (reviewRuntime as unknown as Record<string, unknown>).createReviewAttemptIdentity;
  expect(candidate, "createReviewAttemptIdentity must be the sole versioned identity owner")
    .toBeTypeOf("function");
  return candidate as IdentityFactory;
};

function expectedV8(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("immutable review attempt identity", () => {
  it("preserves ordinal-zero legacy bytes and derives later UUIDv8 identities from canonical bytes", () => {
    const createIdentity = identityFactory();
    const base = {
      reviewId: "review",
      barrierIdempotencyKey: "barrier-key",
      agent: "claude" as const,
      role: "critic" as const,
    };
    expect(createIdentity({ ...base, ordinal: 0,
      legacySessionId: "legacy-session", legacyIdempotencyKey: "legacy-key" })).toMatchObject({
      sessionId: "legacy-session",
      idempotencyKey: "legacy-key",
    });

    const canonicalIdentity = canonicalize({
      schemaVersion: "review-attempt-identity/v1",
      reviewId: "review",
      barrierIdempotencyKey: "barrier-key",
      agent: "claude",
      role: "critic",
      ordinal: 1,
    })!;
    const digest = createHash("sha256").update(domain).update(canonicalIdentity).digest();
    const uuid = expectedV8(digest);
    expect(createIdentity({ ...base, ordinal: 1 })).toEqual({
      attemptId: uuid,
      sessionId: `review-attempt-${uuid}`,
      idempotencyKey: `barrier-key:review-attempt:${digest.toString("hex")}`,
      canonicalIdentity,
    });
    expect(createIdentity({ ...base, ordinal: 1 })).toEqual(createIdentity({ ...base, ordinal: 1 }));
    expect(createIdentity({ ...base, ordinal: 2 }).attemptId).not.toBe(uuid);
  });

  it("requires every v3 attempt link to own immutable identity and base-policy fields", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path, { readonly: true });
    const columns = db.prepare("PRAGMA table_info(runtime_review_lane_attempts)").all() as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    const required = [
      "attempt_id", "authority_id", "base_policy_id", "authority_kind", "model", "effort",
      "policy_version", "reasons_json", "session_id", "idempotency_key",
      "expected_lane_revision", "expected_attempt_ordinal", "authority_receipt_id",
    ];
    expect(required.every((name) => columns.some((column) => column.name === name))).toBe(true);
    expect(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_attempt_base_policies'`).pluck().get()).toMatch(/immutable|base_policy/i);
    const linkSql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
      AND name='runtime_review_lane_attempts'`).pluck().get()).toLowerCase().replace(/\s+/g, " ");
    expect(linkSql).toMatch(/authority_kind[^,]*check|check\s*\([^)]*authority_kind/);
    expect(linkSql).toContain("authority_kind = 'initial'");
    expect(linkSql).toMatch(/authority_kind = 'initial'[^)]*attempt_ordinal = 0[^)]*recovery_generation is null[^)]*previous_ordinal is null[^)]*previous_evidence_hash is null/);
    expect(linkSql).toMatch(/authority_kind = 'first_admission'[^)]*attempt_ordinal = 0[^)]*recovery_generation is not null[^)]*previous_ordinal is null[^)]*previous_evidence_hash is null/);
    expect(linkSql).toMatch(/authority_kind = 'recovery'[^)]*attempt_ordinal > 0[^)]*recovery_generation is not null[^)]*previous_ordinal = attempt_ordinal - 1[^)]*previous_evidence_hash is not null/);
    db.close();
  });

  it("does not derive historical verification from the mutable lane projection", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const db = new Database(path);
    const triggerNames = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'runtime_review_attempt_%immutable%' ORDER BY name`).pluck().all();
    expect(triggerNames).toEqual([
      "runtime_review_attempt_delete_immutable",
      "runtime_review_attempt_update_immutable",
    ]);
    expect(String(db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='runtime_review_attempt_update_immutable'`).pluck().get()))
      .toMatch(/before update[\s\S]*raise\s*\(\s*abort[\s\S]*immutable/i);
    db.close();
  });

  it.each([
    { column: "session_id", value: "corrupted-link" },
    { column: "base_policy_id", value: "corrupted-policy" },
    { column: "authority_id", value: "corrupted-authority" },
    { column: "previous_evidence_hash", value: "e".repeat(64) },
  ])("keeps history stable and reconciles immutable $column corruption", ({ column, value }) => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const reviews = new reviewRuntime.RunGateUnitOfWork(path);
    const captureCandidate = (reviews as unknown as Record<string, unknown>).captureReviewReceipt;
    expect(captureCandidate).toBeTypeOf("function");
    const capture = (captureCandidate as (input: Record<string, unknown>) => Record<string, unknown>)
      .bind(reviews);
    const admissionReceipts: Array<Record<string, unknown>> = [];
    for (const role of ["auditor", "critic"] as const) {
      const activationNonce = `identity-${role}`;
      const pair: Record<string, unknown> = { agent: "codex", role, activationNonce };
      for (const kind of ["source", "readiness"] as const) {
        const receiptId = `identity-${role}-${kind}`;
        capture({ receiptId, phase: "admission",
          scope: `review/identity-review/codex/${role}/${kind}`, scopeRevision: 1,
          activationNonce, expectedTuple: {
            laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null,
          }, recoveryGeneration: null,
          observation: kind === "source" ? { sourceFingerprint: "source-v1", valid: true }
            : { harnessReady: true, valid: true }, predecessorReceiptId: null, createdAt: 1 });
        pair[`${kind}ReceiptId`] = receiptId;
      }
      admissionReceipts.push(pair);
    }
    const create = reviews.create.bind(reviews) as unknown as
      (input: Record<string, unknown>) => unknown;
    create({ reviewId: "identity-review", stageId: "stage", artifact: Buffer.from("candidate"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read", idempotencyKey: "identity-review", prompts: {
        auditor: "audit", critic: "critic",
      }, createdAt: 2, project: "/repo", requester: "codex", sourceFingerprint: "source-v1",
      changedFiles: 1, admissionReceipts });
    const before = reviews.attempts("identity-review", "codex", "auditor");
    const db = new Database(path);
    db.prepare(`UPDATE runtime_review_lanes SET session_id='mutable-projection-drift'
      WHERE review_id='identity-review' AND agent='codex' AND role='auditor'`).run();
    expect(reviews.attempts("identity-review", "codex", "auditor")).toEqual(before);

    db.exec("DROP TRIGGER runtime_review_attempt_update_immutable");
    db.pragma("ignore_check_constraints = ON");
    const attemptId = before[0]!.attemptId;
    db.prepare(`UPDATE runtime_review_lane_attempts SET ${column}=?
      WHERE attempt_id=?`).run(value, attemptId);
    db.close();
    expect(reviews.attempts("identity-review", "codex", "auditor").at(-1)?.status)
      .toBe("needs_reconciliation");
    reviews.close();

    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare(`SELECT ${column} FROM runtime_review_lane_attempts
      WHERE review_id='identity-review' AND agent='codex' AND role='auditor'`)
      .pluck().get()).toBe(value);
    expect(reopened.prepare(`SELECT COUNT(*) FROM runtime_review_lane_attempts
      WHERE review_id='identity-review' AND agent='codex' AND role='auditor'`).pluck().get()).toBe(1);
    expect(reopened.prepare(`SELECT status FROM runs WHERE id=(SELECT run_id
      FROM runtime_review_lane_attempts WHERE attempt_id=?)`).pluck().get(attemptId))
      .toBe("needs_reconciliation");
    expect(reopened.prepare(`SELECT COUNT(*) FROM runtime_review_generation_consumptions
      WHERE review_id='identity-review' AND agent='codex' AND role='auditor'`).pluck().get()).toBe(0);
    reopened.close();
  });
});
