import { createHash } from "node:crypto";
import type { Stage } from "../domain/routing.js";
import type { ExecutionSnapshot } from "./execution-snapshot.js";

export interface MapAdmissionGate {
  name: "architecture" | "implementer-readiness";
  stageId: "map-architecture-gate" | "map-implementer-readiness-gate";
  prompt: string;
}

export interface MapAdmissionProof {
  schemaVersion: "map-admission/v1";
  targetStageId: string;
  targetSha256: string;
  sourceFingerprint: string;
  mapProfileSha256: string;
  gates: Array<{
    name: MapAdmissionGate["name"];
    stageId: MapAdmissionGate["stageId"];
    reviewId: string;
  }>;
}

const sortedRecord = (record: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

export const mapProfileSha256 = (profile: ExecutionSnapshot["mapProfile"]): string =>
  createHash("sha256").update(`${JSON.stringify({ ...profile,
    upstreamSkillInventory: [...profile.upstreamSkillInventory].sort(),
    managedFileSha256: sortedRecord(profile.managedFileSha256),
    outsideScopeSha256: sortedRecord(profile.outsideScopeSha256),
  })}\n`).digest("hex");

const ARCHITECTURE_GATE_STAGES = new Set<Stage>([
  "planning",
  "prd",
  "architecture",
  "ui_ux",
  "bdd",
  "tdd_coding",
  "unit_testing",
  "e2e_infrastructure",
  "e2e_testing",
]);

const READINESS_GATE_STAGES = new Set<Stage>([
  "tdd_coding",
  "unit_testing",
  "e2e_infrastructure",
  "e2e_testing",
]);

export const mapAdmissionGates = (stage: Stage): MapAdmissionGate[] => [
  ...(ARCHITECTURE_GATE_STAGES.has(stage) ? [{
    name: "architecture" as const,
    stageId: "map-architecture-gate" as const,
    prompt: "MAP mandatory architecture gate. Audit ownership, persistence, state transitions, recovery, configuration, security, CI and integration boundaries. Reject micro-patches that leave a systemic hole.",
  }] : []),
  ...(READINESS_GATE_STAGES.has(stage) ? [{
    name: "implementer-readiness" as const,
    stageId: "map-implementer-readiness-gate" as const,
    prompt: "MAP mandatory implementer-readiness gate. Verify BDD/TDD contracts, failing-test evidence, acceptance oracles, mutation boundaries, rollback and focused verification before implementation starts.",
  }] : []),
];

export const mapAdmissionReviewId = (
  project: string,
  targetStageId: string,
  gateStageId: MapAdmissionGate["stageId"],
): string => `${createHash("sha256").update(project).digest("hex").slice(0, 24)}:${targetStageId}:${gateStageId}`;

export const mapAdmissionReviewExpectation = (input: {
  project: string;
  targetStageId: string;
  gate: MapAdmissionGate;
  artifact: Uint8Array;
  sourceFingerprint: string;
  changedFiles: number;
}) => {
  const reviewId = mapAdmissionReviewId(
    input.project,
    input.targetStageId,
    input.gate.stageId,
  );
  return {
    reviewId,
    stageId: input.gate.stageId,
    artifact: Buffer.from(input.artifact),
    approvalScope: "workspace-read" as const,
    idempotencyKey: reviewId,
    prompts: {
      auditor: `AUDITOR independent lane. ${input.gate.prompt}`,
      critic: `CRITIC independent lane. ${input.gate.prompt}`,
    },
    project: input.project,
    requester: "codex" as const,
    sourceFingerprint: input.sourceFingerprint,
    changedFiles: input.changedFiles,
  };
};
