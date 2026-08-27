import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { FlowEvidenceLedger } from "../src/flow/evidence-ledger.js";
import type {
  MapLearningCandidate,
  MapLearningCloseInput,
  MapLearningRuntimeAuthority,
} from "../src/flow/map-learning.js";
import { canonicalFindingExecutorDescriptor } from "../src/flow/learning-policy.js";
import { createReviewRunInput, RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { RunStore } from "../src/store/run-store.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function closureEvidence(input: {
  ledger: FlowEvidenceLedger;
  projectRoot: string;
  candidateSha256: string;
  evidenceIds: [string, string, string];
  finding: ReturnType<typeof closedFinding>;
}) {
  return ([
    { id: input.evidenceIds[0], purpose: "code_or_artifact_fix" },
    { id: input.evidenceIds[1], purpose: "old_code_sensitive_regression" },
    { id: input.evidenceIds[2], purpose: "sibling_surface_scan" },
  ] as const).map((item) => input.ledger.runCanonicalAndRecord({
    projectRoot: input.projectRoot,
    id: item.id,
    purpose: item.purpose,
    artifactHash: input.candidateSha256,
    finding: input.finding,
  }));
}

function closedFinding(input: {
  findingId: string;
  evidenceIds: [string, string, string];
  spec?: {
    owningStage: string;
    affectedScenarioId: string;
    affectedControlId: string;
    missedStage: string;
    escapedOracleId: string;
    testSystemOwnerId: string;
    preventionGuardId: string;
  };
}) {
  const spec = input.spec ?? {
    owningStage: "60_independent_review",
    affectedScenarioId: "BDD-005",
    affectedControlId: "CTRL-009",
    missedStage: "60_independent_review",
    escapedOracleId: "ORACLE-006",
    testSystemOwnerId: "OWNER-005",
    preventionGuardId: "GUARD-009",
  };
  const descriptor = canonicalFindingExecutorDescriptor(
    spec.escapedOracleId,
    spec.affectedControlId,
  );
  if (!descriptor) throw new Error("learning fixture requires a canonical finding executor descriptor");
  return {
    schemaVersion: "finding-lifecycle/v1" as const,
    findingId: input.findingId,
    classification: "test_oracle_gap" as const,
    severity: "P1" as const,
    status: "closed" as const,
    owningStage: spec.owningStage,
    affectedScenarioId: spec.affectedScenarioId,
    affectedControlId: spec.affectedControlId,
    rootCause: "terminal status was treated as approval",
    rootCauseClass: descriptor.rootCauseClass,
    escapeAnalysis: {
      missedStage: spec.missedStage,
      escapedOracleId: spec.escapedOracleId,
      reason: "semantic verdict and launched durable evidence were not checked",
      testSystemOwnerId: spec.testSystemOwnerId,
    },
    closure: {
      fixEvidenceId: input.evidenceIds[0],
      regressionEvidenceId: input.evidenceIds[1],
      regressionMutationId: descriptor.mutationId,
      preventionGuardId: spec.preventionGuardId,
      siblingScanEvidenceId: input.evidenceIds[2],
      invalidatedStageIds: [spec.missedStage],
    },
  };
}

function seedReviewEvidence(databasePath: string, input: {
  reviewId: string;
  projectRoot: string;
  taskPacketBytes: Uint8Array;
  sourceFingerprint: string;
}): ReturnType<RunGateUnitOfWork["get"]> {
  initializeCurrentExecutionSchema(databasePath);
  const reviews = new RunGateUnitOfWork(databasePath);
  const review = reviews.create({
    reviewId: input.reviewId,
    stageId: "90_learning_close",
    artifact: Buffer.from(input.taskPacketBytes),
    health: { codex: "healthy", grok: "healthy" },
    approvalScope: "workspace-read",
    idempotencyKey: `${input.reviewId}:task-packet`,
    prompts: {
      auditor: "Audit the exact MAP learning task packet and candidate.",
      critic: "Challenge the exact MAP learning task packet and candidate.",
    },
    createdAt: 100,
    project: input.projectRoot,
    requester: "codex",
    sourceFingerprint: input.sourceFingerprint,
    changedFiles: 1,
  });
  if (!reviews.barrier(review.reviewId).satisfied) {
    for (const lane of review.lanes) {
      const attempt = lane.attempts.at(-1)!;
      const providerResult = {
        kind: "success",
        agent: lane.agent,
        reviewVerdict: {
          schemaVersion: "review-verdict/v1",
          verdict: "PASS",
          findings: [],
        },
      };
      const runs = new RunStore(databasePath);
      const descriptor = reviews.enqueueDescriptors(review.reviewId).find(
        (candidate) => candidate.agent === lane.agent && candidate.role === lane.role,
      )!;
      const queued = runs.enqueueExact(createReviewRunInput(descriptor));
      const claimed = runs.claimNext({ workerId: "map-learning-fixture", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: lane.agent });
      runs.markLaunched(claimed.id, claimed.leaseToken!, {
        phase: "started",
        pid: 1234,
        agent: lane.agent,
        model: attempt.model,
        effort: attempt.effort,
        policyVersion: attempt.policyVersion,
        sessionId: attempt.sessionId,
      });
      runs.commitDomainEffect({
        id: queued.id,
        token: claimed.leaseToken!,
        providerResult,
        effect: {
          type: "review",
          reviewId: review.reviewId,
          attemptId: attempt.attemptId,
          role: lane.role,
          agent: lane.agent,
          resultKind: "success",
          terminalAt: 300,
        },
        status: "completed",
      });
      reviews.recordTerminal({
        reviewId: review.reviewId,
        agent: lane.agent,
        role: lane.role,
        attemptId: attempt.attemptId,
        status: "completed",
        result: providerResult,
        terminalAt: 300,
      });
      runs.close();
    }
  }
  const completed = reviews.get(review.reviewId);
  reviews.close();
  return completed;
}

