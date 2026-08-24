import { describe, expect, it } from "vitest";
import {
  ROUTING_POLICY_VERSION,
  STAGES,
  STAGE_POLICY,
  selectStageAssignment,
  type ActiveAgentId,
  type ProviderHealthSnapshot,
  type Stage,
  type TrustedEffortInputs,
} from "../src/domain/routing.js";
import { classifyOutcome } from "../src/domain/outcomes.js";

const EXPECTED_STAGES = [
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

type ExpectedStage = (typeof EXPECTED_STAGES)[number];
type ExpectedEffort = "low" | "medium" | "high" | "xhigh";

const EXPECTED_POLICY_VERSION = "routing-v3";

const EXPECTED_CAPABILITIES = {
  grok: {
    model: "grok-4.6",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  codex: {
    model: "gpt-5.6-sol",
    efforts: ["low", "medium", "high", "xhigh"],
  },
} as const satisfies Record<
  ActiveAgentId,
  { model: string; efforts: readonly ExpectedEffort[] }
>;

const EXPECTED_STAGE_POLICY = {
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
} as const satisfies Record<
  ExpectedStage,
  {
    preferredAgent: ActiveAgentId;
    baselineEffort: Record<ActiveAgentId, ExpectedEffort>;
  }
>;

const ORIGINS = ["grok", "codex"] as const satisfies readonly ActiveAgentId[];
const AGENTS = ["grok", "codex"] as const satisfies readonly ActiveAgentId[];

const BASE_TRUSTED_INPUTS = {
  artifactBytes: 1_024,
  changedFiles: 2,
  attemptOrdinal: 0,
  approvalScope: "workspace-read",
} as const satisfies TrustedEffortInputs;

const HEALTHY = {
  grok: "healthy",
  codex: "healthy",
} as const satisfies ProviderHealthSnapshot;

const stageRows = ORIGINS.flatMap((origin) =>
  EXPECTED_STAGES.map((stage) => [origin, stage] as const),
);

const assignmentFor = (
  stage: ExpectedStage,
  origin: ActiveAgentId,
  health: ProviderHealthSnapshot,
  trustedInputs: TrustedEffortInputs = BASE_TRUSTED_INPUTS,
) =>
  selectStageAssignment({
    stage: stage as Stage,
    origin,
    health,
    trustedInputs,
  });

const bump = (agent: ActiveAgentId, effort: ExpectedEffort) => {
  const ladder = EXPECTED_CAPABILITIES.codex.efforts;
  const index = ladder.indexOf(effort);
  const bumped = ladder[Math.min(index + 1, ladder.length - 1)]!;
  return {
    effort: bumped,
    reason: effort === "xhigh"
      ? agent === "codex"
        ? "provider_policy_limit:gpt-5.6-sol:xhigh"
        : "model_capability_limit:grok-4.6:xhigh"
      : null,
  } as const;
};

describe("routing v2 canonical policy", () => {
  it("exports the test-owned literal complete stage policy as the only matrix", () => {
    expect(STAGES).toEqual(EXPECTED_STAGES);
    expect(STAGE_POLICY).toEqual(EXPECTED_STAGE_POLICY);
    expect(ROUTING_POLICY_VERSION).toBe(EXPECTED_POLICY_VERSION);
  });

  it.each(stageRows)(
    "routes %s-origin %s to the preferred provider and exact supported model",
    (origin, stage) => {
      const expected = EXPECTED_STAGE_POLICY[stage];
      const result = assignmentFor(stage, origin, HEALTHY);

      expect(result).toEqual({
        agent: expected.preferredAgent,
        model: EXPECTED_CAPABILITIES[expected.preferredAgent].model,
        effort: expected.baselineEffort[expected.preferredAgent],
        policyVersion: EXPECTED_POLICY_VERSION,
        reasons: [
          `stage_baseline:${stage}:${expected.baselineEffort[expected.preferredAgent]}`,
        ],
        degraded: false,
      });
      expect(EXPECTED_CAPABILITIES[result.agent].efforts).toContain(result.effort);
    },
  );

  it.each(stageRows)(
    "routes %s-origin %s to Codex when Grok is unavailable",
    (origin, stage) => {
      const policy = EXPECTED_STAGE_POLICY[stage];
      const degraded = policy.preferredAgent === "grok";
      const baseline = policy.baselineEffort.codex;
      const escalated = bump("codex", baseline);

      expect(
        assignmentFor(stage, origin, { grok: "unavailable", codex: "healthy" }),
      ).toEqual({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: degraded ? escalated.effort : baseline,
        policyVersion: EXPECTED_POLICY_VERSION,
        reasons: [
          `stage_baseline:${stage}:${baseline}`,
          ...(degraded ? (["degraded_fallback"] as const) : []),
          ...(degraded && escalated.reason ? ([escalated.reason] as const) : []),
        ],
        degraded,
      });
    },
  );

  it.each(stageRows)(
    "routes %s-origin %s to Grok when Codex is unavailable",
    (origin, stage) => {
      const policy = EXPECTED_STAGE_POLICY[stage];
      const degraded = policy.preferredAgent === "codex";
      const baseline = policy.baselineEffort.grok;
      const escalated = bump("grok", baseline);

      expect(
        assignmentFor(stage, origin, { grok: "healthy", codex: "unavailable" }),
      ).toEqual({
        agent: "grok",
        model: "grok-4.6",
        effort: degraded ? escalated.effort : baseline,
        policyVersion: EXPECTED_POLICY_VERSION,
        reasons: [
          `stage_baseline:${stage}:${baseline}`,
          ...(degraded ? (["degraded_fallback"] as const) : []),
          ...(degraded && escalated.reason ? ([escalated.reason] as const) : []),
        ],
        degraded,
      });
    },
  );

  it("fails closed when neither provider is healthy", () => {
    expect(() =>
      assignmentFor("planning", "grok", {
        grok: "probing",
        codex: "disabled",
      }),
    ).toThrow(/no healthy provider/i);
  });

  it("routes external Grok-preferred work to Codex with explicit fallback evidence", () => {
    expect(assignmentFor("planning", "grok", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      approvalScope: "external",
    })).toEqual({
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      policyVersion: EXPECTED_POLICY_VERSION,
      reasons: [
        "stage_baseline:planning:medium",
        "degraded_fallback",
        "external_scope",
      ],
      degraded: true,
    });
  });

  it("fails closed instead of routing external work to Grok", () => {
    expect(() => assignmentFor(
      "architecture",
      "codex",
      { grok: "healthy", codex: "unavailable" },
      { ...BASE_TRUSTED_INPUTS, approvalScope: "external" },
    )).toThrow(/no healthy provider/i);
  });
});

describe("routing v2 adaptive effort", () => {
  it.each(
    EXPECTED_STAGES.flatMap((stage) =>
      AGENTS.map((agent) => [stage, agent] as const),
    ),
  )("uses the literal %s baseline for %s and escalates only fallback", (stage, agent) => {
    const policy = EXPECTED_STAGE_POLICY[stage];
    const degraded = policy.preferredAgent !== agent;
    const baseline = policy.baselineEffort[agent];
    const health: ProviderHealthSnapshot = {
      grok: agent === "grok" ? "healthy" : "unavailable",
      codex: agent === "codex" ? "healthy" : "unavailable",
    };
    const escalated = bump(agent, baseline);

    expect(assignmentFor(stage, "codex", health)).toMatchObject({
      agent,
      model: EXPECTED_CAPABILITIES[agent].model,
      effort: degraded ? escalated.effort : baseline,
      reasons: [
        `stage_baseline:${stage}:${baseline}`,
        ...(degraded ? (["degraded_fallback"] as const) : []),
        ...(degraded && escalated.reason ? ([escalated.reason] as const) : []),
      ],
      degraded,
    });
  });

  it.each([
    ["attemptOrdinal", { attemptOrdinal: 1 }, "retry"],
    ["external approval", { approvalScope: "external" }, "external_scope"],
    ["artifactBytes", { artifactBytes: 262_144 }, "large_artifact"],
    ["changedFiles", { changedFiles: 20 }, "broad_change_set"],
  ] as const)("adds the %s modifier at its inclusive boundary", (_label, patch, reason) => {
    const decision = assignmentFor("coordination", "codex", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      ...patch,
    });

    expect(decision).toMatchObject({
      effort: "high",
      reasons: ["stage_baseline:coordination:medium", reason],
    });
  });

  it.each([
    ["attemptOrdinal", { attemptOrdinal: 0 }],
    ["workspace approval", { approvalScope: "workspace-write" }],
    ["artifactBytes", { artifactBytes: 262_143 }],
    ["changedFiles", { changedFiles: 19 }],
  ] as const)("does not add the %s modifier below its boundary", (_label, patch) => {
    const decision = assignmentFor("coordination", "codex", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      ...patch,
    });

    expect(decision).toMatchObject({
      effort: "medium",
      reasons: ["stage_baseline:coordination:medium"],
    });
  });

  it("keeps canonical reason order while effort caps at xhigh", () => {
    const decision = assignmentFor(
      "planning",
      "grok",
      HEALTHY,
      {
        artifactBytes: 262_144,
        changedFiles: 20,
        attemptOrdinal: 1,
        approvalScope: "external",
      },
    );

    expect(decision).toEqual({
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      policyVersion: EXPECTED_POLICY_VERSION,
      reasons: [
        "stage_baseline:planning:medium",
        "degraded_fallback",
        "retry",
        "external_scope",
        "large_artifact",
        "broad_change_set",
        "provider_policy_limit:gpt-5.6-sol:xhigh",
      ],
      degraded: true,
    });
    expect(new Set(decision.reasons).size).toBe(decision.reasons.length);
  });

  it("changes the decision for deliberately mutated threshold inputs", () => {
    const below = assignmentFor("coordination", "codex", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      artifactBytes: 262_143,
      changedFiles: 19,
    });
    const atThreshold = assignmentFor("coordination", "codex", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      artifactBytes: 262_144,
      changedFiles: 20,
    });

    expect(atThreshold).not.toEqual(below);
    expect(below.reasons).toEqual(["stage_baseline:coordination:medium"]);
    expect(atThreshold.reasons).toEqual([
      "stage_baseline:coordination:medium",
      "large_artifact",
      "broad_change_set",
    ]);
  });
});

