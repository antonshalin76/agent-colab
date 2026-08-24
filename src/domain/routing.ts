export type ActiveAgentId = "grok" | "codex";
export type AgentId = ActiveAgentId;
export type ProviderHealth = "healthy" | "unavailable" | "probing" | "disabled";
export type ProviderHealthSnapshot = Record<ActiveAgentId, ProviderHealth>;
export type Effort = "low" | "medium" | "high" | "xhigh";
export type RequestedEffort = Effort | "max" | "ultra";
export type ApprovalScope = "workspace-read" | "workspace-write" | "external";

export const ROUTING_POLICY_VERSION = "routing-v3" as const;

export const STAGES = [
  "coordination",
  "planning",
  "plan_audit",
  "plan_critic",
  "prd",
  "prd_audit",
  "prd_critic",
  "architecture",
  "architecture_audit",
  "architecture_critic",
  "ui_ux",
  "bdd",
  "tdd_coding",
  "unit_testing",
  "e2e_infrastructure",
  "e2e_testing",
  "test_audit",
  "test_critic",
  "code_audit",
  "code_critic",
  "code_review",
] as const;

export type Stage = (typeof STAGES)[number];

export interface StagePolicy {
  readonly preferredAgent: ActiveAgentId;
  readonly baselineEffort: Readonly<Record<ActiveAgentId, Effort>>;
}

export const STAGE_POLICY = {
  coordination: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "medium" },
  },
  planning: {
    preferredAgent: "grok",
    baselineEffort: { grok: "medium", codex: "medium" },
  },
  plan_audit: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  plan_critic: {
    preferredAgent: "codex",
    baselineEffort: { grok: "xhigh", codex: "xhigh" },
  },
  prd: {
    preferredAgent: "grok",
    baselineEffort: { grok: "medium", codex: "medium" },
  },
  prd_audit: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  prd_critic: {
    preferredAgent: "codex",
    baselineEffort: { grok: "xhigh", codex: "xhigh" },
  },
  architecture: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  architecture_audit: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  architecture_critic: {
    preferredAgent: "codex",
    baselineEffort: { grok: "xhigh", codex: "xhigh" },
  },
  ui_ux: {
    preferredAgent: "grok",
    baselineEffort: { grok: "medium", codex: "medium" },
  },
  bdd: {
    preferredAgent: "grok",
    baselineEffort: { grok: "high", codex: "high" },
  },
  tdd_coding: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  unit_testing: {
    preferredAgent: "codex",
    baselineEffort: { grok: "medium", codex: "medium" },
  },
  e2e_infrastructure: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  e2e_testing: {
    preferredAgent: "grok",
    baselineEffort: { grok: "high", codex: "high" },
  },
  test_audit: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  test_critic: {
    preferredAgent: "codex",
    baselineEffort: { grok: "xhigh", codex: "xhigh" },
  },
  code_audit: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
  code_critic: {
    preferredAgent: "codex",
    baselineEffort: { grok: "xhigh", codex: "xhigh" },
  },
  code_review: {
    preferredAgent: "codex",
    baselineEffort: { grok: "high", codex: "high" },
  },
} as const satisfies Record<Stage, StagePolicy>;

export interface TrustedEffortInputs {
  readonly artifactBytes: number;
  readonly changedFiles: number;
  readonly attemptOrdinal: number;
  readonly approvalScope: ApprovalScope;
}

export type EffortReason =
  | `stage_baseline:${Stage}:${Effort}`
  | "degraded_fallback"
  | "retry"
  | "external_scope"
  | "large_artifact"
  | "broad_change_set"
  | `provider_policy_limit:gpt-5.6-sol:${Effort}`
  | `model_capability_limit:grok-4.6:${Effort}`;

export interface EffortDecision {
  readonly agent: ActiveAgentId;
  readonly model: "grok-4.6" | "gpt-5.6-sol";
  readonly effort: Effort;
  readonly policyVersion: typeof ROUTING_POLICY_VERSION;
  readonly reasons: readonly EffortReason[];
  readonly degraded: boolean;
}

export interface SelectStageAssignmentInput {
  readonly stage: Stage;
  readonly origin: ActiveAgentId;
  readonly health: ProviderHealthSnapshot;
  readonly trustedInputs: TrustedEffortInputs;
}

export interface SelectFixedAgentEffortInput {
  readonly stage: Stage;
  readonly agent: ActiveAgentId;
  readonly trustedInputs: TrustedEffortInputs;
  readonly degraded: boolean;
}

const REQUESTED_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const PROVIDER_EFFORT_PROFILES = {
  grok: {
    model: "grok-4.6",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    policyMaximum: null,
  },
  codex: {
    model: "gpt-5.6-sol",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    policyMaximum: "xhigh",
  },
} as const satisfies Record<ActiveAgentId, {
  readonly model: "grok-4.6" | "gpt-5.6-sol";
  readonly supportedEfforts: readonly RequestedEffort[];
  readonly policyMaximum: Effort | null;
}>;

const effortIndex = (effort: RequestedEffort): number =>
  REQUESTED_EFFORT_LADDER.indexOf(effort);

export const increaseRequestedEffort = (
  effort: RequestedEffort,
  times = 1,
): RequestedEffort => {
  const index = effortIndex(effort);
  return REQUESTED_EFFORT_LADDER[
    Math.min(index + Math.max(0, times), REQUESTED_EFFORT_LADDER.length - 1)
  ]!;
};

