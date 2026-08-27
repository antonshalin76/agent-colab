import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReviewLanes, createReviewPlan } from "../src/domain/review.js";

describe("BDD-5/6 four-lane review policy", () => {
  const artifact = Buffer.from("immutable artifact packet", "utf8");
  const artifactHash = createHash("sha256").update(artifact).digest("hex");
  const common = {
    stageId: "review-42",
    artifact,
    approvalScope: "workspace-read" as const,
    idempotencyKey: "review-42:artifact-v2",
    prompts: {
      auditor: "AUDITOR: inspect only the supplied immutable packet",
      critic: "CRITIC: challenge only the supplied immutable packet",
    },
  };

  it("creates exactly four isolated Grok/Codex lanes with one persisted decision contract", () => {
    const lanes = createReviewLanes({
      ...common,
      health: { grok: "healthy", codex: "healthy" },
    });

    expect(lanes.map(({ agent, role }) => `${agent}:${role}`)).toEqual([
      "grok:auditor",
      "grok:critic",
      "codex:auditor",
      "codex:critic",
    ]);
    expect(new Set(lanes.map((lane) => lane.sessionId)).size).toBe(4);
    for (const lane of lanes) {
      const effort = lane.role === "auditor" ? "high" : "xhigh";
      const stage = lane.role === "auditor" ? "code_audit" : "code_critic";
      expect(lane.decision).toEqual({
        agent: lane.agent,
        model: lane.agent === "grok" ? "grok-4.6" : "gpt-5.6-sol",
        effort,
        policyVersion: "routing-v4",
        reasons: [`stage_baseline:${stage}:${effort}`],
        degraded: false,
      });
      expect(lane.model).toBe(lane.decision.model);
      expect(lane.effort).toBe(lane.decision.effort);
      expect(lane.policyVersion).toBe(lane.decision.policyVersion);
      expect(lane.reasons).toBe(lane.decision.reasons);
      expect(lane.isolated).toBe(true);
      expect(lane.approvalScope).toBe("workspace-read");
      expect(lane.prompt).toBe(common.prompts[lane.role]);
      expect(lane.artifactHash).toBe(artifactHash);
      expect(lane.recomputedHash).toBe(artifactHash);
    }

    const second = createReviewLanes({
      ...common,
      health: { grok: "healthy", codex: "healthy" },
    });
    const firstSessions = new Set(lanes.map((lane) => lane.sessionId));
    expect(second.every((lane) => !firstSessions.has(lane.sessionId))).toBe(true);
  });

  it("copies packet bytes per lane and never exposes mutable shared storage", () => {
    const source = Buffer.from(artifact);
    const lanes = createReviewLanes({
      ...common,
      artifact: source,
      health: { grok: "healthy", codex: "healthy" },
    });
    const exposed = lanes.map((lane) => lane.artifact);

    source.fill(0);
    exposed[0]!.fill(1);
    expect(new Set(exposed).size).toBe(4);
    for (const lane of lanes) {
      expect(lane.artifact).toEqual(artifact);
      expect(lane.artifactHash).toBe(artifactHash);
    }
  });

  it.each([
    [{ grok: "unavailable", codex: "healthy" }, "codex", "grok"],
    [{ grok: "healthy", codex: "unavailable" }, "grok", "codex"],
  ] as const)("keeps two healthy lanes active and durably defers the unavailable provider", (
    health,
    activeAgent,
    deferredAgent,
  ) => {
    const plan = createReviewPlan({ ...common, health });

    expect(plan.runState).toBe("DEGRADED_SINGLE_PROVIDER");
    expect(plan.activeLanes.map((lane) => `${lane.agent}:${lane.role}`)).toEqual([
      `${activeAgent}:auditor`,
      `${activeAgent}:critic`,
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

  it("rejects review creation when neither provider is healthy", () => {
    expect(() => createReviewPlan({
      ...common,
      health: { grok: "unavailable", codex: "probing" },
    })).toThrow(/no healthy provider/i);
  });
});
