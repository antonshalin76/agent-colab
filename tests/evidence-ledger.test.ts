import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { FlowEvidenceLedger } from "../src/flow/evidence-ledger.js";

describe("canonical flow evidence ledger", () => {
  it("derives a non-review oracle and owns current executions plus a linked failing old-code mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-ledger-"));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
    const databasePath = join(root, "state.db");
    const execute = vi.fn((input: {
      command: readonly [string, ...string[]];
      cwd: string;
    }) => ({
      exitCode: input.command.some((argument) => argument.endsWith("run-old-code-mutation.mjs")) ? 42 : 0,
      startedAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
    }));
    let controlFingerprint = "c".repeat(64);
    const ledger = new FlowEvidenceLedger(databasePath, {
      backend: { execute },
      controlFingerprint: () => controlFingerprint,
    });
    const storedCounts = () => {
      const database = new Database(databasePath, { readonly: true });
      try {
        return {
          executions: (database.prepare("SELECT COUNT(*) AS count FROM flow_evidence_executions_v9")
            .get() as { count: number }).count,
          receipts: (database.prepare("SELECT COUNT(*) AS count FROM flow_evidence_receipts_v9")
            .get() as { count: number }).count,
        };
      } finally {
        database.close();
      }
    };
    try {
      const purposes = [
        "code_or_artifact_fix",
        "old_code_sensitive_regression",
        "sibling_surface_scan",
      ] as const;
      const finding = {
        schemaVersion: "finding-lifecycle/v1",
        findingId: "FIND-100",
        classification: "process_escape",
        severity: "P1",
        status: "closed",
        owningStage: "90_learning_close",
        affectedScenarioId: "BDD-007",
        affectedControlId: "CTRL-014",
        rootCause: "learning evidence was not bound to canonical execution",
        rootCauseClass: "learning_control_fingerprint_bypass",
        escapeAnalysis: {
          missedStage: "90_learning_close",
          escapedOracleId: "ORACLE-010",
          reason: "caller-authored PASS evidence escaped",
          testSystemOwnerId: "OWNER-007",
        },
        closure: {
          fixEvidenceId: "EVID-100",
          regressionEvidenceId: "EVID-101",
          regressionMutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
          preventionGuardId: "GUARD-010",
          siblingScanEvidenceId: "EVID-102",
          invalidatedStageIds: ["90_learning_close"],
        },
      };
      const receipts = purposes.map((purpose, index) => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: `EVID-10${index}`,
        purpose,
        artifactHash: "a".repeat(64),
        finding,
      }));

      expect(execute).toHaveBeenCalledTimes(4);
      expect(new Set(execute.mock.calls.map(([call]) => JSON.stringify(call.command))).size).toBe(4);
      expect(receipts.map(({ purpose }) => purpose)).toEqual(purposes);
      expect(receipts.map(({ oracleId }) => oracleId)).toEqual([
        "ORACLE-010",
        "ORACLE-010",
        "ORACLE-010",
      ]);
      expect(receipts.map(({ stageId }) => stageId)).toEqual([
        "90_learning_close",
        "90_learning_close",
        "90_learning_close",
      ]);
      expect(receipts.map(({ oldCodeSensitive }) => oldCodeSensitive)).toEqual([false, true, false]);
      expect(receipts.map(({ kind }) => kind)).toEqual(["static_gate", "test", "test"]);
      ledger.requireExact(receipts, [finding]);

      expect(ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-100",
        purpose: "code_or_artifact_fix",
        artifactHash: "a".repeat(64),
        finding,
      })).toEqual(receipts[0]);
      expect(execute).toHaveBeenCalledTimes(4);

      const database = new Database(databasePath, { readonly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM flow_evidence_executions_v9")
          .get()).toEqual({ count: 4 });
        expect(database.prepare(`SELECT COUNT(*) AS count
          FROM flow_evidence_receipts_v9 r
          JOIN flow_evidence_executions_v9 e ON e.execution_key=r.execution_key`).get())
          .toEqual({ count: 3 });
        expect(database.prepare(`SELECT old.exit_code,old.mutation_id,old.finding_id,
            old.affected_control_id,old.prevention_guard_id
          FROM flow_evidence_receipts_v9 r
          JOIN flow_evidence_executions_v9 old ON old.execution_key=r.old_code_execution_key
          WHERE r.evidence_id='EVID-101'`).get()).toEqual({
            exit_code: 42,
            mutation_id: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
            finding_id: "FIND-100",
            affected_control_id: "CTRL-014",
            prevention_guard_id: "GUARD-010",
          });
      } finally { database.close(); }

      expect(() => ledger.requireExact(
        [{ ...receipts[0]!, artifactHash: "b".repeat(64) }], [finding],
      ))
        .toThrow(/canonical runtime execution/i);
      controlFingerprint = "d".repeat(64);
      expect(() => ledger.requireExact(receipts, [finding])).toThrow(/canonical runtime execution/i);
      controlFingerprint = "c".repeat(64);
      const beforeRejectedMappings = storedCounts();
      const unrelatedFinding = structuredClone(finding);
      unrelatedFinding.findingId = "FIND-101";
      unrelatedFinding.rootCause = "a different defect class tried to reuse the cached mutation";
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-101",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding: unrelatedFinding,
      })).toThrow(/causal finding binding|canonical runtime execution/i);
      expect(execute).toHaveBeenCalledTimes(4);
      const mismatchedClass = structuredClone(finding);
      mismatchedClass.findingId = "FIND-102";
      mismatchedClass.affectedControlId = "CTRL-009";
      mismatchedClass.closure.fixEvidenceId = "EVID-110";
      mismatchedClass.closure.regressionEvidenceId = "EVID-111";
      mismatchedClass.closure.siblingScanEvidenceId = "EVID-112";
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-111",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding: mismatchedClass,
      })).toThrow(/ORACLE-010:CTRL-009/);
      expect(execute).toHaveBeenCalledTimes(4);
      const wrongCanonicalClass = structuredClone(finding);
      wrongCanonicalClass.findingId = "FIND-103";
      wrongCanonicalClass.rootCauseClass = "review_semantic_pass_bypass";
      wrongCanonicalClass.closure.fixEvidenceId = "EVID-120";
      wrongCanonicalClass.closure.regressionEvidenceId = "EVID-121";
      wrongCanonicalClass.closure.siblingScanEvidenceId = "EVID-122";
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-121",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding: wrongCanonicalClass,
      })).toThrow(/root.cause class|canonical.*class|mutation/i);
      const wrongMutation = structuredClone(finding);
      wrongMutation.findingId = "FIND-104";
      wrongMutation.closure.fixEvidenceId = "EVID-130";
      wrongMutation.closure.regressionEvidenceId = "EVID-131";
      wrongMutation.closure.siblingScanEvidenceId = "EVID-132";
      wrongMutation.closure.regressionMutationId = "MUTATION-REVIEW-SEMANTIC-PASS";
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-131",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding: wrongMutation,
      })).toThrow(/canonical.*mutation|mutation.*canonical|mutation.*mismatch/i);
      expect(execute).toHaveBeenCalledTimes(4);
      expect(storedCounts()).toEqual(beforeRejectedMappings);
      const matchingNewFinding = structuredClone(finding);
      matchingNewFinding.findingId = "FIND-105";
      matchingNewFinding.rootCause = "the same typed defect class escaped through a new finding";
      matchingNewFinding.closure.fixEvidenceId = "EVID-140";
      matchingNewFinding.closure.regressionEvidenceId = "EVID-141";
      matchingNewFinding.closure.siblingScanEvidenceId = "EVID-142";
      expect(ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-141",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding: matchingNewFinding,
      })).toMatchObject({ result: "PASS", oldCodeSensitive: true });
      expect(execute).toHaveBeenCalledTimes(6);
      const causalDatabase = new Database(databasePath, { readonly: true });
      try {
        expect(causalDatabase.prepare(`SELECT mutation_id,command_json
          FROM flow_evidence_executions_v9
          WHERE finding_id='FIND-105' AND mutation_id IS NOT NULL`).get()).toEqual({
            mutation_id: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
            command_json: JSON.stringify([
              process.execPath,
              join(project, "scripts/run-old-code-mutation.mjs"),
              "learning-control-fingerprint",
            ]),
          });
      } finally {
        causalDatabase.close();
      }
      writeFileSync(join(project, "source.ts"), "export const value = 2;\n");
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-100",
        purpose: "code_or_artifact_fix",
        artifactHash: "a".repeat(64),
        finding,
      })).toThrow(/immutable execution input/i);
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a regression receipt when the code-owned old-code mutation still passes", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-old-code-"));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
    const execute = vi.fn(() => ({
      exitCode: 0,
      startedAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
    }));
    const ledger = new FlowEvidenceLedger(join(root, "state.db"), {
      backend: { execute },
      controlFingerprint: () => "c".repeat(64),
    });
    const finding = {
      schemaVersion: "finding-lifecycle/v1",
      findingId: "FIND-200",
      classification: "process_escape",
      severity: "P1",
      status: "closed",
      owningStage: "90_learning_close",
      affectedScenarioId: "BDD-007",
      affectedControlId: "CTRL-014",
      rootCause: "old code was not proven to fail",
      rootCauseClass: "learning_control_fingerprint_bypass",
      escapeAnalysis: {
        missedStage: "90_learning_close",
        escapedOracleId: "ORACLE-010",
        reason: "a regression label was trusted",
        testSystemOwnerId: "OWNER-007",
      },
      closure: {
        fixEvidenceId: "EVID-200",
        regressionEvidenceId: "EVID-201",
        regressionMutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
        preventionGuardId: "GUARD-010",
        siblingScanEvidenceId: "EVID-202",
        invalidatedStageIds: ["90_learning_close"],
      },
    };
    try {
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-201",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding,
      })).toThrow(/expected mutation-caught exit/i);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-201",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding,
      })).toThrow(/operator reconciliation/i);
      expect(execute).toHaveBeenCalledTimes(1);
      const failed = ledger.inspectClaim("EVID-201");
      expect(failed?.status).toBe("failed");
      expect(ledger.reconcileClaim("EVID-201", {
        expectedRequestKey: failed!.requestKey,
        expectedStatus: "failed",
        expectedOwnerToken: failed!.ownerToken,
        action: "abandon",
        reason: "old-code mutation did not fail and must not be retried",
      }).status).toBe("abandoned");
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: project,
        id: "EVID-201",
        purpose: "old_code_sensitive_regression",
        artifactHash: "a".repeat(64),
        finding,
      })).toThrow(/abandoned/i);
      expect(execute).toHaveBeenCalledTimes(1);
      const database = new Database(join(root, "state.db"), { readonly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM flow_evidence_receipts_v9").get())
          .toEqual({ count: 0 });
      } finally { database.close(); }
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claims an evidence ID durably before invoking its fallible backend", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-claim-"));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
    const finding = {
      schemaVersion: "finding-lifecycle/v1",
      findingId: "FIND-300",
      classification: "process_escape",
      severity: "P1",
      status: "closed",
      owningStage: "90_learning_close",
      affectedScenarioId: "BDD-007",
      affectedControlId: "CTRL-014",
      rootCause: "evidence execution was not claimed before its side effect",
      rootCauseClass: "learning_control_fingerprint_bypass",
      escapeAnalysis: {
        missedStage: "90_learning_close",
        escapedOracleId: "ORACLE-010",
        reason: "concurrent callers could execute the same backend twice",
        testSystemOwnerId: "OWNER-007",
      },
      closure: {
        fixEvidenceId: "EVID-300",
        regressionEvidenceId: "EVID-301",
        regressionMutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
        preventionGuardId: "GUARD-010",
        siblingScanEvidenceId: "EVID-302",
        invalidatedStageIds: ["90_learning_close"],
      },
    };
    const input = {
      projectRoot: project,
      id: "EVID-300",
      purpose: "code_or_artifact_fix" as const,
      artifactHash: "a".repeat(64),
      finding,
    };
    const contenderExecute = vi.fn(() => ({
      exitCode: 0,
      startedAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
    }));
    const contender = new FlowEvidenceLedger(join(root, "state.db"), {
      backend: { execute: contenderExecute },
      controlFingerprint: () => "c".repeat(64),
    });
    const primaryExecute = vi.fn(() => {
      expect(() => contender.runCanonicalAndRecord(input)).toThrow(/already running|in progress/i);
      expect(() => contender.runCanonicalAndRecord({
        ...input,
        artifactHash: "b".repeat(64),
      })).toThrow(/immutable execution claim/i);
      return {
        exitCode: 0,
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:01.000Z",
      };
    });
    const primary = new FlowEvidenceLedger(join(root, "state.db"), {
      backend: { execute: primaryExecute },
      controlFingerprint: () => "c".repeat(64),
    });
    try {
      const receipt = primary.runCanonicalAndRecord(input);
      expect(receipt.result).toBe("PASS");
      expect(primaryExecute).toHaveBeenCalledTimes(1);
      expect(contenderExecute).not.toHaveBeenCalled();
      expect(contender.runCanonicalAndRecord(input)).toEqual(receipt);
      expect(contenderExecute).not.toHaveBeenCalled();
      const database = new Database(join(root, "state.db"), { readonly: true });
      try {
        expect(database.prepare(`SELECT status,COUNT(*) AS count
          FROM flow_evidence_requests_v9 GROUP BY status`).get()).toEqual({
          status: "completed",
          count: 1,
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM flow_evidence_executions_v9").get())
          .toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      primary.close();
      contender.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles failed and stale crash-left claims with lease and owner fencing", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-recovery-"));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
    const finding = {
      schemaVersion: "finding-lifecycle/v1",
      findingId: "FIND-400",
      classification: "process_escape",
      severity: "P1",
      status: "closed",
      owningStage: "90_learning_close",
      affectedScenarioId: "BDD-007",
      affectedControlId: "CTRL-014",
      rootCause: "an evidence claim lacked fenced recovery",
      rootCauseClass: "learning_control_fingerprint_bypass",
      escapeAnalysis: {
        missedStage: "90_learning_close",
        escapedOracleId: "ORACLE-010",
        reason: "a failed or crash-left owner permanently poisoned the evidence ID",
        testSystemOwnerId: "OWNER-007",
      },
      closure: {
        fixEvidenceId: "EVID-400",
        regressionEvidenceId: "EVID-401",
        regressionMutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
        preventionGuardId: "GUARD-010",
        siblingScanEvidenceId: "EVID-402",
        invalidatedStageIds: ["90_learning_close"],
      },
    };
    let now = 1_000;
    let invocation = 0;
    const execute = vi.fn(() => {
      invocation += 1;
      if (invocation === 1 || invocation === 3) throw new Error("simulated executor interruption");
      return {
        exitCode: 0,
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:01.000Z",
      };
    });
    const databasePath = join(root, "state.db");
    const ledger = new FlowEvidenceLedger(databasePath, {
      backend: { execute },
      controlFingerprint: () => "c".repeat(64),
      now: () => now,
      claimLeaseMs: 100,
    });
    const evidenceInput = (id: "EVID-400" | "EVID-402", purpose: "code_or_artifact_fix" | "sibling_surface_scan") => ({
      projectRoot: project,
      id,
      purpose,
      artifactHash: "a".repeat(64),
      finding,
    });
    try {
      expect(() => ledger.runCanonicalAndRecord(evidenceInput("EVID-400", "code_or_artifact_fix")))
        .toThrow(/simulated executor interruption/i);
      const failed = ledger.inspectClaim("EVID-400")!;
      expect(failed).toMatchObject({ status: "failed", attempt: 1 });
      expect(() => ledger.reconcileClaim("EVID-400", {
        expectedRequestKey: failed.requestKey,
        expectedStatus: "failed",
        expectedOwnerToken: "00000000-0000-4000-8000-000000000000",
        action: "retry",
        reason: "verified transient executor interruption",
      })).toThrow(/fence does not match/i);
      expect(ledger.reconcileClaim("EVID-400", {
        expectedRequestKey: failed.requestKey,
        expectedStatus: "failed",
        expectedOwnerToken: failed.ownerToken,
        action: "retry",
        reason: "verified transient executor interruption",
      }).status).toBe("retryable");
      expect(ledger.runCanonicalAndRecord(evidenceInput("EVID-400", "code_or_artifact_fix")))
        .toMatchObject({ result: "PASS" });
      expect(ledger.inspectClaim("EVID-400")).toMatchObject({ status: "completed", attempt: 2 });

      const persistedExecutionCrash = new Database(databasePath);
      try {
        persistedExecutionCrash.prepare(
          "DELETE FROM flow_evidence_receipts_v9 WHERE evidence_id='EVID-400'",
        ).run();
        persistedExecutionCrash.prepare(`UPDATE flow_evidence_requests_v9
          SET status='running',completed_at=NULL,lease_expires_at=? WHERE evidence_id='EVID-400'`)
          .run(now - 1);
      } finally {
        persistedExecutionCrash.close();
      }
      const persistedExecution = ledger.inspectClaim("EVID-400")!;
      expect(ledger.reconcileClaim("EVID-400", {
        expectedRequestKey: persistedExecution.requestKey,
        expectedStatus: "running",
        expectedOwnerToken: persistedExecution.ownerToken,
        action: "retry",
        reason: "receipt commit was interrupted after durable executor result",
      }).status).toBe("retryable");
      expect(ledger.runCanonicalAndRecord(evidenceInput("EVID-400", "code_or_artifact_fix")))
        .toMatchObject({ result: "PASS" });
      expect(ledger.inspectClaim("EVID-400")).toMatchObject({ status: "completed", attempt: 3 });
      expect(execute).toHaveBeenCalledTimes(2);

      expect(() => ledger.runCanonicalAndRecord(evidenceInput("EVID-402", "sibling_surface_scan")))
        .toThrow(/simulated executor interruption/i);
      const crashDatabase = new Database(databasePath);
      try {
        crashDatabase.prepare(`UPDATE flow_evidence_requests_v9
          SET status='running',completed_at=NULL,lease_expires_at=? WHERE evidence_id='EVID-402'`)
          .run(now + 100);
      } finally {
        crashDatabase.close();
      }
      const active = ledger.inspectClaim("EVID-402")!;
      expect(() => ledger.reconcileClaim("EVID-402", {
        expectedRequestKey: active.requestKey,
        expectedStatus: "running",
        expectedOwnerToken: active.ownerToken,
        action: "retry",
        reason: "owner process is absent after simulated crash",
      })).toThrow(/active.*lease/i);
      now += 101;
      expect(ledger.reconcileClaim("EVID-402", {
        expectedRequestKey: active.requestKey,
        expectedStatus: "running",
        expectedOwnerToken: active.ownerToken,
        action: "retry",
        reason: "owner process is absent after simulated crash",
      }).status).toBe("retryable");
      expect(ledger.runCanonicalAndRecord(evidenceInput("EVID-402", "sibling_surface_scan")))
        .toMatchObject({ result: "PASS" });
      expect(ledger.inspectClaim("EVID-402")).toMatchObject({ status: "completed", attempt: 2 });
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported evidence role before invoking the process backend", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-role-"));
    const execute = vi.fn();
    const ledger = new FlowEvidenceLedger(join(root, "state.db"), { backend: { execute } });
    try {
      expect(() => ledger.runCanonicalAndRecord({
        projectRoot: root,
        id: "EVID-999",
        purpose: "general",
        artifactHash: "a".repeat(64),
        finding: {},
      } as never)).toThrow(/no canonical evidence executor/i);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
