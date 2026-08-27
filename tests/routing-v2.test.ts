import { describe, expect, it } from "vitest";
import {
  ROUTING_POLICY_VERSION,
  STAGES,
  STAGE_POLICY,
  constrainEffortForAgent,
  increaseRequestedEffort,
  providerSupportsApprovalScope,
  routeStage,
  selectFixedAgentEffort,
  selectStageAssignment,
  stageRequiresReadOnly,
  type ActiveAgentId,
  type ApprovalScope,
  type ProviderHealthSnapshot,
  type Stage,
  type TrustedEffortInputs,
} from "../src/domain/routing.js";
import {
  FAILOVER_OUTCOMES,
  TERMINAL_OUTCOMES,
  classifyOutcome,
} from "../src/domain/outcomes.js";

const BASE_INPUTS = {
  artifactBytes: 1_024,
  changedFiles: 2,
  attemptOrdinal: 0,
  approvalScope: "workspace-read",
} as const satisfies TrustedEffortInputs;

const assignment = (
  stage: Stage,
  origin: ActiveAgentId,
  health: ProviderHealthSnapshot = { grok: "healthy", codex: "healthy" },
  trustedInputs: TrustedEffortInputs = BASE_INPUTS,
) => selectStageAssignment({ stage, origin, health, trustedInputs });

describe("routing-v5 canonical policy", () => {
  it("pins the complete policy to routing-v5 with Codex as every stage owner", () => {
    expect(ROUTING_POLICY_VERSION).toBe("routing-v5");
    expect(Object.keys(STAGE_POLICY)).toEqual([...STAGES]);
    expect(STAGES).toHaveLength(21);
    expect(STAGES.every((stage) => STAGE_POLICY[stage].preferredAgent === "codex")).toBe(true);
  });

  it.each(STAGES)("routes %s to Codex for either request origin", (stage) => {
    for (const origin of ["grok", "codex"] as const) {
      const result = assignment(stage, origin);
      expect(result).toEqual({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: STAGE_POLICY[stage].baselineEffort.codex,
        policyVersion: "routing-v5",
        reasons: [`stage_baseline:${stage}:${STAGE_POLICY[stage].baselineEffort.codex}`],
        degraded: false,
      });
    }
  });

  it.each(STAGES)("blocks %s when Codex is unavailable even if Grok is healthy", (stage) => {
    expect(() => assignment(stage, "grok", { grok: "healthy", codex: "unavailable" }))
      .toThrow("No healthy provider is available");
  });

  it.each(["workspace-read", "workspace-write", "external"] as const)(
    "allows only Codex to own %s workflow authority",
    (scope) => {
      expect(providerSupportsApprovalScope("codex", scope)).toBe(true);
      expect(providerSupportsApprovalScope("grok", scope)).toBe(false);
    },
  );

  it("fails closed when neither harness is healthy", () => {
    expect(() => assignment("planning", "codex", { grok: "unavailable", codex: "unavailable" }))
      .toThrow("No healthy provider is available");
  });

  it("preserves authority bytes while routing external work to Codex", () => {
    const result = routeStage({
      stage: "planning",
      origin: "grok",
      health: { grok: "healthy", codex: "healthy" },
      role: "stage-owner",
      artifactRef: "artifact:plan",
      artifactHash: "a".repeat(64),
      approvalScope: "external",
      idempotencyKey: "plan:external",
      trustedInputs: { ...BASE_INPUTS, approvalScope: "external" },
    });
    expect(result).toEqual({
      assignedAgent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:planning:medium", "external_scope"],
      degraded: false,
      role: "stage-owner",
      artifactRef: "artifact:plan",
      artifactHash: "a".repeat(64),
      approvalScope: "external",
      idempotencyKey: "plan:external",
    });
  });

  it.each([
    "coordination",
    "plan_audit",
    "plan_critic",
    "prd_audit",
    "prd_critic",
    "architecture_audit",
    "architecture_critic",
    "test_audit",
    "test_critic",
    "code_audit",
    "code_critic",
    "code_review",
  ] as const)("marks %s as read-only", (stage) => {
    expect(stageRequiresReadOnly(stage)).toBe(true);
  });

  it.each([
    "planning",
    "prd",
    "architecture",
    "ui_ux",
    "bdd",
    "tdd_coding",
    "unit_testing",
    "e2e_infrastructure",
    "e2e_testing",
  ] as const)("does not misclassify delivery stage %s as read-only", (stage) => {
    expect(stageRequiresReadOnly(stage)).toBe(false);
  });
});

