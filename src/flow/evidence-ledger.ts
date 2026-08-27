import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";

import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import {
  EvidenceReceiptSchema,
  FindingLifecycleSchema,
  canonicalFindingExecutorDescriptor,
  type CanonicalFindingExecutorDescriptor,
  type EvidenceReceipt,
} from "./learning-policy.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLAIM_LEASE_MS = DEFAULT_TIMEOUT_MS * 2 + 60_000;
const OLD_CODE_CAUGHT_EXIT_CODE = 42;
const CONTROL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type LearningEvidencePurpose =
  | "code_or_artifact_fix"
  | "old_code_sensitive_regression"
  | "sibling_surface_scan";

interface CanonicalExecutor {
  kind: "test" | "static_gate";
  oldCodeSensitive: boolean;
  command: readonly [string, ...string[]];
  oldCodeCommand?: readonly [string, ...string[]];
  mutationId?: "MUTATION-REVIEW-SEMANTIC-PASS" | "MUTATION-LEARNING-CONTROL-FINGERPRINT";
}

interface EvidenceCausalBinding {
  findingId: string;
  classification: string;
  rootCauseSha256: string;
  rootCauseClass: CanonicalFindingExecutorDescriptor["rootCauseClass"];
  regressionMutationId: CanonicalFindingExecutorDescriptor["mutationId"];
  affectedScenarioId: string;
  affectedControlId: string;
  preventionGuardId: string;
}

/** @internal */
export interface CanonicalEvidenceExecutionResult {
  exitCode: number;
  startedAt: string;
  finishedAt: string;
}

/** @internal */
export interface CanonicalEvidenceExecutionBackend {
  execute(input: {
    command: readonly [string, ...string[]];
    cwd: string;
  }): CanonicalEvidenceExecutionResult;
}

