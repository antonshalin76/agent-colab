import { describe, expect, it } from "vitest";

import { createReviewPlan } from "../src/domain/review.js";
import {
  ROUTING_POLICY_VERSION,
  STAGES,
  STAGE_POLICY,
  providerSupportsApprovalScope,
  selectStageAssignment,
} from "../src/domain/routing.js";

describe("routing-v5 pure policy contract", () => {
  it("pins every delivery stage to Codex and never promotes a helper to workflow owner", () => {
    expect(ROUTING_POLICY_VERSION).toBe("routing-v5");
    expect(STAGES.every((stage) => STAGE_POLICY[stage].preferredAgent === "codex")).toBe(true);
    expect(providerSupportsApprovalScope("grok", "workspace-read")).toBe(false);
    expect(providerSupportsApprovalScope("grok", "workspace-write")).toBe(false);
    expect(providerSupportsApprovalScope("grok", "external")).toBe(false);

    for (const stage of STAGES) {
      expect(selectStageAssignment({
        stage,
        origin: "grok",
        health: { grok: "healthy", codex: "healthy" },
        trustedInputs: {
          artifactBytes: 1_024,
          changedFiles: 2,
          attemptOrdinal: 0,
          approvalScope: "workspace-read",
        },
      })).toMatchObject({ agent: "codex", policyVersion: "routing-v5", degraded: false });
    }
  });

  it("keeps workflow routing fail-closed when Codex is unavailable", () => {
    for (const stage of STAGES) {
      expect(() => selectStageAssignment({
        stage,
        origin: "codex",
        health: { grok: "healthy", codex: "unavailable" },
        trustedInputs: {
          artifactBytes: 1_024,
          changedFiles: 2,
          attemptOrdinal: 0,
          approvalScope: "workspace-read",
        },
      })).toThrow(/no healthy provider/i);
    }
  });

  it("rejects mutation authority at the surviving review-domain boundary", () => {
    expect(() => createReviewPlan({
      stageId: "review",
      artifact: Buffer.from("frozen packet"),
      health: { grok: "healthy", claude: "healthy", codex: "healthy" },
      approvalScope: "workspace-write",
      idempotencyKey: "review:write",
      prompts: { auditor: "audit", critic: "critic" },
    })).toThrow(/review.*workspace-read|read-only/i);
  });
});
