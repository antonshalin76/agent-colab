import { describe, expect, it, vi } from "vitest";
import {
  ROUTING_POLICY_VERSION,
  selectFixedAgentEffort,
} from "../src/domain/routing.js";
import * as routing from "../src/domain/routing.js";
import { AgentRunner, type ProcessLauncher } from "../src/runners/agent-runner.js";
import { buildCodexCommand } from "../src/runners/codex.js";
import { buildGrokCommand } from "../src/runners/grok.js";
import {
  createMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../src/flow/map-admin.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";

const COMPLEX_INPUTS = {
  artifactBytes: 262_144,
  changedFiles: 20,
  attemptOrdinal: 1,
  approvalScope: "workspace-read",
} as const;

const codexStream = [
  JSON.stringify({ type: "session_meta", payload: { id: "session", model: "gpt-5.6-sol" } }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  }),
].join("\n") + "\n";

const runnerProject = process.cwd();
const codexLearning = createMapLearningLaunchBinding(runnerProject, "codex");
const learnedPrompt = (prompt: string): string =>
  `${formatMapLearningLaunchBindingContext(codexLearning)}\n\n${prompt}`;
const sourceFingerprint = captureWorkspaceFingerprint(runnerProject).fingerprint;

const runnerWith = (launch = vi.fn(() => ({
  pid: 1234,
  result: Promise.resolve({ exitCode: 0, stdout: codexStream, stderr: "" }),
  terminate: vi.fn(),
}))) => ({
  launch,
  runner: new AgentRunner({
    binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
    timeoutMs: 90_000,
    launcher: { launch } as ProcessLauncher,
  }),
});

