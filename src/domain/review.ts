import { createHash, randomUUID } from "node:crypto";
import {
  selectFixedAgentEffort,
  type AgentId,
  type ApprovalScope,
  type EffortDecision,
  type ProviderHealthSnapshot,
} from "./routing.js";

export type ReviewRole = "auditor" | "critic";

export interface ReviewInput {
  stageId: string;
  artifact: Buffer;
  health: ProviderHealthSnapshot;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  prompts: Record<ReviewRole, string>;
  changedFiles?: number;
}

export const reviewDecisionFor = (
  agent: AgentId,
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
  agent: AgentId,
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
    readonly agent: AgentId,
    readonly role: ReviewRole,
    artifact: Buffer,
    readonly approvalScope: ApprovalScope,
    readonly idempotencyKey: string,
    readonly prompt: string,
    readonly sessionId: string,
    changedFiles: number,
    degraded: boolean,
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

const ROLES: readonly ReviewRole[] = ["auditor", "critic"];
const AGENTS: readonly AgentId[] = ["grok", "codex"];

const makeLane = (
  input: ReviewInput,
  agent: AgentId,
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
  );

export interface ReviewPlan {
  runState: "FULL_CROSS_PROVIDER" | "DEGRADED_SINGLE_PROVIDER";
  activeLanes: ReviewLane[];
  deferredLanes: ReviewLane[];
}

export function createReviewPlan(input: ReviewInput): ReviewPlan {
  if (input.approvalScope !== "workspace-read") {
    throw new Error("review is read-only and requires workspace-read authority");
  }
  const healthy = AGENTS.filter((agent) => input.health[agent] === "healthy");
  if (healthy.length === 0) throw new Error("No healthy provider is available for review");
  if (healthy.length === 2) {
    return {
      runState: "FULL_CROSS_PROVIDER",
      activeLanes: AGENTS.flatMap((agent) => ROLES.map((role) => makeLane(input, agent, role, false))),
      deferredLanes: [],
    };
  }
  const active = healthy[0]!;
  const deferred = active === "grok" ? "codex" : "grok";
  return {
    runState: "DEGRADED_SINGLE_PROVIDER",
    activeLanes: ROLES.map((role) => makeLane(input, active, role, true)),
    deferredLanes: ROLES.map((role) => makeLane(input, deferred, role, true)),
  };
}

export const createReviewLanes = (input: ReviewInput): ReviewLane[] =>
  createReviewPlan(input).activeLanes;