export interface PreparedLearningFixture {
  input: MapLearningCloseInput;
  taskPacketBytes: Uint8Array;
  handoffBytes: Uint8Array;
  candidateBytes: Uint8Array;
  authority: MapLearningRuntimeAuthority;
}

export function prepareLearningFixture(input: {
  projectRoot: string;
  candidate: MapLearningCandidate;
  mapVersion: string;
  mapManifestSha256: string;
  findingSpec?: {
    owningStage: string;
    affectedScenarioId: string;
    affectedControlId: string;
    missedStage: string;
    escapedOracleId: string;
    testSystemOwnerId: string;
    preventionGuardId: string;
  };
  controlFingerprint?: () => string;
}): PreparedLearningFixture {
  const candidate: MapLearningCandidate = {
    ...input.candidate,
    controlIds: [...input.candidate.controlIds].sort(),
    consumerScopes: [...input.candidate.consumerScopes].sort() as Array<"codex" | "grok">,
  };
  const candidateBytes = jsonBytes(candidate);
  const candidateSha256 = sha256(candidateBytes);
  const namespace = BigInt(`0x${candidateSha256.slice(0, 12)}`).toString(10);
  const findingId = `FIND-${namespace}`;
  const evidenceIds: [string, string, string] = [
    `EVID-${namespace}1`,
    `EVID-${namespace}2`,
    `EVID-${namespace}3`,
  ];
  const reviewId = `map-learning:${candidateSha256}`;
  const sourceFingerprint = captureWorkspaceFingerprint(input.projectRoot).fingerprint;
  const evidenceDatabasePath = join(
    input.projectRoot,
    "node_modules/.agent-collab-test-state/collaboration.db",
  );
  mkdirSync(dirname(evidenceDatabasePath), { recursive: true });
  const evidence = new FlowEvidenceLedger(evidenceDatabasePath, {
    backend: {
      execute: ({ command }) => ({
        exitCode: command.some((argument) => argument.endsWith("run-old-code-mutation.mjs")) ? 42 : 0,
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:01.000Z",
      }),
    },
    ...(input.controlFingerprint ? { controlFingerprint: input.controlFingerprint } : {}),
  });
  const findingLifecycles = [closedFinding({
    findingId,
    evidenceIds,
    ...(input.findingSpec ? { spec: input.findingSpec } : {}),
  })];
  const evidenceReceipts = closureEvidence({
    ledger: evidence,
    projectRoot: input.projectRoot,
    candidateSha256,
    evidenceIds,
    finding: findingLifecycles[0]!,
  });
  const taskPacketBytes = jsonBytes({
    schemaVersion: "map-learning-task-packet/v1",
    projectRoot: input.projectRoot,
    stageId: "90_learning_close",
    sourceFingerprint,
    reviewId,
    candidateSha256,
    candidate,
    evidenceReceipts,
    findingLifecycles,
  });
  const review = seedReviewEvidence(evidenceDatabasePath, {
    reviewId,
    projectRoot: input.projectRoot,
    taskPacketBytes,
    sourceFingerprint,
  })!;
  const taskPacketSha256 = sha256(taskPacketBytes);
  const regression = evidenceReceipts.find(({ id }) => id === evidenceIds[1])!;
  const sibling = evidenceReceipts.find(({ id }) => id === evidenceIds[2])!;
  const handoffBytes = jsonBytes({
    schemaVersion: "learning-handoff/v1",
    taskPacketSha256,
    mapVersion: input.mapVersion,
    mapManifestSha256: input.mapManifestSha256,
    candidateSha256,
    findingIds: [findingId],
    findingClosures: [{
      findingId,
      status: "closed",
      rootCauseSha256: sha256(findingLifecycles[0]!.rootCause),
      regressionOracleSha256: sha256(jsonBytes(regression)),
      siblingScanSha256: sha256(jsonBytes(sibling)),
    }],
    reviewReceipts: review.lanes.map((lane) => {
      const attempt = lane.attempts.at(-1)!;
      return {
        schemaVersion: "learning-review-receipt/v1",
        reviewId,
        agent: lane.agent,
        role: lane.role,
        sessionId: attempt.sessionId,
        attemptId: attempt.attemptId,
        taskPacketSha256,
        candidateSha256,
        verdict: "PASS",
      };
    }),
  });
  evidence.close();
  return {
    input: {
      taskPacketBytes,
      handoffBytes,
      candidate,
      mapVersion: input.mapVersion,
      mapManifestSha256: input.mapManifestSha256,
    },
    taskPacketBytes,
    handoffBytes,
    candidateBytes,
    authority: {
      databasePath: evidenceDatabasePath,
      ...(input.controlFingerprint ? { controlFingerprint: input.controlFingerprint } : {}),
    },
  };
}
