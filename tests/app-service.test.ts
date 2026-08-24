import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { grokWorkspaceMemoryDirectory, LocalCollabService, projectMemorySection } from "../src/app/service.js";
import type { AttemptAssignment } from "../src/workflow/workflow.js";

const delegatedArtifact = (artifactContent: string) => ({
  artifactContent,
  artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
});

const markCapabilityReady = (service: LocalCollabService): void => {
  service.providers.recordSuccess("grok", 1);
  service.providers.recordSuccess("codex", 1);
};
const serviceOptions = (root: string) => ({ allowedRoots: [root], agentSkillRoots: {
  grok: join(homedir(), ".agents", "skills"), codex: join(homedir(), ".agents", "skills"),
} });

describe("local collaboration service wiring", () => {
  it("persists native memory-source availability in service status", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-memory-health-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    try {
      const indexed = await service.indexNow({ project });
      expect(indexed.memorySources.grok).toBe("unavailable");
      expect((await service.status()).memorySources).toEqual([
        expect.objectContaining({ project, namespace: "codex_native", status: indexed.memorySources.codex }),
        expect.objectContaining({ project, namespace: "grok_native", status: "unavailable", sourcePath: null }),
      ]);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("selects only the exact canonical project section from native memory", () => {
    const content = [
      "## General",
      "global secret must not be projected",
      "### /home/anton/Source/other",
      "other project fact",
      "### /home/anton/Source/target",
      "target fact",
      "#### Detail",
      "target detail",
      "### /home/anton/Source/next",
      "next fact",
    ].join("\n");
    expect(projectMemorySection(content, "/home/anton/Source/target"))
      .toEqual({ startLine: 6, endLine: 8 });
    expect(projectMemorySection(content, "/home/anton/Source/missing")).toBeNull();
  });

  it("derives Grok's workspace memory directory from the normalized repository identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-grok-memory-root-"));
    const project = join(root, "checkout"); (await import("node:fs")).mkdirSync(project);
    try {
      execFileSync("git", ["init", project]);
      execFileSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:anton/example.git"]);
      const hash = createHash("sha256").update("anton/example").digest("hex").slice(0, 8);
      expect(grokWorkspaceMemoryDirectory(project, root))
        .toBe(join(root, ".grok", "memory", `example-${hash}`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("derives large-artifact effort only from exact immutable delegated bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-service-artifact-bytes-"));
    const project = join(root, "project");
    (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      await expect(service.delegate({
        requester: "grok", stage: "planning", project, prompt: "plan",
        artifactContent: "exact bytes", artifactHash: "0".repeat(64),
        approvalScope: "workspace-read", idempotencyKey: "mismatch",
      } as never)).rejects.toThrow(/artifact hash mismatch/i);

      const artifactContent = "a".repeat(262_144);
      const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const delegated = await service.delegate({
        requester: "grok", stage: "planning", project, prompt: "plan",
        artifactContent, artifactHash, approvalScope: "workspace-read",
        idempotencyKey: "large-artifact",
      } as never);
      expect(service.runtime.workflows.get(delegated.runId)?.activeStage?.assignment).toMatchObject({
        agent: "codex",
        effort: "high",
        reasons: ["stage_baseline:coordination:medium", "large_artifact"],
      });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("persists one idempotent delegated stage with fallback authority unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-service-"));
    const project = join(root, "project");
    (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const input = {
        requester: "grok" as const,
        stage: "coordination" as const,
        preferredAgent: "codex" as const,
        project,
        prompt: "coordinate",
        ...delegatedArtifact("coordination artifact"),
        approvalScope: "workspace-read" as const,
        idempotencyKey: "task:coordination",
      };
      const first = await service.delegate(input);
      const second = await service.delegate(input);
      expect(second.runId).toBe(first.runId);
      expect(service.runs.list()).toEqual([
        expect.objectContaining({
          approvalScope: "workspace-read",
          payload: expect.objectContaining({ preferredAgent: "codex", allowFallback: true }),
        }),
      ]);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a public idempotency replay that changes the canonical workflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-service-immutable-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const first = { requester: "codex" as const, taskId: "task-a", stage: "planning" as const,
        project, prompt: "first plan", ...delegatedArtifact("planning artifact"), approvalScope: "workspace-read" as const,
        idempotencyKey: "shared-key" };
      await service.delegate(first);
      await expect(service.delegate({ ...first, requester: "grok", taskId: "task-b", prompt: "different plan" }))
        .rejects.toThrow("workflow id conflicts with immutable collaboration input");
      expect(service.runtime.workflows.get((await service.delegate(first)).runId)?.origin).toBe("codex");
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("persists exactly four isolated review lanes with distinct provider-role keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-service-"));
    const project = join(root, "project");
    (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "immutable artifact";
      const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const result = await service.requestReview({
        requester: "codex",
        project,
        artifactHash,
        artifactContent,
        prompt: "review immutable artifact",
        approvalScope: "workspace-read",
        idempotencyKey: "task:review",
      });
      expect(result.laneCount).toBe(4);
      expect(result.activeLaneCount).toBe(4);
      expect(result.runState).toBe("FULL_CROSS_PROVIDER");
      expect(new Set(result.runIds).size).toBe(4);
      expect(service.runs.list().map((run) => [
        run.payload?.preferredAgent,
        run.payload?.reviewRole,
        run.idempotencyKey.split(":").slice(-2).join(":"),
      ]).sort((left, right) => String(left[2]).localeCompare(String(right[2])))).toEqual([
        ["grok", "auditor", "grok:auditor"],
        ["grok", "critic", "grok:critic"],
        ["codex", "auditor", "codex:auditor"],
        ["codex", "critic", "codex:critic"],
      ].sort((left, right) => String(left[2]).localeCompare(String(right[2]))));
      for (const run of service.runs.list()) {
        expect(run.payload?.reviewDispatchIdentity).toEqual({
          ...(run.payload?.decision as Record<string, unknown>),
          sessionId: run.payload?.sessionId,
          attemptId: run.payload?.reviewAttemptId,
          attemptOrdinal: run.payload?.reviewAttemptOrdinal,
          degraded: false,
        });
      }
      expect(service.reviews.get(result.reviewId)).toMatchObject({
        artifactHash,
        artifact: Buffer.from(artifactContent),
        lanes: expect.arrayContaining([
          expect.objectContaining({ agent: "grok", role: "auditor" }),
          expect.objectContaining({ agent: "grok", role: "critic" }),
          expect.objectContaining({ agent: "codex", role: "auditor" }),
          expect.objectContaining({ agent: "codex", role: "critic" }),
        ]),
      });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects credential-bearing review bytes instead of breaking the declared artifact hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-secret-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "review me sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE";
      await expect(service.requestReview({ requester: "codex", project, artifactContent,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"), prompt: "review",
        approvalScope: "workspace-read", idempotencyKey: "secret-review" }))
        .rejects.toThrow("cannot preserve its exact hash safely");
      expect(service.runs.list()).toHaveLength(0);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("redacts review prompt credentials before barrier or queue persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-prompt-secret-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const database = join(root, "state.db");
    const service = new LocalCollabService(database, serviceOptions(root));
    markCapabilityReady(service);
    const secret = "sk-ant-FAKE_REVIEW_PROMPT_SECRET_123456";
    try {
      const artifactContent = "safe immutable review artifact";
      const result = await service.requestReview({ requester: "codex", project, artifactContent,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"), prompt: `review with ${secret}`,
        approvalScope: "workspace-read", idempotencyKey: "prompt-secret-review" });
      const serialized = JSON.stringify({ review: service.reviews.get(result.reviewId), runs: service.runs.list() });
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain(secret);
      const sqliteBytes = [database, `${database}-wal`, `${database}-shm`]
        .filter(existsSync).map((path) => readFileSync(path).toString("latin1")).join("");
      expect(sqliteBytes).not.toContain(secret);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("scopes review idempotency and all four lane keys to the canonical project", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-project-scope-"));
    const a = join(root, "a"); const b = join(root, "b");
    (await import("node:fs")).mkdirSync(a); (await import("node:fs")).mkdirSync(b);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "same review"; const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const common = { requester: "codex" as const, artifactHash, artifactContent, prompt: "review",
        approvalScope: "workspace-read" as const, idempotencyKey: "same-review" };
      const first = await service.requestReview({ ...common, project: a });
      const second = await service.requestReview({ ...common, project: b });
      expect(first.reviewId).not.toBe(second.reviewId);
      expect(service.runs.list()).toHaveLength(8);
      expect(new Set(service.runs.list().map((run) => run.idempotencyKey)).size).toBe(8);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("enforces policy routing and a durable Codex coordination dependency for Grok-origin work", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-routing-service-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      await expect(service.delegate({
        requester: "grok", taskId: "task-42", stage: "planning", preferredAgent: "codex",
        project, prompt: "plan", ...delegatedArtifact("routing artifact"), approvalScope: "workspace-read",
        idempotencyKey: "task-42:planning",
      })).rejects.toThrow(/routing policy requires grok/i);
      const delegated = await service.delegate({
        requester: "grok", taskId: "task-42", stage: "planning", preferredAgent: "grok",
        project, prompt: "plan", ...delegatedArtifact("routing artifact"), approvalScope: "workspace-read",
        idempotencyKey: "task-42:planning",
      });
      let runs = service.runs.list();
      expect(runs).toHaveLength(1);
      const coordination = runs[0]!;
      expect(coordination.payload?.preferredAgent).toBe("codex");
      expect(coordination.stage).toBe("coordination");
      expect(coordination.approvalScope).toBe("workspace-read");
      expect(coordination.payload?.prompt).toContain("Immutable artifact");
      expect(coordination.payload?.prompt).toContain("routing artifact");
      expect(delegated.status).toBe("running");
      const state = service.runtime.completeStage(
        delegated.runId,
        String(coordination.payload?.workflowStageId),
        coordination.payload?.workflowDispatchIdentity as AttemptAssignment,
        { kind: "success" },
      );
      expect(state.completedStageIds).toContain(coordination.payload?.workflowStageId);
      expect(service.runtime.drainDispatchOutbox(service.runs)).toBe(1);
      runs = service.runs.list();
      const planning = runs.find((run) => run.stage === "planning")!;
      expect(planning.payload?.preferredAgent).toBe("grok");
      const claim = service.runs.claimNext({ workerId: "w", leaseMs: 100, now: Date.now() });
      expect(claim?.id).toBe(coordination.id);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("never widens audit or critic stages to mutation authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-readonly-review-stage-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      await expect(service.delegate({ requester: "codex", stage: "code_audit", project,
        prompt: "audit", ...delegatedArtifact("audit artifact"), approvalScope: "workspace-write",
        approvalReference: "unused", idempotencyKey: "audit:write" }))
        .rejects.toThrow(/read-only stage/i);
      expect(service.runs.list()).toEqual([]);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("scopes idempotency and generated coordination dependencies to the canonical project", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-project-scope-"));
    const projectA = join(root, "a"); const projectB = join(root, "b");
    (await import("node:fs")).mkdirSync(projectA); (await import("node:fs")).mkdirSync(projectB);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const common = { requester: "grok" as const, taskId: "same-task", stage: "planning" as const,
        prompt: "plan", ...delegatedArtifact("same artifact"), approvalScope: "workspace-read" as const,
        idempotencyKey: "same-task:planning" };
      const a = await service.delegate({ ...common, project: projectA });
      const b = await service.delegate({ ...common, project: projectB });
      expect(a.runId).not.toBe(b.runId);
      expect(service.runs.list()).toHaveLength(2);
      expect(service.runs.list().map((run) => run.payload?.project).sort()).toEqual([projectA, projectB]);
      expect(service.runtime.workflows.get(a.runId)?.taskId).not.toBe(service.runtime.workflows.get(b.runId)?.taskId);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects project escape and self-asserted write authority, then consumes an exact ledger grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-authority-service-"));
    const project = join(root, "project"); const outside = mkdtempSync(join(tmpdir(), "agent-collab-outside-"));
    (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    const input = { requester: "codex" as const, stage: "tdd_coding" as const, project, prompt: "implement",
      ...delegatedArtifact("write artifact"), approvalScope: "workspace-write" as const, approvalReference: "approval-write",
      idempotencyKey: "task:write" };
    try {
      await expect(service.delegate({ ...input, project: outside })).rejects.toThrow(/allowed project roots/i);
      await expect(service.delegate(input)).rejects.toThrow(/approval denied/i);
      service.approvals.issue({ reference: "approval-write", project, scope: "workspace-write", expiresAt: Date.now() + 60_000 });
      const first = await service.delegate(input);
      await expect(service.delegate(input)).resolves.toEqual(first);
      await expect(service.delegate({ ...input, idempotencyKey: "task:write:again" })).rejects.toThrow(/exhausted/i);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("creates two active and two deferred review lanes when one provider is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-degraded-service-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      service.providers.canAttempt("grok", 0);
      service.providers.recordFailoverFailure("grok", { kind: "auth" }, 1);
      service.providers.recordSuccess("codex", 1);
      const artifactContent = "degraded immutable artifact";
      const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const result = await service.requestReview({ requester: "codex", project, artifactHash, artifactContent,
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "degraded-review" });
      expect(result).toMatchObject({ laneCount: 4, activeLaneCount: 2, runState: "DEGRADED_SINGLE_PROVIDER" });
      expect(service.runs.list().map((run) => run.payload?.preferredAgent)).toEqual(["codex", "codex"]);
      expect(service.reviews.get(result.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
        .every((lane) => lane.status === "deferred")).toBe(true);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the actual degraded assignee consistently on first response and replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-degraded-delegate-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      service.providers.canAttempt("grok", 0);
      service.providers.recordFailoverFailure("grok", { kind: "auth" }, 1);
      service.providers.recordSuccess("codex", 1);
      const input = { requester: "codex" as const, stage: "planning" as const, project, prompt: "plan",
        ...delegatedArtifact("degraded plan artifact"), approvalScope: "workspace-read" as const, idempotencyKey: "degraded-plan" };
      const first = await service.delegate(input); const replay = await service.delegate(input);
      expect(first.assignedAgent).toBe("codex");
      expect(replay).toEqual(first);
      expect(service.runs.list()[0]?.payload?.preferredAgent).toBe("codex");
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
