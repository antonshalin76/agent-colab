import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReviewLanes, createReviewPlan } from "../src/domain/review.js";

describe("BDD-C1 six-lane review policy", () => {
  const artifact = Buffer.from("immutable artifact packet", "utf8");
  const artifactHash = createHash("sha256").update(artifact).digest("hex");
  const common = {
    stageId: "review-42",
    artifact,
    approvalScope: "workspace-read" as const,
    idempotencyKey: "review-42:artifact-v2",
    sourceFingerprint: "f".repeat(64),
    prompts: {
      auditor: "AUDITOR: inspect only the supplied immutable packet",
      critic: "CRITIC: challenge only the supplied immutable packet",
    },
  };

  it("creates exactly six isolated provider/role lanes bound to one immutable packet", () => {
    const lanes = createReviewLanes({
      ...common,
      health: { grok: "healthy", claude: "healthy", codex: "healthy" },
    });

    expect(lanes.map(({ agent, role }) => `${agent}:${role}`)).toEqual([
      "grok:auditor",
      "grok:critic",
      "claude:auditor",
      "claude:critic",
      "codex:auditor",
      "codex:critic",
    ]);
    expect(new Set(lanes.map((lane) => lane.sessionId)).size).toBe(6);
    expect(new Set(lanes.map((lane) => lane.idempotencyKey)).size).toBe(6);
    for (const lane of lanes) {
      const effort = lane.role === "auditor" ? "high" : "xhigh";
      const stage = lane.role === "auditor" ? "code_audit" : "code_critic";
      expect(lane.decision).toEqual({
        agent: lane.agent,
        model: lane.agent === "grok"
          ? "grok-4.6"
          : lane.agent === "claude"
            ? "glm-5.3"
            : "gpt-5.6-sol",
        effort,
        policyVersion: "routing-v5",
        reasons: [`stage_baseline:${stage}:${effort}`],
        degraded: false,
      });
      expect(lane.model).toBe(lane.decision.model);
      expect(lane.effort).toBe(lane.decision.effort);
      expect(lane.policyVersion).toBe(lane.decision.policyVersion);
      expect(lane.reasons).toBe(lane.decision.reasons);
      expect(lane.isolated).toBe(true);
      expect(lane.approvalScope).toBe("workspace-read");
      expect(lane.stageId).toBe(common.stageId);
      expect(lane.sourceFingerprint).toBe(common.sourceFingerprint);
      expect(lane.prompt).toBe(common.prompts[lane.role]);
      expect(lane.artifactHash).toBe(artifactHash);
      expect(lane.recomputedHash).toBe(artifactHash);
      expect(lane.idempotencyKey).toContain(`:${lane.agent}:${lane.role}`);
    }

    const second = createReviewLanes({
      ...common,
      health: { grok: "healthy", claude: "healthy", codex: "healthy" },
    });
    const firstSessions = new Set(lanes.map((lane) => lane.sessionId));
    expect(second.every((lane) => !firstSessions.has(lane.sessionId))).toBe(true);
  });

  it("copies packet bytes per lane and never exposes mutable shared storage", () => {
    const source = Buffer.from(artifact);
    const lanes = createReviewLanes({
      ...common,
      artifact: source,
      health: { grok: "healthy", claude: "healthy", codex: "healthy" },
    });
    const exposed = lanes.map((lane) => lane.artifact);

    source.fill(0);
    exposed[0]!.fill(1);
    expect(new Set(exposed).size).toBe(6);
    for (const lane of lanes) {
      expect(lane.artifact).toEqual(artifact);
      expect(lane.artifactHash).toBe(artifactHash);
    }
  });

  it.each([
    [{ grok: "unavailable", claude: "healthy", codex: "healthy" }, ["claude", "codex"], "grok"],
    [{ grok: "healthy", claude: "unavailable", codex: "healthy" }, ["grok", "codex"], "claude"],
  ] as const)("keeps four healthy lanes active and durably defers the unavailable provider", (
    health,
    activeAgents,
    deferredAgent,
  ) => {
    const plan = createReviewPlan({ ...common, health });

    expect(plan.runState).toBe("DEGRADED_REVIEW_SET");
    expect(plan.activeLanes.map((lane) => `${lane.agent}:${lane.role}`)).toEqual([
      `${activeAgents[0]}:auditor`,
      `${activeAgents[0]}:critic`,
      `${activeAgents[1]}:auditor`,
      `${activeAgents[1]}:critic`,
    ]);
    expect(plan.deferredLanes.map((lane) => `${lane.agent}:${lane.role}`)).toEqual([
      `${deferredAgent}:auditor`,
      `${deferredAgent}:critic`,
    ]);
    for (const lane of [...plan.activeLanes, ...plan.deferredLanes]) {
      expect(lane.degraded).toBe(true);
      expect(lane.effort).toBe(lane.role === "auditor" ? "high" : "xhigh");
      expect(lane.artifactHash).toBe(artifactHash);
    }
  });

  it("durably defers mandatory Codex while capability verification is pending", () => {
    const plan = createReviewPlan({
      ...common,
      health: { grok: "unavailable", claude: "disabled", codex: "probing" },
    });
    expect(plan.runState).toBe("DEGRADED_REVIEW_SET");
    expect(plan.activeLanes).toEqual([]);
    expect(plan.deferredLanes.map(({ agent, role }) => `${agent}:${role}`)).toEqual([
      "grok:auditor",
      "grok:critic",
      "claude:auditor",
      "claude:critic",
      "codex:auditor",
      "codex:critic",
    ]);
  });

  it("rejects a disabled mandatory Codex before creating review demand", () => {
    expect(() => createReviewPlan({
      ...common,
      health: { grok: "healthy", claude: "healthy", codex: "disabled" },
    })).toThrow(/mandatory Codex auditor\/critic pair is disabled/i);
  });

  it("rejects review creation when every provider is disabled", () => {
    expect(() => createReviewPlan({
      ...common,
      health: { grok: "disabled", claude: "disabled", codex: "disabled" },
    })).toThrow(/no enabled provider/i);
  });
});