describe("routing v2 per-attempt decisions", () => {
  it("creates a new decision per attempt while preserving the pinned version and prior evidence", () => {
    const initial = assignmentFor("planning", "grok", HEALTHY);
    const initialEvidence = structuredClone(initial);
    const retry = assignmentFor("planning", "grok", HEALTHY, {
      ...BASE_TRUSTED_INPUTS,
      attemptOrdinal: 1,
    });
    const failover = assignmentFor(
      "planning",
      "grok",
      { grok: "unavailable", codex: "healthy" },
      { ...BASE_TRUSTED_INPUTS, attemptOrdinal: 2 },
    );

    expect(retry).not.toBe(initial);
    expect(failover).not.toBe(retry);
    expect(initial).toEqual(initialEvidence);
    expect([initial.policyVersion, retry.policyVersion, failover.policyVersion]).toEqual([
      EXPECTED_POLICY_VERSION,
      EXPECTED_POLICY_VERSION,
      EXPECTED_POLICY_VERSION,
    ]);
    expect(initial.reasons).toEqual(["stage_baseline:planning:medium"]);
    expect(retry.reasons).toEqual(["stage_baseline:planning:medium", "retry"]);
    expect(failover).toMatchObject({
      agent: "codex",
      reasons: [
        "stage_baseline:planning:medium",
        "degraded_fallback",
        "retry",
      ],
    });
  });
});

describe("routing v2 failover outcome classification", () => {
  const EXPECTED_OUTCOMES = {
    auth: true,
    quota: true,
    rate_limit: true,
    network_timeout: true,
    overload: true,
    model_unavailable: true,
    cli_missing: true,
    invalid_request: false,
    task_failure: false,
    safety_denial: false,
    permission_denial: false,
    user_cancelled: false,
  } as const;

  it.each(Object.entries(EXPECTED_OUTCOMES))(
    "classifies %s failover eligibility as %s",
    (kind, failoverEligible) => {
      expect(classifyOutcome({ kind: kind as keyof typeof EXPECTED_OUTCOMES })).toEqual({
        failoverEligible,
        countsAgainstProvider: failoverEligible,
      });
    },
  );

  it("rejects an unknown outcome instead of widening failover", () => {
    expect(() => classifyOutcome({ kind: "unknown" as never })).toThrow(/unknown outcome/i);
  });
});