describe("routing-v5 adaptive effort", () => {
  it("keeps modifier order deterministic and caps Codex at xhigh", () => {
    const decision = selectFixedAgentEffort({
      stage: "planning",
      agent: "codex",
      degraded: false,
      trustedInputs: {
        artifactBytes: 262_144,
        changedFiles: 20,
        attemptOrdinal: 1,
        approvalScope: "external",
      },
    });
    expect(decision).toEqual({
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      policyVersion: "routing-v5",
      reasons: [
        "stage_baseline:planning:medium",
        "retry",
        "external_scope",
        "large_artifact",
        "broad_change_set",
        "provider_policy_limit:gpt-5.6-sol:xhigh",
      ],
      degraded: false,
    });
  });

  it("keeps Grok effort selection available only for explicit review-lane decisions", () => {
    expect(selectFixedAgentEffort({
      stage: "code_critic",
      agent: "grok",
      degraded: false,
      trustedInputs: BASE_INPUTS,
    })).toEqual({
      agent: "grok",
      model: "grok-4.6",
      effort: "xhigh",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_critic:xhigh"],
      degraded: false,
    });
  });

  it("changes only at exact trusted thresholds", () => {
    expect(assignment("planning", "codex", undefined, { ...BASE_INPUTS, artifactBytes: 262_143 }).reasons)
      .not.toContain("large_artifact");
    expect(assignment("planning", "codex", undefined, { ...BASE_INPUTS, artifactBytes: 262_144 }).reasons)
      .toContain("large_artifact");
    expect(assignment("planning", "codex", undefined, { ...BASE_INPUTS, changedFiles: 19 }).reasons)
      .not.toContain("broad_change_set");
    expect(assignment("planning", "codex", undefined, { ...BASE_INPUTS, changedFiles: 20 }).reasons)
      .toContain("broad_change_set");
  });

  it("uses a stable requested-effort ladder and provider-specific caps", () => {
    expect(increaseRequestedEffort("medium", 3)).toBe("max");
    expect(increaseRequestedEffort("xhigh", 2)).toBe("ultra");
    expect(constrainEffortForAgent("codex", "ultra")).toEqual({
      effort: "xhigh",
      reason: "provider_policy_limit:gpt-5.6-sol:xhigh",
    });
    expect(constrainEffortForAgent("grok", "ultra")).toEqual({
      effort: "xhigh",
      reason: "model_capability_limit:grok-4.6:xhigh",
    });
  });

  it.each(["workspace-read", "workspace-write", "external"] as const)(
    "keeps scope %s in trusted effort inputs",
    (scope: ApprovalScope) => {
      const result = assignment("architecture", "codex", undefined, { ...BASE_INPUTS, approvalScope: scope });
      expect(result.agent).toBe("codex");
      expect(result.reasons.includes("external_scope")).toBe(scope === "external");
    },
  );
});

describe("routing-v5 provider outcome classification", () => {
  it.each(FAILOVER_OUTCOMES)("classifies %s as retryable but not transferable", (kind) => {
    expect(classifyOutcome({ kind })).toEqual({
      failoverEligible: true,
      countsAgainstProvider: true,
    });
  });

  it.each(TERMINAL_OUTCOMES)("classifies %s as terminal", (kind) => {
    expect(classifyOutcome({ kind })).toEqual({
      failoverEligible: false,
      countsAgainstProvider: false,
    });
  });

  it("rejects unknown outcomes instead of widening retry authority", () => {
    expect(() => classifyOutcome({ kind: "unknown" } as never)).toThrow("Unknown outcome: unknown");
  });
});