export type EffortLimitReason = Extract<
  EffortReason,
  `provider_policy_limit:${string}` | `model_capability_limit:${string}`
>;

export const constrainEffortForAgent = (
  agent: ActiveAgentId,
  requested: RequestedEffort,
): { effort: Effort; reason: EffortLimitReason | null } => {
  const profile = PROVIDER_EFFORT_PROFILES[agent];
  const requestedIndex = effortIndex(requested);
  const capabilityMaximum = profile.supportedEfforts.at(-1)!;
  const capabilityIndex = effortIndex(capabilityMaximum);
  const policyIndex = profile.policyMaximum === null
    ? REQUESTED_EFFORT_LADDER.length - 1
    : effortIndex(profile.policyMaximum);
  const effectiveIndex = Math.min(requestedIndex, capabilityIndex, policyIndex);
  const effort = REQUESTED_EFFORT_LADDER[effectiveIndex] as Effort;
  if (effectiveIndex === requestedIndex) return { effort, reason: null };
  if (policyIndex < requestedIndex && policyIndex <= capabilityIndex) {
    return {
      effort,
      reason: `provider_policy_limit:gpt-5.6-sol:${effort}`,
    };
  }
  return {
    effort,
    reason: `model_capability_limit:grok-4.6:${effort}`,
  };
};

export const preferredAgentForStage = (stage: Stage): ActiveAgentId =>
  STAGE_POLICY[stage].preferredAgent;

const READ_ONLY_STAGES: ReadonlySet<Stage> = new Set([
  "coordination", "plan_audit", "plan_critic", "prd_audit", "prd_critic", "architecture_audit", "architecture_critic",
  "test_audit", "test_critic", "code_audit", "code_critic", "code_review",
]);

export const stageRequiresReadOnly = (stage: Stage): boolean => READ_ONLY_STAGES.has(stage);

export const modelForAgent = (
  agent: ActiveAgentId,
): EffortDecision["model"] => (agent === "grok" ? "grok-4.6" : "gpt-5.6-sol");

export const providerSupportsApprovalScope = (
  agent: ActiveAgentId,
  scope: ApprovalScope,
): boolean => agent !== "grok" || scope !== "external";

export function selectStageAssignment(
  input: SelectStageAssignmentInput,
): EffortDecision {
  const policy = STAGE_POLICY[input.stage];
  const preferred = policy.preferredAgent;
  const alternate: ActiveAgentId = preferred === "grok" ? "codex" : "grok";
  const agent =
    input.health[preferred] === "healthy" &&
    providerSupportsApprovalScope(preferred, input.trustedInputs.approvalScope)
      ? preferred
      : input.health[alternate] === "healthy" &&
          providerSupportsApprovalScope(alternate, input.trustedInputs.approvalScope)
        ? alternate
        : null;

  if (agent === null) throw new Error("No healthy provider is available");

  const degraded = agent !== preferred;
  return selectFixedAgentEffort({
    stage: input.stage,
    agent,
    trustedInputs: input.trustedInputs,
    degraded,
  });
}

export function selectFixedAgentEffort(
  input: SelectFixedAgentEffortInput,
): EffortDecision {
  const baseline = STAGE_POLICY[input.stage].baselineEffort[input.agent];
  const reasons: EffortReason[] = [
    `stage_baseline:${input.stage}:${baseline}`,
  ];
  const modifiers: Array<readonly [boolean, EffortReason]> = [
    [input.degraded, "degraded_fallback"],
    [input.trustedInputs.attemptOrdinal >= 1, "retry"],
    [input.trustedInputs.approvalScope === "external", "external_scope"],
    [input.trustedInputs.artifactBytes >= 262_144, "large_artifact"],
    [input.trustedInputs.changedFiles >= 20, "broad_change_set"],
  ];
  let requested: RequestedEffort = baseline;

  for (const [applies, reason] of modifiers) {
    if (!applies) continue;
    reasons.push(reason);
    requested = increaseRequestedEffort(requested);
  }
  const constrained = constrainEffortForAgent(input.agent, requested);
  if (constrained.reason !== null) reasons.push(constrained.reason);

  return {
    agent: input.agent,
    model: modelForAgent(input.agent),
    effort: constrained.effort,
    policyVersion: ROUTING_POLICY_VERSION,
    reasons,
    degraded: input.degraded,
  };
}

export type StageRole = "stage-owner" | "coordinator";

export interface StageAuthority {
  readonly role: StageRole;
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly approvalScope: ApprovalScope;
  readonly idempotencyKey: string;
}

export interface RouteStageInput extends StageAuthority, SelectStageAssignmentInput {}

export interface RouteStageResult extends StageAuthority {
  readonly assignedAgent: ActiveAgentId;
  readonly model: EffortDecision["model"];
  readonly effort: Effort;
  readonly policyVersion: typeof ROUTING_POLICY_VERSION;
  readonly reasons: readonly EffortReason[];
  readonly degraded: boolean;
}

export function routeStage(input: RouteStageInput): RouteStageResult {
  const decision = selectStageAssignment(input);

  return {
    assignedAgent: decision.agent,
    model: decision.model,
    effort: decision.effort,
    policyVersion: decision.policyVersion,
    reasons: decision.reasons,
    degraded: decision.degraded,
    role: input.role,
    artifactRef: input.artifactRef,
    artifactHash: input.artifactHash,
    approvalScope: input.approvalScope,
    idempotencyKey: input.idempotencyKey,
  };
}