const processBackend: CanonicalEvidenceExecutionBackend = {
  execute({ command, cwd }) {
    const startedAt = new Date().toISOString();
    const [file, ...args] = command;
    const result = spawnSync(file, args, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finishedAt = new Date().toISOString();
    if (result.error) throw new Error(`evidence command failed to execute: ${result.error.message}`);
    if (result.status === null) {
      throw new Error(`evidence command terminated by signal: ${String(result.signal)}`);
    }
    return { exitCode: result.status, startedAt, finishedAt };
  },
};

function canonicalExecutor(
  projectRoot: string,
  descriptor: CanonicalFindingExecutorDescriptor,
  purpose: LearningEvidencePurpose,
): CanonicalExecutor {
  const fix: CanonicalExecutor = {
    kind: "static_gate",
    oldCodeSensitive: false,
    command: [
      process.execPath,
      join(projectRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.test.json",
      "--noEmit",
    ],
  };
  if (purpose === "code_or_artifact_fix") return fix;
  if (descriptor.mutationId === "MUTATION-REVIEW-SEMANTIC-PASS") {
    return purpose === "old_code_sensitive_regression" ? {
        kind: "test",
        oldCodeSensitive: true,
        oldCodeCommand: [
          process.execPath,
          join(projectRoot, "scripts/run-old-code-mutation.mjs"),
          "review-semantic-pass",
        ],
        mutationId: "MUTATION-REVIEW-SEMANTIC-PASS",
        command: [
          process.execPath,
          join(projectRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/runtime-review-barrier.test.ts",
          "tests/review-verdict.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--reporter=dot",
        ],
      } : {
        kind: "test",
        oldCodeSensitive: false,
        command: [
          process.execPath,
          join(projectRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/app-service.test.ts",
          "tests/routing-v5-contract.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--reporter=dot",
        ],
      };
  }
  if (descriptor.mutationId === "MUTATION-LEARNING-CONTROL-FINGERPRINT") {
    return purpose === "old_code_sensitive_regression" ? {
        kind: "test",
        oldCodeSensitive: true,
        oldCodeCommand: [
          process.execPath,
          join(projectRoot, "scripts/run-old-code-mutation.mjs"),
          "learning-control-fingerprint",
        ],
        mutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
        command: [
          process.execPath,
          join(projectRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/evidence-ledger.test.ts",
          "tests/map-admin.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--reporter=dot",
        ],
      } : {
        kind: "test",
        oldCodeSensitive: false,
        command: [
          process.execPath,
          join(projectRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/map-framework-integration.test.ts",
          "tests/evidence-ledger.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--reporter=dot",
        ],
      };
  }
  throw new Error(`no canonical executor for mutation: ${String(descriptor.mutationId)}`);
}

function learningEvidenceTarget(
  projectRoot: string,
  findingInput: unknown,
  purpose: LearningEvidencePurpose,
  evidenceId: string,
): { stageId: string; oracleId: string; descriptor: CanonicalFindingExecutorDescriptor;
  finding: ReturnType<typeof FindingLifecycleSchema.parse> } {
  const finding = FindingLifecycleSchema.parse(findingInput);
  if (finding.status !== "closed" || !finding.closure || !finding.escapeAnalysis) {
    throw new Error("canonical evidence execution requires a closed finding lifecycle");
  }
  const evidenceField = {
    code_or_artifact_fix: "fixEvidenceId",
    old_code_sensitive_regression: "regressionEvidenceId",
    sibling_surface_scan: "siblingScanEvidenceId",
  } as const;
  if (finding.closure[evidenceField[purpose]] !== evidenceId) {
    throw new Error("evidence ID does not match the canonical finding lifecycle role");
  }
  const stageId = purpose === "code_or_artifact_fix"
    ? finding.owningStage
    : finding.escapeAnalysis.missedStage;
  const oracleId = finding.escapeAnalysis.escapedOracleId;
  const descriptor = canonicalFindingExecutorDescriptor(oracleId, finding.affectedControlId);
  if (!descriptor) {
    throw new Error(`no canonical ${oracleId}:${finding.affectedControlId} executor for evidence purpose: ${purpose}`);
  }
  if (finding.rootCauseClass !== descriptor.rootCauseClass) {
    throw new Error("finding root-cause class does not match its canonical executor");
  }
  if (finding.closure.regressionMutationId !== descriptor.mutationId) {
    throw new Error("finding regression mutation does not match its canonical executor");
  }
  if (finding.affectedScenarioId !== descriptor.scenarioId ||
      finding.owningStage !== descriptor.stageId ||
      finding.escapeAnalysis.missedStage !== descriptor.stageId ||
      finding.escapeAnalysis.testSystemOwnerId !== descriptor.ownerId ||
      finding.closure.preventionGuardId !== descriptor.guardId ||
      stageId !== descriptor.stageId) {
    throw new Error("finding lifecycle does not resolve its canonical evidence class");
  }
  return { stageId, oracleId, descriptor, finding };
}

function causalBinding(findingInput: unknown): EvidenceCausalBinding {
  const finding = FindingLifecycleSchema.parse(findingInput);
  if (finding.status !== "closed" || !finding.rootCause || !finding.closure) {
    throw new Error("canonical evidence requires a complete closed finding causal binding");
  }
  return {
    findingId: finding.findingId,
    classification: finding.classification,
    rootCauseSha256: sha256(finding.rootCause),
    rootCauseClass: finding.rootCauseClass!,
    regressionMutationId: finding.closure.regressionMutationId,
    affectedScenarioId: finding.affectedScenarioId,
    affectedControlId: finding.affectedControlId,
    preventionGuardId: finding.closure.preventionGuardId,
  };
}

function evidenceCausalBindings(findingInputs: readonly unknown[]): ReadonlyMap<string, EvidenceCausalBinding> {
  const bindings = new Map<string, EvidenceCausalBinding>();
  for (const findingInput of findingInputs) {
    const finding = FindingLifecycleSchema.parse(findingInput);
    const binding = causalBinding(finding);
    for (const evidenceId of [
      finding.closure!.fixEvidenceId,
      finding.closure!.regressionEvidenceId,
      finding.closure!.siblingScanEvidenceId,
    ]) {
      if (bindings.has(evidenceId)) throw new Error(`evidence causal binding is ambiguous: ${evidenceId}`);
      bindings.set(evidenceId, binding);
    }
  }
  return bindings;
}

function canonical(receipt: EvidenceReceipt): string {
  return `${JSON.stringify(EvidenceReceiptSchema.parse(receipt))}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ImmutableEvidenceReceiptInput = Pick<EvidenceReceipt,
  "schemaVersion" | "id" | "kind" | "purpose" | "stageId" | "oracleId" |
  "scope" | "sourceFingerprint" | "artifactHash" | "command" | "cwd" |
  "oldCodeSensitive">;

function evidenceRequestKey(
  input: ImmutableEvidenceReceiptInput,
  controlFingerprint: string,
  causal: EvidenceCausalBinding,
  executor: CanonicalExecutor,
): string {
  return sha256(JSON.stringify({
    schemaVersion: "canonical-evidence-request/v9",
    input: {
      schemaVersion: input.schemaVersion,
      id: input.id,
      kind: input.kind,
      purpose: input.purpose,
      stageId: input.stageId,
      oracleId: input.oracleId,
      scope: input.scope,
      sourceFingerprint: input.sourceFingerprint,
      artifactHash: input.artifactHash,
      command: input.command,
      cwd: input.cwd,
      oldCodeSensitive: input.oldCodeSensitive,
    },
    controlFingerprint,
    causal,
    oldCodeCommand: executor.oldCodeCommand ?? null,
    mutationId: executor.mutationId ?? null,
  }));
}

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  if (absolute !== projectRoot || realpathSync(absolute) !== absolute) {
    throw new Error("evidence project root must be an exact canonical absolute path");
  }
  const metadata = lstatSync(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("evidence project root must be a canonical directory");
  }
  return absolute;
}

/** @internal */
export interface LearningEvidenceExecutionInput {
  projectRoot: string;
  id: string;
  purpose: LearningEvidencePurpose;
  artifactHash: string;
  finding: unknown;
}

/** @internal */
export interface EvidenceClaimSnapshot {
  evidenceId: string;
  requestKey: string;
  status: "running" | "retryable" | "completed" | "failed" | "abandoned";
  ownerToken: string;
  attempt: number;
  claimedAt: number;
  leaseExpiresAt: number;
  completedAt: number | null;
  failureText: string | null;
  recoveryReason: string | null;
  recoveredAt: number | null;
}

/** @internal */
export interface EvidenceClaimReconciliation {
  expectedRequestKey: string;
  expectedStatus: "running" | "failed";
  expectedOwnerToken: string;
  action: "retry" | "abandon";
  reason: string;
}

/** @internal */
export class FlowEvidenceLedger {
  private readonly db: Database.Database;
  private readonly backend: CanonicalEvidenceExecutionBackend;
  private readonly currentControlFingerprint: () => string;
  private readonly now: () => number;
  private readonly claimLeaseMs: number;

  constructor(databasePath: string, options?: {
    backend?: CanonicalEvidenceExecutionBackend;
    controlFingerprint?: () => string;
    now?: () => number;
    claimLeaseMs?: number;
  }) {
    this.db = new Database(databasePath);
    this.backend = options?.backend ?? processBackend;
    this.currentControlFingerprint = options?.controlFingerprint ??
      (() => captureWorkspaceFingerprint(CONTROL_ROOT).fingerprint);
    this.now = options?.now ?? Date.now;
    this.claimLeaseMs = options?.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs <= 0) {
      throw new Error("evidence claim lease must be a positive safe integer");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`CREATE TABLE IF NOT EXISTS flow_evidence_requests_v9 (
      evidence_id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','retryable','completed','failed','abandoned')),
      owner_token TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt > 0),
      claimed_at INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      completed_at INTEGER,
      failure_text TEXT,
      recovery_reason TEXT,
      recovered_at INTEGER
    ); CREATE TABLE IF NOT EXISTS flow_evidence_executions_v9 (
      execution_key TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL REFERENCES flow_evidence_requests_v9(evidence_id),
      purpose TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      finding_classification TEXT NOT NULL,
      root_cause_sha256 TEXT NOT NULL,
      root_cause_class TEXT NOT NULL,
      regression_mutation_id TEXT NOT NULL,
      affected_scenario_id TEXT NOT NULL,
      affected_control_id TEXT NOT NULL,
      prevention_guard_id TEXT NOT NULL,
      mutation_id TEXT,
      command_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      control_fingerprint TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS flow_evidence_receipts_v9 (
      evidence_id TEXT PRIMARY KEY REFERENCES flow_evidence_requests_v9(evidence_id),
      execution_key TEXT NOT NULL REFERENCES flow_evidence_executions_v9(execution_key),
      old_code_execution_key TEXT REFERENCES flow_evidence_executions_v9(execution_key),
      receipt_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    )`);
  }

  private get(id: string): EvidenceReceipt | null {
    const row = this.db.prepare(
      `SELECT r.receipt_json FROM flow_evidence_receipts_v9 r
       JOIN flow_evidence_requests_v9 q ON q.evidence_id=r.evidence_id
       WHERE r.evidence_id=? AND q.status='completed'`,
    ).get(id) as { receipt_json: string } | undefined;
    return row ? EvidenceReceiptSchema.parse(JSON.parse(row.receipt_json)) : null;
  }

  inspectClaim(id: string): EvidenceClaimSnapshot | null {
    if (!/^EVID-\d{3,}$/.test(id)) throw new Error("invalid canonical evidence ID");
    const row = this.db.prepare(`SELECT evidence_id,request_key,status,owner_token,attempt,
      claimed_at,lease_expires_at,completed_at,failure_text,recovery_reason,recovered_at
      FROM flow_evidence_requests_v9 WHERE evidence_id=?`).get(id) as {
        evidence_id: string;
        request_key: string;
        status: EvidenceClaimSnapshot["status"];
        owner_token: string;
        attempt: number;
        claimed_at: number;
        lease_expires_at: number;
        completed_at: number | null;
        failure_text: string | null;
        recovery_reason: string | null;
        recovered_at: number | null;
      } | undefined;
    return row ? {
      evidenceId: row.evidence_id,
      requestKey: row.request_key,
      status: row.status,
      ownerToken: row.owner_token,
      attempt: row.attempt,
      claimedAt: row.claimed_at,
      leaseExpiresAt: row.lease_expires_at,
      completedAt: row.completed_at,
      failureText: row.failure_text,
      recoveryReason: row.recovery_reason,
      recoveredAt: row.recovered_at,
    } : null;
  }

  reconcileClaim(
    id: string,
    input: EvidenceClaimReconciliation,
  ): EvidenceClaimSnapshot {
    if (!/^EVID-\d{3,}$/.test(id)) throw new Error("invalid canonical evidence ID");
    if (!/^[a-f0-9]{64}$/.test(input.expectedRequestKey) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
          .test(input.expectedOwnerToken)) {
      throw new Error("evidence reconciliation fence is malformed");
    }
    if (!["running", "failed"].includes(input.expectedStatus) ||
        !["retry", "abandon"].includes(input.action) || input.reason.length === 0 ||
        input.reason.trim() !== input.reason || input.reason.length > 1000) {
      throw new Error("evidence reconciliation request is malformed");
    }
    this.db.transaction(() => {
      const claim = this.inspectClaim(id);
      if (!claim || claim.requestKey !== input.expectedRequestKey ||
          claim.status !== input.expectedStatus || claim.ownerToken !== input.expectedOwnerToken) {
        throw new Error(`evidence reconciliation fence does not match the current claim: ${id}`);
      }
      const reconciledAt = this.now();
      if (claim.status === "running" && claim.leaseExpiresAt > reconciledAt) {
        throw new Error(`active canonical evidence lease cannot be reconciled: ${id}`);
      }
      const receipt = this.db.prepare(
        "SELECT 1 AS present FROM flow_evidence_receipts_v9 WHERE evidence_id=?",
      ).get(id);
      if (receipt) throw new Error(`completed evidence cannot be reconciled: ${id}`);
      const nextStatus = input.action === "retry" ? "retryable" : "abandoned";
      const recoveryOwnerToken = randomUUID();
      const updated = this.db.prepare(`UPDATE flow_evidence_requests_v9
        SET status=?,owner_token=?,lease_expires_at=?,completed_at=?,recovery_reason=?,recovered_at=?
        WHERE evidence_id=? AND request_key=? AND owner_token=? AND status=?`)
        .run(
          nextStatus,
          recoveryOwnerToken,
          reconciledAt,
          input.action === "abandon" ? reconciledAt : null,
          input.reason,
          reconciledAt,
          id,
          input.expectedRequestKey,
          input.expectedOwnerToken,
          input.expectedStatus,
        );
      if (updated.changes !== 1) throw new Error(`evidence reconciliation CAS failed: ${id}`);
    })();
    const reconciled = this.inspectClaim(id);
    if (!reconciled) throw new Error(`evidence claim disappeared during reconciliation: ${id}`);
    return reconciled;
  }

  runCanonicalAndRecord(input: LearningEvidenceExecutionInput): EvidenceReceipt {
    if (!/^EVID-\d{3,}$/.test(input.id)) throw new Error("invalid canonical evidence ID");
    if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) throw new Error("invalid evidence artifact hash");
    if (!["code_or_artifact_fix", "old_code_sensitive_regression", "sibling_surface_scan"]
      .includes(input.purpose)) {
      throw new Error(`no canonical evidence executor for purpose: ${String(input.purpose)}`);
    }
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const target = learningEvidenceTarget(projectRoot, input.finding, input.purpose, input.id);
    const executor = canonicalExecutor(
      projectRoot,
      target.descriptor,
      input.purpose,
    );
    const causal = causalBinding(target.finding);
    const sourceFingerprint = captureWorkspaceFingerprint(projectRoot).fingerprint;
    const controlFingerprint = this.currentControlFingerprint();
    const expectedInput = {
      schemaVersion: "evidence-receipt/v1" as const,
      id: input.id,
      kind: executor.kind,
      purpose: input.purpose,
      stageId: target.stageId,
      oracleId: target.oracleId,
      scope: "whole_feature" as const,
      sourceFingerprint,
      artifactHash: input.artifactHash,
      command: [...executor.command],
      cwd: projectRoot,
      oldCodeSensitive: executor.oldCodeSensitive,
    };
    const existing = this.get(input.id);
    if (existing) {
      for (const [key, value] of Object.entries(expectedInput)) {
        if (JSON.stringify(existing[key as keyof EvidenceReceipt]) !== JSON.stringify(value)) {
          throw new Error(`evidence ID conflicts with immutable execution input: ${input.id}`);
        }
      }
      this.requireExact([existing], [target.finding]);
      return existing;
    }

    const executionKeyFor = (
      executionRole: "current" | "old_code_negative_control",
      command: readonly [string, ...string[]],
      mutationId: CanonicalExecutor["mutationId"] | null,
    ): string => sha256(JSON.stringify({
      schemaVersion: "canonical-evidence-execution/v9",
      executionRole,
      stageId: target.stageId,
      oracleId: target.oracleId,
      purpose: input.purpose,
      sourceFingerprint,
      controlFingerprint,
      artifactHash: input.artifactHash,
      causal,
      mutationId,
      command,
      cwd: projectRoot,
    }));
    const requestKey = evidenceRequestKey(expectedInput, controlFingerprint, causal, executor);
    const ownerToken = randomUUID();
    const claimedAt = this.now();
    const claimStatus = this.db.transaction((): "owned" | "completed" => {
      const request = this.db.prepare(`SELECT request_key,status
        FROM flow_evidence_requests_v9 WHERE evidence_id=?`).get(input.id) as {
          request_key: string;
          status: EvidenceClaimSnapshot["status"];
        } | undefined;
      if (request) {
        if (request.request_key !== requestKey) {
          throw new Error(`evidence ID conflicts with an immutable execution claim: ${input.id}`);
        }
        if (request.status === "running") {
          throw new Error(`canonical evidence execution is already running: ${input.id}`);
        }
        if (request.status === "failed") {
          throw new Error(`failed canonical evidence claim requires operator reconciliation: ${input.id}`);
        }
        if (request.status === "abandoned") {
          throw new Error(`canonical evidence claim was abandoned by reconciliation: ${input.id}`);
        }
        if (request.status === "retryable") {
          const updated = this.db.prepare(`UPDATE flow_evidence_requests_v9
            SET status='running',owner_token=?,attempt=attempt+1,claimed_at=?,lease_expires_at=?,
                completed_at=NULL,failure_text=NULL
            WHERE evidence_id=? AND request_key=? AND status='retryable'`)
            .run(ownerToken, claimedAt, claimedAt + this.claimLeaseMs, input.id, requestKey);
          if (updated.changes !== 1) throw new Error(`canonical evidence retry claim was lost: ${input.id}`);
          return "owned";
        }
        return "completed";
      }
      this.db.prepare(`INSERT INTO flow_evidence_requests_v9
        (evidence_id,request_key,status,owner_token,attempt,claimed_at,lease_expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(
          input.id, requestKey, "running", ownerToken, 1, claimedAt, claimedAt + this.claimLeaseMs,
        );
      return "owned";
    })();
    if (claimStatus === "completed") {
      const concurrentlyCompleted = this.get(input.id);
      if (!concurrentlyCompleted) {
        throw new Error(`completed canonical evidence claim has no receipt: ${input.id}`);
      }
      for (const [key, value] of Object.entries(expectedInput)) {
        if (JSON.stringify(concurrentlyCompleted[key as keyof EvidenceReceipt]) !== JSON.stringify(value)) {
          throw new Error(`evidence ID conflicts with immutable execution input: ${input.id}`);
        }
      }
      this.requireExact([concurrentlyCompleted], [target.finding]);
      return concurrentlyCompleted;
    }
    let claimSettled = false;
    try {
    const runExecution = (
      executionKey: string,
      command: readonly [string, ...string[]],
      mutationId: CanonicalExecutor["mutationId"] | null,
    ): { exit_code: number; started_at: string; finished_at: string } => {
      let execution = this.db.prepare(`SELECT evidence_id,exit_code,started_at,finished_at
      FROM flow_evidence_executions_v9 WHERE execution_key=?`).get(executionKey) as {
        evidence_id: string;
        exit_code: number;
        started_at: string;
        finished_at: string;
      } | undefined;
      if (execution && execution.evidence_id !== input.id) {
        throw new Error("canonical evidence execution key belongs to another evidence ID");
      }
      if (!execution) {
        const renewedAt = this.now();
        const renewed = this.db.prepare(`UPDATE flow_evidence_requests_v9
          SET lease_expires_at=?
          WHERE evidence_id=? AND request_key=? AND owner_token=? AND status='running'`)
          .run(renewedAt + this.claimLeaseMs, input.id, requestKey, ownerToken);
        if (renewed.changes !== 1) throw new Error(`canonical evidence claim ownership was lost: ${input.id}`);
        const result = this.backend.execute({ command, cwd: projectRoot });
        if (!Number.isSafeInteger(result.exitCode)) throw new Error("canonical evidence executor returned an invalid exit code");
        if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.finishedAt)) ||
            Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
          throw new Error("canonical evidence executor returned an invalid time range");
        }
        execution = this.db.transaction(() => {
          const owned = this.db.prepare(`SELECT 1 AS owned FROM flow_evidence_requests_v9
            WHERE evidence_id=? AND request_key=? AND owner_token=? AND status='running'`)
            .get(input.id, requestKey, ownerToken) as { owned: 1 } | undefined;
          if (!owned) throw new Error(`canonical evidence claim ownership was lost: ${input.id}`);
          this.db.prepare(`INSERT INTO flow_evidence_executions_v9
          (execution_key,evidence_id,purpose,finding_id,finding_classification,root_cause_sha256,
           root_cause_class,regression_mutation_id,
           affected_scenario_id,affected_control_id,prevention_guard_id,mutation_id,
           command_json,cwd,source_fingerprint,control_fingerprint,artifact_hash,
           exit_code,started_at,finished_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            executionKey,
            input.id,
            input.purpose,
            causal.findingId,
            causal.classification,
            causal.rootCauseSha256,
            causal.rootCauseClass,
            causal.regressionMutationId,
            causal.affectedScenarioId,
            causal.affectedControlId,
            causal.preventionGuardId,
            mutationId,
            JSON.stringify(command),
            projectRoot,
            sourceFingerprint,
            controlFingerprint,
            input.artifactHash,
            result.exitCode,
            result.startedAt,
            result.finishedAt,
          );
          return this.db.prepare(`SELECT evidence_id,exit_code,started_at,finished_at
          FROM flow_evidence_executions_v9 WHERE execution_key=?`).get(executionKey) as {
            evidence_id: string;
            exit_code: number;
            started_at: string;
            finished_at: string;
          } | undefined;
        })();
        if (!execution) throw new Error("evidence execution persistence failed");
      }
      return execution;
    };
    let oldCodeExecutionKey: string | null = null;
    if (executor.oldCodeCommand) {
      if (!executor.mutationId) throw new Error("old-code executor lacks an authoritative mutation identity");
      oldCodeExecutionKey = executionKeyFor(
        "old_code_negative_control", executor.oldCodeCommand, executor.mutationId,
      );
      const oldCodeExecution = runExecution(
        oldCodeExecutionKey, executor.oldCodeCommand, executor.mutationId,
      );
      if (oldCodeExecution.exit_code !== OLD_CODE_CAUGHT_EXIT_CODE) {
        throw new Error("old-code negative control did not produce the expected mutation-caught exit");
      }
    }
    const executionKey = executionKeyFor("current", executor.command, null);
    const execution = runExecution(executionKey, executor.command, null);
    const receipt = EvidenceReceiptSchema.parse({
      ...expectedInput,
      exitCode: execution.exit_code,
      result: execution.exit_code === 0 ? "PASS" : "FAIL",
      startedAt: execution.started_at,
      finishedAt: execution.finished_at,
    });
    const encoded = canonical(receipt);
    const persisted = this.db.transaction((): EvidenceReceipt => {
      const request = this.db.prepare(`SELECT request_key,status,owner_token
        FROM flow_evidence_requests_v9 WHERE evidence_id=?`).get(receipt.id) as {
          request_key: string;
          status: string;
          owner_token: string;
        } | undefined;
      if (!request || request.request_key !== requestKey || request.status !== "running" ||
          request.owner_token !== ownerToken) {
        throw new Error(`canonical evidence claim ownership was lost: ${receipt.id}`);
      }
      this.db.prepare(`INSERT INTO flow_evidence_receipts_v9
        (evidence_id,execution_key,old_code_execution_key,receipt_sha256,receipt_json,recorded_at)
        VALUES(?,?,?,?,?,?)`).run(
          receipt.id,
          executionKey,
          oldCodeExecutionKey,
          sha256(encoded),
          encoded,
          this.now(),
        );
      this.db.prepare(`UPDATE flow_evidence_requests_v9
        SET status='completed',completed_at=?,lease_expires_at=?
        WHERE evidence_id=? AND request_key=? AND owner_token=? AND status='running'`)
        .run(this.now(), this.now(), receipt.id, requestKey, ownerToken);
      const completed = this.get(receipt.id);
      if (!completed || canonical(completed) !== encoded) {
        throw new Error(`evidence ID conflicts with a concurrent immutable receipt: ${receipt.id}`);
      }
      this.requireExact([completed], [target.finding]);
      return completed;
    })();
    claimSettled = true;
    return persisted;
    } catch (error) {
      if (!claimSettled) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
        const failedAt = this.now();
        this.db.prepare(`UPDATE flow_evidence_requests_v9
          SET status='failed',completed_at=?,lease_expires_at=?,failure_text=?
          WHERE evidence_id=? AND request_key=? AND owner_token=? AND status='running'`)
          .run(failedAt, failedAt, message, input.id, requestKey, ownerToken);
      }
      throw error;
    }
  }

  requireExact(receipts: readonly EvidenceReceipt[], findingInputs: readonly unknown[]): void {
    const currentControlFingerprint = this.currentControlFingerprint();
    const causalBindings = evidenceCausalBindings(findingInputs);
    for (const input of receipts) {
      const receipt = EvidenceReceiptSchema.parse(input);
      if (![
        "code_or_artifact_fix",
        "old_code_sensitive_regression",
        "sibling_surface_scan",
      ].includes(receipt.purpose)) {
        throw new Error(`learning evidence has no canonical runtime executor: ${receipt.id}`);
      }
      const projectRoot = canonicalProjectRoot(receipt.cwd ?? "");
      const causal = causalBindings.get(receipt.id);
      if (!causal) throw new Error(`learning evidence lacks its exact causal finding binding: ${receipt.id}`);
      const executor = canonicalExecutor(
        projectRoot,
        (() => {
          const descriptor = canonicalFindingExecutorDescriptor(
            receipt.oracleId,
            causal.affectedControlId,
          );
          if (!descriptor || descriptor.rootCauseClass !== causal.rootCauseClass ||
              descriptor.mutationId !== causal.regressionMutationId) {
            throw new Error(`learning evidence has no exact canonical causal executor: ${receipt.id}`);
          }
          return descriptor;
        })(),
        receipt.purpose as LearningEvidencePurpose,
      );
      const encoded = canonical(receipt);
      const row = this.db.prepare(`SELECT
          r.receipt_sha256,r.receipt_json,r.old_code_execution_key,
          q.request_key,q.status AS request_status,
          e.evidence_id AS execution_evidence_id,e.purpose,e.finding_id,e.finding_classification,e.root_cause_sha256,
          e.root_cause_class,e.regression_mutation_id,
          e.affected_scenario_id,e.affected_control_id,e.prevention_guard_id,e.mutation_id,
          e.command_json,e.cwd,e.source_fingerprint,e.control_fingerprint,
          e.artifact_hash,e.exit_code,e.started_at,e.finished_at,
          old.evidence_id AS old_evidence_id,
          old.finding_id AS old_finding_id,old.finding_classification AS old_finding_classification,
          old.root_cause_sha256 AS old_root_cause_sha256,
          old.root_cause_class AS old_root_cause_class,
          old.regression_mutation_id AS old_regression_mutation_id,
          old.affected_scenario_id AS old_affected_scenario_id,
          old.affected_control_id AS old_affected_control_id,
          old.prevention_guard_id AS old_prevention_guard_id,old.mutation_id AS old_mutation_id,
          old.command_json AS old_command_json,old.cwd AS old_cwd,
          old.source_fingerprint AS old_source_fingerprint,
          old.control_fingerprint AS old_control_fingerprint,
          old.artifact_hash AS old_artifact_hash,old.exit_code AS old_exit_code
        FROM flow_evidence_receipts_v9 r
        JOIN flow_evidence_requests_v9 q ON q.evidence_id=r.evidence_id
        JOIN flow_evidence_executions_v9 e ON e.execution_key=r.execution_key
        LEFT JOIN flow_evidence_executions_v9 old ON old.execution_key=r.old_code_execution_key
        WHERE r.evidence_id=?`).get(receipt.id) as {
          receipt_sha256: string;
          receipt_json: string;
          old_code_execution_key: string | null;
          request_key: string;
          request_status: string;
          execution_evidence_id: string;
          purpose: string;
          finding_id: string;
          finding_classification: string;
          root_cause_sha256: string;
          root_cause_class: string;
          regression_mutation_id: string;
          affected_scenario_id: string;
          affected_control_id: string;
          prevention_guard_id: string;
          mutation_id: string | null;
          command_json: string;
          cwd: string;
          source_fingerprint: string;
          control_fingerprint: string;
          artifact_hash: string;
          exit_code: number;
          started_at: string;
          finished_at: string;
          old_evidence_id: string | null;
          old_finding_id: string | null;
          old_finding_classification: string | null;
          old_root_cause_sha256: string | null;
          old_root_cause_class: string | null;
          old_regression_mutation_id: string | null;
          old_affected_scenario_id: string | null;
          old_affected_control_id: string | null;
          old_prevention_guard_id: string | null;
          old_mutation_id: string | null;
          old_command_json: string | null;
          old_cwd: string | null;
          old_source_fingerprint: string | null;
          old_control_fingerprint: string | null;
          old_artifact_hash: string | null;
          old_exit_code: number | null;
        } | undefined;
      const oldCodeResolved = executor.oldCodeCommand === undefined
        ? row?.old_code_execution_key === null && row?.old_command_json === null &&
          row?.mutation_id === null && !receipt.oldCodeSensitive
        : row?.old_code_execution_key !== null &&
          row?.old_evidence_id === receipt.id &&
          row?.old_mutation_id === executor.mutationId &&
          row?.old_finding_id === causal.findingId &&
          row?.old_finding_classification === causal.classification &&
          row?.old_root_cause_sha256 === causal.rootCauseSha256 &&
          row?.old_root_cause_class === causal.rootCauseClass &&
          row?.old_regression_mutation_id === causal.regressionMutationId &&
          row?.old_affected_scenario_id === causal.affectedScenarioId &&
          row?.old_affected_control_id === causal.affectedControlId &&
          row?.old_prevention_guard_id === causal.preventionGuardId &&
          row?.old_command_json === JSON.stringify(executor.oldCodeCommand) &&
          row?.old_cwd === projectRoot &&
          row?.old_source_fingerprint === receipt.sourceFingerprint &&
          row?.old_control_fingerprint === currentControlFingerprint &&
          row?.old_artifact_hash === receipt.artifactHash &&
          row?.old_exit_code === OLD_CODE_CAUGHT_EXIT_CODE &&
          receipt.oldCodeSensitive;
      const expectedRequestKey = evidenceRequestKey(receipt, currentControlFingerprint, causal, executor);
      if (!row || row.request_key !== expectedRequestKey || row.request_status !== "completed" ||
          row.execution_evidence_id !== receipt.id ||
          row.receipt_sha256 !== sha256(encoded) || row.receipt_json !== encoded ||
          row.purpose !== receipt.purpose || row.finding_id !== causal.findingId ||
          row.finding_classification !== causal.classification ||
          row.root_cause_sha256 !== causal.rootCauseSha256 ||
          row.root_cause_class !== causal.rootCauseClass ||
          row.regression_mutation_id !== causal.regressionMutationId ||
          row.affected_scenario_id !== causal.affectedScenarioId ||
          row.affected_control_id !== causal.affectedControlId ||
          row.prevention_guard_id !== causal.preventionGuardId || row.mutation_id !== null ||
          row.command_json !== JSON.stringify(receipt.command) ||
          row.cwd !== receipt.cwd || row.source_fingerprint !== receipt.sourceFingerprint ||
          row.control_fingerprint !== currentControlFingerprint ||
          row.artifact_hash !== receipt.artifactHash || row.exit_code !== receipt.exitCode ||
          row.started_at !== receipt.startedAt || row.finished_at !== receipt.finishedAt ||
          receipt.cwd !== projectRoot || receipt.sourceFingerprint !== captureWorkspaceFingerprint(projectRoot).fingerprint ||
          receipt.scope !== "whole_feature" || receipt.kind !== executor.kind ||
          receipt.oldCodeSensitive !== executor.oldCodeSensitive || !oldCodeResolved ||
          JSON.stringify(receipt.command) !== JSON.stringify(executor.command)) {
        throw new Error(`learning evidence is not resolved by a canonical runtime execution: ${receipt.id}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
