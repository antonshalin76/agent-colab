import { createHash, randomUUID } from "node:crypto";
import {
  REVIEW_PROVIDER_IDS,
  selectFixedAgentEffort,
  type ApprovalScope,
  type EffortDecision,
  type ReviewProviderHealthSnapshot,
  type ReviewProviderId,
} from "./routing.js";

export type ReviewRole = "auditor" | "critic";

export interface ReviewInput {
  stageId: string;
  artifact: Buffer;
  health: ReviewProviderHealthSnapshot;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  prompts: Record<ReviewRole, string>;
  sourceFingerprint?: string;
  changedFiles?: number;
}

export const reviewDecisionFor = (
  agent: ReviewProviderId,
  role: ReviewRole,
  input: { attemptOrdinal: number; artifactBytes: number; changedFiles: number },
): EffortDecision => {
  const stage = role === "auditor" ? "code_audit" : "code_critic";
  return Object.freeze(selectFixedAgentEffort({
    stage,
    agent,
    degraded: false,
    trustedInputs: {
      artifactBytes: input.artifactBytes,
      changedFiles: input.changedFiles,
      attemptOrdinal: input.attemptOrdinal,
      approvalScope: "workspace-read",
    },
  }));
};

const decisionFor = (
  agent: ReviewProviderId,
  role: ReviewRole,
  artifactBytes: number,
  changedFiles: number,
  degraded: boolean,
): EffortDecision => {
  return {
    ...reviewDecisionFor(agent, role, {
    attemptOrdinal: 0,
    artifactBytes,
    changedFiles,
    }),
    degraded,
  };
};

export class ReviewLane {
  readonly decision: EffortDecision;
  readonly isolated = true;
  readonly artifactHash: string;
  readonly recomputedHash: string;
  private readonly bytes: Buffer;

  constructor(
    readonly stageId: string,
    readonly agent: ReviewProviderId,
    readonly role: ReviewRole,
    artifact: Buffer,
    readonly approvalScope: ApprovalScope,
    readonly idempotencyKey: string,
    readonly prompt: string,
    readonly sessionId: string,
    changedFiles: number,
    degraded: boolean,
    readonly sourceFingerprint?: string,
  ) {
    if (approvalScope !== "workspace-read") {
      throw new Error("review lanes are read-only and require workspace-read authority");
    }
    this.bytes = Buffer.from(artifact);
    this.artifactHash = createHash("sha256").update(this.bytes).digest("hex");
    this.recomputedHash = createHash("sha256").update(this.bytes).digest("hex");
    this.decision = decisionFor(agent, role, this.bytes.length, changedFiles, degraded);
  }

  get model(): EffortDecision["model"] {
    return this.decision.model;
  }

  get effort(): EffortDecision["effort"] {
    return this.decision.effort;
  }

  get policyVersion(): EffortDecision["policyVersion"] {
    return this.decision.policyVersion;
  }

  get reasons(): EffortDecision["reasons"] {
    return this.decision.reasons;
  }

  get degraded(): boolean {
    return this.decision.degraded;
  }

  get artifact(): Buffer {
    return Buffer.from(this.bytes);
  }
}

export const REVIEW_ROLES: readonly ReviewRole[] = ["auditor", "critic"];
const AGENTS: readonly ReviewProviderId[] = REVIEW_PROVIDER_IDS;
export const REVIEW_TOPOLOGY_KEYS = Object.freeze(
  AGENTS.flatMap((agent) => REVIEW_ROLES.map((role) => `${agent}:${role}`)).sort(),
);

export const hasExactReviewTopology = (
  lanes: readonly { agent: ReviewProviderId; role: ReviewRole }[],
): boolean => {
  const keys = lanes.map(({ agent, role }) => `${agent}:${role}`).sort();
  return keys.length === REVIEW_TOPOLOGY_KEYS.length &&
    keys.every((key, index) => key === REVIEW_TOPOLOGY_KEYS[index]);
};

export const assertExactReviewTopology = (
  lanes: readonly { agent: ReviewProviderId; role: ReviewRole }[],
): void => {
  if (!hasExactReviewTopology(lanes)) {
    throw new Error("review barrier requires the exact codex/grok/claude auditor/critic topology");
  }
};

export const REVIEW_BARRIER_POLICY = Object.freeze({
  requiredAgent: "codex" as const,
  requiredRoles: REVIEW_ROLES,
  optionalAgents: ["grok", "claude"] as const,
  optionalUnavailableBlocks: false,
  optionalChangesRequestedBlocks: true,
  optionalNeedsReconciliationBlocks: true,
});

const makeLane = (
  input: ReviewInput,
  agent: ReviewProviderId,
  role: ReviewRole,
  degraded: boolean,
): ReviewLane =>
  new ReviewLane(
    input.stageId,
    agent,
    role,
    input.artifact,
    input.approvalScope,
    `${input.idempotencyKey}:${agent}:${role}`,
    input.prompts[role],
    randomUUID(),
    input.changedFiles ?? 0,
    degraded,
    input.sourceFingerprint,
  );

export interface ReviewPlan {
  runState: "FULL_CROSS_PROVIDER" | "DEGRADED_REVIEW_SET";
  activeLanes: ReviewLane[];
  deferredLanes: ReviewLane[];
}

export function createReviewPlan(input: ReviewInput): ReviewPlan {
  if (input.approvalScope !== "workspace-read") {
    throw new Error("review is read-only and requires workspace-read authority");
  }
  const healthy = AGENTS.filter((agent) => input.health[agent] === "healthy");
  if (AGENTS.every((agent) => input.health[agent] === "disabled")) {
    throw new Error("No enabled provider is available for review");
  }
  if (input.health.codex === "disabled") {
    throw new Error("mandatory Codex auditor/critic pair is disabled");
  }
  if (healthy.length === AGENTS.length) {
    return {
      runState: "FULL_CROSS_PROVIDER",
      activeLanes: AGENTS.flatMap((agent) => REVIEW_ROLES.map((role) => makeLane(input, agent, role, false))),
      deferredLanes: [],
    };
  }
  const deferred = AGENTS.filter((agent) => !healthy.includes(agent));
  return {
    runState: "DEGRADED_REVIEW_SET",
    activeLanes: healthy.flatMap((agent) => REVIEW_ROLES.map((role) => makeLane(input, agent, role, true))),
    deferredLanes: deferred.flatMap((agent) => REVIEW_ROLES.map((role) => makeLane(input, agent, role, true))),
  };
}

export const createReviewLanes = (input: ReviewInput): ReviewLane[] =>
  createReviewPlan(input).activeLanes;