describe("provider-specific effort limits", () => {
  it("pins the changed durable decision grammar to routing-v4", () => {
    expect(ROUTING_POLICY_VERSION).toBe("routing-v4");
  });

  it("caps Codex/Sol at xhigh while Grok has no policy maximum", () => {
    const profile = Reflect.get(routing, "PROVIDER_EFFORT_PROFILES") as
      | Record<string, unknown>
      | undefined;
    expect(profile).toEqual({
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
    });
  });

  it.each([
    ["codex", "low", "low", null],
    ["codex", "xhigh", "xhigh", null],
    ["codex", "max", "xhigh", "provider_policy_limit:gpt-5.6-sol:xhigh"],
    ["codex", "ultra", "xhigh", "provider_policy_limit:gpt-5.6-sol:xhigh"],
    ["grok", "low", "low", null],
    ["grok", "xhigh", "xhigh", null],
    ["grok", "max", "xhigh", "model_capability_limit:grok-4.6:xhigh"],
    ["grok", "ultra", "xhigh", "model_capability_limit:grok-4.6:xhigh"],
  ] as const)("constrains %s requested %s to %s with exact evidence", (agent, requested, effort, reason) => {
    const constrain = Reflect.get(routing, "constrainEffortForAgent") as
      | ((agent: string, requested: string) => unknown)
      | undefined;
    expect(typeof constrain).toBe("function");
    if (!constrain) return;
    expect(constrain(agent, requested)).toEqual({ effort, reason });
  });

  it("records the Codex policy cap only after adaptive escalation exceeds xhigh", () => {
    expect(selectFixedAgentEffort({
      stage: "code_critic",
      agent: "codex",
      trustedInputs: COMPLEX_INPUTS,
      degraded: true,
    })).toMatchObject({
      effort: "xhigh",
      reasons: [
        "stage_baseline:code_critic:xhigh",
        "degraded_fallback",
        "retry",
        "large_artifact",
        "broad_change_set",
        "provider_policy_limit:gpt-5.6-sol:xhigh",
      ],
    });
  });

  it("records only the model capability limit for Grok", () => {
    const decision = selectFixedAgentEffort({
      stage: "code_critic",
      agent: "grok",
      trustedInputs: COMPLEX_INPUTS,
      degraded: false,
    });
    expect(decision).toMatchObject({
      effort: "xhigh",
      reasons: [
        "stage_baseline:code_critic:xhigh",
        "retry",
        "large_artifact",
        "broad_change_set",
        "model_capability_limit:grok-4.6:xhigh",
      ],
    });
    expect(decision.reasons.some((reason) => reason.startsWith("provider_policy_limit:"))).toBe(false);
  });

  it.each([
    ["codex", "max"],
    ["codex", "ultra"],
    ["grok", "max"],
    ["grok", "ultra"],
  ] as const)("rejects non-executable %s %s at the command boundary", (agent, effort) => {
    const codex = buildCodexCommand as unknown as (input: Record<string, unknown>) => unknown;
    const grok = buildGrokCommand as unknown as (input: Record<string, unknown>) => unknown;
    const common = {
      cwd: "/repo", prompt: "review", approvalScope: "workspace-read",
      effort, timeoutMs: 90_000,
    };
    expect(() => agent === "codex"
      ? codex({ ...common, binary: "/opt/codex" })
      : grok({ ...common, binary: "/home/anton/.local/bin/grok",
          sessionId: "123e4567-e89b-42d3-a456-426614174000" }))
      .toThrow(/effort|xhigh|capability/i);
  });

  it("accepts exact capped evidence bound to its immutable review dispatch identity", async () => {
    const valid = runnerWith();
    const identity = {
      agent: "codex", model: "gpt-5.6-sol", effort: "xhigh", policyVersion: "routing-v4",
      reasons: [
        "stage_baseline:code_critic:xhigh",
        "retry",
        "provider_policy_limit:gpt-5.6-sol:xhigh",
      ],
      degraded: false, attemptOrdinal: 1, attemptId: "stage:attempt:1:codex:routing-v4",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    };
    await expect(valid.runner.run({
      id: "valid-cap", stage: "review:critic", approvalScope: "workspace-read",
      idempotencyKey: "review:critic:0",
      payload: {
        project: runnerProject, prompt: learnedPrompt("review"), approvalScope: "workspace-read",
        requester: "codex", sourceFingerprint, mapLearning: codexLearning,
        decision: structuredClone(identity),
        reviewDispatchIdentity: structuredClone(identity),
        reviewDispatchId: "review:critic:0",
        reviewAttemptId: identity.attemptId,
        reviewAttemptOrdinal: identity.attemptOrdinal,
        sessionId: identity.sessionId,
      },
    })).resolves.toMatchObject({ kind: "success", effort: "xhigh" });
    expect(valid.launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["effort", { effort: "medium" }],
    ["cap evidence", { reasons: ["stage_baseline:code_critic:xhigh", "retry"] }],
  ] as const)("rejects decision %s drift from immutable workflow identity", async (_label, patch) => {
    const identity = {
      agent: "codex", model: "gpt-5.6-sol", effort: "xhigh", policyVersion: "routing-v4",
      reasons: ["stage_baseline:code_critic:xhigh", "retry",
        "provider_policy_limit:gpt-5.6-sol:xhigh"],
      degraded: false, attemptOrdinal: 1, attemptId: "stage:attempt:1:codex:routing-v4",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const forged = runnerWith();
    await expect(forged.runner.run({
      id: "forged-identity", stage: "code_critic", approvalScope: "workspace-read",
      idempotencyKey: "workflow:dispatch:0",
      payload: {
        project: runnerProject, prompt: learnedPrompt("review"), approvalScope: "workspace-read",
        requester: "codex", workflowId: "workflow", workflowStageId: "code_critic",
        workflowDispatchId: "workflow:dispatch:0", sourceFingerprint, mapLearning: codexLearning,
        decision: { ...structuredClone(identity), ...patch },
        workflowDispatchIdentity: structuredClone(identity),
      },
    })).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/decision|identity|effort|reason/i),
    });
    expect(forged.launch).not.toHaveBeenCalled();
  });

  it("requires immutable workflow identity for a canonical stage", async () => {
    const missing = runnerWith();
    await expect(missing.runner.run({
      id: "missing-identity", stage: "coordination", approvalScope: "workspace-read",
      idempotencyKey: "workflow:dispatch:0",
      payload: {
        project: runnerProject, prompt: learnedPrompt("coordinate"), approvalScope: "workspace-read",
        requester: "codex", workflowId: "workflow", workflowStageId: "coordination",
        workflowDispatchId: "workflow:dispatch:0", sourceFingerprint, mapLearning: codexLearning,
        decision: {
          agent: "codex", model: "gpt-5.6-sol", effort: "medium", policyVersion: "routing-v4",
          reasons: ["stage_baseline:coordination:medium"],
        },
      },
    })).resolves.toMatchObject({ kind: "invalid_request", error: expect.stringMatching(/identity/i) });
    expect(missing.launch).not.toHaveBeenCalled();
  });

  it("rejects workflow session drift from immutable identity", async () => {
    const identity = {
      agent: "codex", model: "gpt-5.6-sol", effort: "medium", policyVersion: "routing-v4",
      reasons: ["stage_baseline:planning:medium"], degraded: false,
      attemptOrdinal: 0, attemptId: "stage:attempt:0:codex:routing-v4",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const drift = runnerWith();
    await expect(drift.runner.run({
      id: "session-drift", stage: "planning", approvalScope: "workspace-read",
      idempotencyKey: "workflow:dispatch:0",
      payload: {
        project: runnerProject, prompt: learnedPrompt("plan"), approvalScope: "workspace-read",
        requester: "codex", workflowId: "workflow", workflowStageId: "planning",
        workflowDispatchId: "workflow:dispatch:0", sourceFingerprint, mapLearning: codexLearning,
        decision: structuredClone(identity), workflowDispatchIdentity: structuredClone(identity),
        sessionId: "123e4567-e89b-42d3-a456-426614174999",
      },
    })).resolves.toMatchObject({ kind: "invalid_request", error: expect.stringMatching(/session|identity/i) });
    expect(drift.launch).not.toHaveBeenCalled();
  });

  it.each([
    ["grok", "grok-4.6", "provider_policy_limit:gpt-5.6-sol:xhigh"],
    ["codex", "gpt-5.6-sol", "model_capability_limit:grok-4.6:xhigh"],
  ] as const)("rejects forged %s cap evidence before launch", async (agent, model, capReason) => {
    const forged = runnerWith();
    await expect(forged.runner.run({
      id: `forged-${agent}`, stage: "code_critic", approvalScope: "workspace-read",
      payload: {
        project: "/repo", prompt: "review", approvalScope: "workspace-read",
        decision: {
          agent, model, effort: "xhigh", policyVersion: "routing-v4",
          reasons: ["stage_baseline:code_critic:xhigh", "retry", capReason],
        },
      },
    })).resolves.toMatchObject({ kind: "invalid_request", error: expect.stringMatching(/limit|reason/i) });
    expect(forged.launch).not.toHaveBeenCalled();
  });
});
