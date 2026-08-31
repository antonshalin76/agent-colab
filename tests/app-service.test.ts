import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { grokWorkspaceMemoryDirectory, LocalCollabService, projectMemorySection } from "../src/app/service.js";
import type { AttemptAssignment } from "../src/workflow/workflow.js";
import { AgentRunner } from "../src/runners/agent-runner.js";
import Database from "better-sqlite3";
import { formatMapLearningLaunchBindingContext } from "../src/flow/map-admin.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";

const delegatedArtifact = (artifactContent: string) => ({
  artifactContent,
  artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
});

const markCapabilityReady = (service: LocalCollabService): void => {
  service.providers.recordSuccess("grok", 1);
  service.providers.recordSuccess("claude", 1);
  service.providers.recordSuccess("codex", 1);
};
const serviceOptions = (root: string) => {
  initializeCurrentExecutionSchema(join(root, "state.db"));
  return { allowedRoots: [root], agentSkillRoots: {
    grok: join(homedir(), ".agents", "skills"),
    claude: join(homedir(), ".agents", "skills"),
    codex: join(homedir(), ".agents", "skills"),
  } };
};

describe("local collaboration service wiring", () => {
  it("refuses to mint review grants for a non-Codex requester", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-grant-issuer-"));
    const database = join(root, "state.db");
    const service = new LocalCollabService(database, serviceOptions(root));
    const artifactContent = "issuer-bound review";
    const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
    try {
      await expect(service.requestReview({
        requester: "grok",
        workspaceRoot: root,
        artifactContent,
        artifactHash,
        approvalScope: "workspace-read",
        idempotencyKey: "non-codex-review",
        prompt: "review",
      })).rejects.toThrow(/Codex.*review grant|review grant.*Codex/i);
      expect(service.runs.list()).toEqual([]);
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("runs delegation and review with only the required Codex skill root installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-codex-only-skills-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const database = join(root, "state.db"); initializeCurrentExecutionSchema(database);
    const service = new LocalCollabService(database, {
      allowedRoots: [root],
      agentSkillRoots: {
        grok: join(root, "missing-grok-skills"),
        claude: join(root, "missing-claude-skills"),
        codex: join(homedir(), ".agents", "skills"),
      },
    });
    service.providers.recordSuccess("codex", 1);
    try {
      const reviewArtifact = delegatedArtifact("codex-only review artifact");
      await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
        artifactContent: reviewArtifact.artifactContent, artifactHash: reviewArtifact.artifactHash,
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "codex-only-review" }))
        .resolves.toMatchObject({ activeLaneCount: 2, runState: "DEGRADED_REVIEW_SET" });
      expect(service.runs.list().filter((run) => run.status === "queued")
        .every((run) => run.payload?.preferredAgent === "codex")).toBe(true);

      const delegated = delegatedArtifact("codex-only delegated artifact");
      await expect(service.delegate({ requester: "codex", stage: "planning", project,
        artifactContent: delegated.artifactContent, artifactHash: delegated.artifactHash,
        prompt: "plan", approvalScope: "workspace-read", idempotencyKey: "codex-only-plan" }))
        .resolves.toMatchObject({ assignedAgent: "codex" });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("still fails closed when the required Codex skill root is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-missing-codex-skills-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const database = join(root, "state.db"); initializeCurrentExecutionSchema(database);
    const service = new LocalCollabService(database, {
      allowedRoots: [root],
      agentSkillRoots: {
        grok: join(root, "missing-grok-skills"),
        claude: join(root, "missing-claude-skills"),
        codex: join(root, "missing-codex-skills"),
      },
    });
    service.providers.recordSuccess("codex", 1);
    const artifact = delegatedArtifact("required skill negative control");
    try {
      await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
        artifactContent: artifact.artifactContent, artifactHash: artifact.artifactHash,
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "missing-codex-review" }))
        .rejects.toThrow(/mandatory Codex auditor\/critic pair is unavailable/i);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("projects Codex as required and helper review harnesses as optional", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-policy-"));
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    try {
      expect((await service.status()).reviewPolicy).toEqual({
        required: ["codex:auditor", "codex:critic"],
        optional: ["grok:auditor", "grok:critic", "claude:auditor", "claude:critic"],
        optionalUnavailableBlocks: false,
        optionalChangesRequestedBlocks: true,
        optionalNeedsReconciliationBlocks: true,
      });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("exposes MAP learning administration without caller-selected root or database authority", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-admin-api-"));
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    try {
      expect(service.closeMapLearning).toHaveLength(1);
      expect(service.recordMapLearningEvidence).toHaveLength(1);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });
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
        requester: "grok", stage: "code_review", project, prompt: "review",
        artifactContent: "exact bytes", artifactHash: "0".repeat(64),
        approvalScope: "workspace-read", idempotencyKey: "mismatch",
      } as never)).rejects.toThrow(/artifact hash mismatch/i);

      const artifactContent = "a".repeat(262_144);
      const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const delegated = await service.delegate({
        requester: "grok", stage: "code_review", project, prompt: "review",
        artifactContent, artifactHash, approvalScope: "workspace-read",
        idempotencyKey: "large-artifact",
      });
      expect(service.runtime.workflows.get(delegated.runId)?.activeStage?.assignment).toMatchObject({
        agent: "codex",
        effort: "high",
        reasons: ["stage_baseline:coordination:medium", "large_artifact"],
      });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("persists one idempotent delegated stage with fallback disabled", async () => {
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
          payload: expect.objectContaining({ preferredAgent: "codex", allowFallback: false }),
        }),
      ]);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks planning on a six-lane MAP review with a Codex quorum", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-planning-map-gate-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const result = await service.delegate({ requester: "codex", stage: "planning", project,
        prompt: "build the plan", ...delegatedArtifact("planning input"), approvalScope: "workspace-read",
        idempotencyKey: "task:planning" });
      expect(result).toMatchObject({ status: "blocked_map_admission", mapAdmission: {
        satisfied: false,
        gates: [{ name: "architecture", barrier: { requiredCount: 2, satisfied: false } }],
      } });
      expect(service.runtime.workflows.get(result.runId)).toBeNull();
      expect(service.runs.list()).toHaveLength(6);
      expect(service.runs.list().every((run) => String(run.payload?.prompt)
        .includes('"kind":"planning"'))).toBe(true);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a public idempotency replay that changes the canonical workflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-service-immutable-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const first = { requester: "codex" as const, taskId: "task-a", stage: "code_review" as const,
        project, prompt: "first plan", ...delegatedArtifact("planning artifact"), approvalScope: "workspace-read" as const,
        idempotencyKey: "shared-key" };
      await service.delegate(first);
      await expect(service.delegate({ ...first, requester: "grok", taskId: "task-b", prompt: "different plan" }))
        .rejects.toThrow("workflow id conflicts with immutable collaboration input");
      expect(service.runtime.workflows.get((await service.delegate(first)).runId)?.origin).toBe("codex");
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("persists exactly six isolated review lanes with distinct provider-role keys", async () => {
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
        workspaceRoot: project,
        artifactHash,
        artifactContent,
        prompt: "review immutable artifact",
        approvalScope: "workspace-read",
        idempotencyKey: "task:review",
      });
      expect(result.laneCount).toBe(6);
      expect(result.activeLaneCount).toBe(6);
      expect(result.runState).toBe("FULL_CROSS_PROVIDER");
      expect(new Set(result.runIds).size).toBe(6);
      expect(service.runs.list().map((run) => [
        run.payload?.preferredAgent,
        run.payload?.reviewRole,
        run.idempotencyKey.split(":").slice(-2).join(":"),
      ]).sort((left, right) => String(left[2]).localeCompare(String(right[2])))).toEqual([
        ["grok", "auditor", "grok:auditor"],
        ["grok", "critic", "grok:critic"],
        ["claude", "auditor", "claude:auditor"],
        ["claude", "critic", "claude:critic"],
        ["codex", "auditor", "codex:auditor"],
        ["codex", "critic", "codex:critic"],
      ].sort((left, right) => String(left[2]).localeCompare(String(right[2]))));
      for (const run of service.runs.list()) {
        const binding = run.payload?.mapLearning as Parameters<
          typeof formatMapLearningLaunchBindingContext
        >[0];
        expect(binding).toMatchObject({
          schemaVersion: "map-learning-launch-binding/v1",
          consumer: run.payload?.preferredAgent,
        });
        const context = formatMapLearningLaunchBindingContext(binding);
        expect(String(run.payload?.prompt).split(context)).toHaveLength(2);
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
          expect.objectContaining({ agent: "claude", role: "auditor" }),
          expect.objectContaining({ agent: "claude", role: "critic" }),
          expect.objectContaining({ agent: "codex", role: "auditor" }),
          expect.objectContaining({ agent: "codex", role: "critic" }),
        ]),
      });
      await expect(service.runStatus({ runId: result.reviewId })).resolves.toMatchObject({
        review: {
          lanes: expect.arrayContaining([
            expect.objectContaining({ agent: "claude", role: "auditor", status: "queued" }),
            expect.objectContaining({ agent: "claude", role: "critic", status: "queued" }),
          ]),
        },
        barrier: { satisfied: false, terminalCount: 0, requiredCount: 2 },
      });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not admit recovered helpers when an idempotent review request replays after Codex closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-closed-review-service-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    try {
      const now = Date.now();
      service.providers.acquireExplicitProbeAdmission("grok", now);
      service.providers.recordFailoverFailure("grok", { kind: "quota" }, now, now);
      service.providers.acquireExplicitProbeAdmission("claude", now);
      service.providers.recordFailoverFailure("claude", { kind: "quota" }, now, now);
      service.providers.recordSuccess("codex", now);
      const artifactContent = "Codex-only immutable review";
      const request = {
        requester: "codex" as const,
        workspaceRoot: project,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        artifactContent,
        prompt: "review",
        approvalScope: "workspace-read" as const,
        idempotencyKey: "closed-review-replay",
      };
      const first = await service.requestReview(request);
      expect(first.activeLaneCount).toBe(2);
      for (const role of ["auditor", "critic"] as const) {
        const lane = service.reviews.get(first.reviewId)!.lanes.find(
          (candidate) => candidate.agent === "codex" && candidate.role === role,
        )!;
        const attempt = lane.attempts.at(-1)!;
        const run = service.runs.getByIdempotencyKey(attempt.idempotencyKey)!;
        const claimed = service.runs.claimNext({ workerId: "closed-review", leaseMs: 10_000, now: Date.now() })!;
        expect(claimed.id).toBe(run.id);
        service.runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "codex" });
        service.runs.markLaunched(claimed.id, claimed.leaseToken!, { phase: "started", pid: 1234,
          agent: "codex", model: attempt.model, effort: attempt.effort,
          policyVersion: attempt.policyVersion, sessionId: attempt.sessionId });
        const providerResult = { kind: "success", agent: "codex", reviewVerdict: {
          schemaVersion: "review-verdict/v1", verdict: "PASS", findings: [],
        } };
        const terminalAt = Date.now();
        service.runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!, providerResult,
          effect: { type: "review", reviewId: first.reviewId, attemptId: attempt.attemptId,
            role, agent: "codex", resultKind: "success", terminalAt }, status: "completed" });
        service.reviews.recordTerminal({ reviewId: first.reviewId, agent: "codex", role,
          attemptId: attempt.attemptId, status: "completed", result: providerResult,
          terminalAt });
      }
      expect(service.reviews.barrier(first.reviewId).satisfied).toBe(true);
      service.providers.recordSuccess("claude", Date.now());

      const replay = await service.requestReview(request);
      expect(replay.activeLaneCount).toBe(0);
      expect(service.runs.list()).toHaveLength(2);
      expect(service.reviews.get(first.reviewId)?.lanes.filter((lane) => lane.agent === "claude")
        .every((lane) => lane.status === "deferred")).toBe(true);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("binds all review providers to the exact linked worktree root and fingerprint", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-worktree-"));
    const main = join(root, "main"); const worktree = join(root, "review");
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["-C", main, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", main, "config", "user.name", "Test"]);
    (await import("node:fs")).writeFileSync(join(main, "tracked.txt"), "main\n");
    execFileSync("git", ["-C", main, "add", "tracked.txt"]);
    execFileSync("git", ["-C", main, "commit", "-qm", "base"]);
    execFileSync("git", ["-C", main, "worktree", "add", "-qb", "review", worktree]);
    (await import("node:fs")).writeFileSync(join(worktree, "review-only.txt"), "exact review state\n");
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "linked worktree review";
      const result = await service.requestReview({
        requester: "codex", workspaceRoot: worktree,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"), artifactContent,
        prompt: "review exact worktree", approvalScope: "workspace-read",
        idempotencyKey: "linked-worktree-review",
      } as never);
      const fingerprint = captureWorkspaceFingerprint(worktree).fingerprint;
      expect(service.runs.list()).toHaveLength(6);
      expect(service.runs.list().every((run) => run.payload?.project === worktree)).toBe(true);
      expect(service.runs.list().every((run) => run.payload?.sourceFingerprint === fingerprint)).toBe(true);
      expect(service.reviews.get(result.reviewId)).toMatchObject({ project: worktree, sourceFingerprint: fingerprint });
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects invalid review roots without durable side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-subdir-"));
    const outside = mkdtempSync(join(tmpdir(), "agent-collab-review-outside-"));
    const project = join(root, "project"); const subdir = join(project, "nested");
    execFileSync("git", ["init", "-q", project]); execFileSync("mkdir", [subdir]);
    const database = join(root, "state.db");
    const service = new LocalCollabService(database, serviceOptions(root));
    markCapabilityReady(service);
    const db = new Database(database, { readonly: true });
    const barrierCount = () => (db.prepare("SELECT count(*) AS count FROM runtime_review_barriers").get() as { count: number }).count;
    try {
      const beforeRuns = service.runs.list(); const beforeBarriers = barrierCount(); const artifactContent = "review";
      const invalidRoots: Array<[string, RegExp]> = [
        [subdir, /worktree top-level/i],
        [join(root, "missing"), /real project directory/i],
        [outside, /outside allowed project roots/i],
      ];
      for (const [index, [workspaceRoot, error]] of invalidRoots.entries()) {
        await expect(service.requestReview({ requester: "codex", workspaceRoot,
          artifactHash: createHash("sha256").update(artifactContent).digest("hex"), artifactContent,
          prompt: "review", approvalScope: "workspace-read", idempotencyKey: `invalid-review-${index}`,
        })).rejects.toThrow(error);
        expect(service.runs.list()).toEqual(beforeRuns);
        expect(barrierCount()).toBe(beforeBarriers);
      }
    } finally {
      db.close(); service.close();
      rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects credential-bearing review bytes instead of breaking the declared artifact hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-secret-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "review me sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE";
      await expect(service.requestReview({ requester: "codex", workspaceRoot: project, artifactContent,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"), prompt: "review",
        approvalScope: "workspace-read", idempotencyKey: "secret-review" }))
        .rejects.toThrow("cannot preserve its exact hash safely");
      expect(service.runs.list()).toHaveLength(0);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects credential-bearing delegated prompts before MAP or queue side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-delegate-secret-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      await expect(service.delegate({ requester: "codex", stage: "planning", project,
        prompt: "plan with sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE", ...delegatedArtifact("safe artifact"),
        approvalScope: "workspace-read", idempotencyKey: "secret-plan" }))
        .rejects.toThrow(/prompt contains credential material/i);
      expect(service.runs.list()).toEqual([]);
      expect(service.runtime.workflows.get("secret-plan")).toBeNull();
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
      const result = await service.requestReview({ requester: "codex", workspaceRoot: project, artifactContent,
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

  it("scopes review idempotency and all six lane keys to the canonical project", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-project-scope-"));
    const a = join(root, "a"); const b = join(root, "b");
    (await import("node:fs")).mkdirSync(a); (await import("node:fs")).mkdirSync(b);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      const artifactContent = "same review"; const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const common = { requester: "codex" as const, artifactHash, artifactContent, prompt: "review",
        approvalScope: "workspace-read" as const, idempotencyKey: "same-review" };
      const first = await service.requestReview({ ...common, workspaceRoot: a });
      const second = await service.requestReview({ ...common, workspaceRoot: b });
      expect(first.reviewId).not.toBe(second.reviewId);
      expect(service.runs.list()).toHaveLength(12);
      expect(new Set(service.runs.list().map((run) => run.idempotencyKey)).size).toBe(12);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("enforces policy routing and a durable Codex coordination dependency for Grok-origin work", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-routing-service-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      await expect(service.delegate({
        requester: "grok", taskId: "task-42", stage: "code_review", preferredAgent: "grok",
        project, prompt: "plan", ...delegatedArtifact("routing artifact"), approvalScope: "workspace-read",
        idempotencyKey: "task-42:review",
      })).rejects.toThrow(/routing policy requires codex/i);
      const delegated = await service.delegate({
        requester: "grok", taskId: "task-42", stage: "code_review", preferredAgent: "codex",
        project, prompt: "plan", ...delegatedArtifact("routing artifact"), approvalScope: "workspace-read",
        idempotencyKey: "task-42:review",
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
      const assignment = coordination.payload?.workflowDispatchIdentity as AttemptAssignment;
      const claimedCoordination = service.runs.claimNext({
        workerId: "w",
        leaseMs: 30_000,
        now: Date.now() + 1_000,
      })!;
      service.runs.markLaunchIntent(claimedCoordination.id, claimedCoordination.leaseToken!, {
        agent: "codex",
      });
      service.runs.markLaunched(claimedCoordination.id, claimedCoordination.leaseToken!, {
        phase: "started",
        pid: 12345,
        agent: "codex",
        model: assignment.model,
        effort: assignment.effort,
        policyVersion: assignment.policyVersion,
        sessionId: assignment.sessionId,
      });
      const receipt = {
        schemaVersion: "runner-outcome/v1",
        runId: claimedCoordination.id,
        runAttemptCount: claimedCoordination.attemptCount,
        dispatchId: claimedCoordination.idempotencyKey,
        workflowId: delegated.runId,
        stageId: String(coordination.payload?.workflowStageId),
        attemptId: assignment.attemptId,
        attemptOrdinal: assignment.attemptOrdinal,
        agent: assignment.agent,
        model: assignment.model,
        policyVersion: assignment.policyVersion,
        sessionId: assignment.sessionId,
        resultKind: "success",
      };
      service.runs.commitDomainEffect({
        id: claimedCoordination.id,
        token: claimedCoordination.leaseToken!,
        providerResult: { kind: "success", agent: "codex" },
        effect: { type: "workflow", workflowId: delegated.runId,
          stageId: String(coordination.payload?.workflowStageId), assignment,
          agent: "codex", resultKind: "success", terminalAt: Date.now(), runnerReceipt: receipt },
        status: "completed",
      });
      const state = service.runtime.recordRunnerOutcome(delegated.runId, receipt);
      expect(state.completedStageIds).toContain(coordination.payload?.workflowStageId);
      expect(service.runtime.drainDispatchOutbox(service.runs)).toBe(1);
      runs = service.runs.list();
      const review = runs.find((run) => run.stage === "code_review")!;
      expect(review.payload?.preferredAgent).toBe("codex");
      expect(review.payload?.allowFallback).toBe(false);
      const claim = service.runs.claimNext({ workerId: "w", leaseMs: 100, now: Date.now() });
      expect(claim?.id).toBe(review.id);
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
      const common = { requester: "grok" as const, taskId: "same-task", stage: "code_review" as const,
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
      expect(first).toMatchObject({
        status: "blocked_map_admission",
        assignedAgent: "codex",
        mapAdmission: {
          satisfied: false,
          profile: { version: "3.28.1", provider: "codex" },
          gates: [
            { name: "architecture", barrier: { satisfied: false, requiredCount: 2 } },
            { name: "implementer-readiness", barrier: { satisfied: false, requiredCount: 2 } },
          ],
        },
      });
      expect(service.runtime.workflows.get(first.runId)).toBeNull();
      expect(service.runs.list()).toHaveLength(12);
      expect(service.runs.list().every((run) => run.approvalScope === "workspace-read")).toBe(true);
      expect(service.runs.list().every((run) =>
        String(run.payload?.prompt).includes("review-verdict/v1"),
      )).toBe(true);
      expect(service.runs.list().every((run) =>
        String(run.payload?.prompt).includes('"schemaVersion":"map-learning-projection/v1"'),
      )).toBe(true);
      expect(service.approvals.validate({ reference: "approval-write", project,
        scope: "workspace-write" })).toEqual({ allowed: true, remainingUses: 1 });
      await expect(service.delegate({ ...input, prompt: "implement a different target" }))
        .rejects.toThrow(/immutable review conflict/i);
      await expect(service.delegate(input)).resolves.toEqual(first);
      if (!first.mapAdmission) throw new Error("expected blocked MAP admission evidence");
      const reviewWork = first.mapAdmission.gates.flatMap((gate) => {
        const review = service.reviews.get(gate.reviewId)!;
        return review.lanes.map((lane) => {
          const attempt = lane.attempts.at(-1)!;
          const run = service.runs.getByIdempotencyKey(attempt.idempotencyKey)!;
          return { gate, lane, attempt, run };
        });
      }).sort((left, right) => left.run.priority - right.run.priority ||
        left.run.createdAt - right.run.createdAt ||
        (["grok", "claude", "codex"].indexOf(left.lane.agent) -
          ["grok", "claude", "codex"].indexOf(right.lane.agent)) ||
        (["auditor", "critic"].indexOf(left.lane.role) -
          ["auditor", "critic"].indexOf(right.lane.role)) ||
        left.run.id.localeCompare(right.run.id));
      for (const { gate, lane, attempt, run } of reviewWork) {
          const claimed = service.runs.claimNext({ workerId: "map-review-test", leaseMs: 10_000,
            now: Date.now() })!;
          expect(claimed.id).toBe(run.id);
          service.runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: lane.agent });
          service.runs.markLaunched(claimed.id, claimed.leaseToken!, {
            phase: "started", pid: 1234, agent: lane.agent, model: attempt.model,
            effort: attempt.effort, policyVersion: attempt.policyVersion, sessionId: attempt.sessionId,
          });
          const providerResult = {
            kind: "success",
            agent: lane.agent,
            reviewVerdict: {
              schemaVersion: "review-verdict/v1",
              verdict: "PASS",
              findings: [],
            },
          };
          const terminalAt = Date.now();
          service.runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!,
            providerResult,
            effect: { type: "review", reviewId: gate.reviewId, attemptId: attempt.attemptId,
              role: lane.role, agent: lane.agent, resultKind: "success", terminalAt },
            status: "completed" });
          service.reviews.recordTerminal({
            reviewId: gate.reviewId,
            agent: lane.agent,
            role: lane.role,
            attemptId: attempt.attemptId,
            status: "completed",
            result: providerResult,
            terminalAt,
          });
      }
      await expect(service.delegate(input)).resolves.toMatchObject({ status: "running", assignedAgent: "codex" });
      const admittedTarget = service.runtime.workflows.get(first.runId)?.stages
        .find((stage) => stage.kind === "tdd_coding");
      expect(admittedTarget?.executionSnapshot).toMatchObject({
        schemaVersion: "execution-snapshot-binding/v1",
        snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const active = service.runtime.workflows.get(first.runId)?.activeStage;
      if (!active || active.kind !== "coordination") throw new Error("expected coordination before target dispatch");
      const claimedCoordination = service.runs.claimNext({
        workerId: "map-binding-test",
        leaseMs: 10_000,
        now: Date.now(),
      });
      if (!claimedCoordination?.leaseToken) throw new Error("expected queued coordination run");
      service.runs.markLaunchIntent(claimedCoordination.id, claimedCoordination.leaseToken, {
        agent: active.assignment.agent,
      });
      service.runs.markLaunched(claimedCoordination.id, claimedCoordination.leaseToken, {
        phase: "started",
        pid: 1235,
        agent: active.assignment.agent,
        model: active.assignment.model,
        effort: active.assignment.effort,
        policyVersion: active.assignment.policyVersion,
        sessionId: active.assignment.sessionId,
      });
      const coordinationReceipt = {
        schemaVersion: "runner-outcome/v1" as const,
        runId: claimedCoordination.id,
        runAttemptCount: claimedCoordination.attemptCount,
        dispatchId: claimedCoordination.idempotencyKey,
        workflowId: first.runId,
        stageId: active.id,
        attemptId: active.assignment.attemptId,
        attemptOrdinal: active.assignment.attemptOrdinal,
        agent: active.assignment.agent,
        model: active.assignment.model,
        policyVersion: active.assignment.policyVersion,
        sessionId: active.assignment.sessionId,
        resultKind: "success" as const,
      };
      service.runs.commitDomainEffect({
        id: claimedCoordination.id,
        token: claimedCoordination.leaseToken,
        providerResult: { kind: "success", agent: "codex" },
        effect: {
          type: "workflow",
          workflowId: first.runId,
          stageId: active.id,
          assignment: active.assignment,
          agent: "codex",
          resultKind: "success",
          terminalAt: Date.now(),
          runnerReceipt: coordinationReceipt,
        },
        status: "completed",
      });
      service.runtime.recordRunnerOutcome(first.runId, coordinationReceipt);
      expect(service.runtime.drainDispatchOutbox(service.runs)).toBe(1);
      const queuedTarget = service.runs.list().find((run) => run.stage === "tdd_coding");
      expect(queuedTarget?.payload?.executionSnapshot).toEqual(admittedTarget?.executionSnapshot);
      if (!queuedTarget) throw new Error("expected durable admitted target queue row");
      const launch = vi.fn(() => ({
        pid: 1236,
        result: Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: [
            JSON.stringify({ type: "session_meta", payload: { id: "admitted", model: "gpt-5.6-sol" } }),
            JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant",
              content: [{ type: "output_text", text: "admitted target" }] } }),
          ].join("\n") + "\n",
        }),
        terminate: vi.fn(),
      }));
      const admittedRunner = new AgentRunner({
        binaries: { grok: "/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000,
        authorizationDatabasePath: service.stateDatabase,
        launcher: { launch },
      });
      const processTask = {
        id: queuedTarget.id,
        stage: queuedTarget.stage,
        artifactHash: queuedTarget.artifactHash!,
        idempotencyKey: queuedTarget.idempotencyKey,
        approvalScope: queuedTarget.approvalScope!,
        payload: queuedTarget.payload!,
      };
      await expect(admittedRunner.run(processTask)).resolves.toMatchObject({ kind: "success" });
      const durableTamper = new Database(service.stateDatabase);
      let originalWorkflowJson: string;
      try {
        const row = durableTamper.prepare("SELECT state_json FROM collaboration_runs WHERE workflow_id=?")
          .get(first.runId) as { state_json: string };
        originalWorkflowJson = row.state_json;
        const forgedWorkflow = JSON.parse(row.state_json);
        forgedWorkflow.taskId = `${forgedWorkflow.taskId}:forged`;
        durableTamper.prepare("UPDATE collaboration_runs SET state_json=? WHERE workflow_id=?")
          .run(JSON.stringify(forgedWorkflow), first.runId);
        const forgedDurable = structuredClone(processTask);
        await expect(admittedRunner.run(forgedDurable)).resolves.toMatchObject({
          kind: "invalid_request",
          error: expect.stringMatching(/execution snapshot.*stale|conflicts/i),
        });
        durableTamper.prepare("UPDATE collaboration_runs SET state_json=? WHERE workflow_id=?")
          .run(originalWorkflowJson, first.runId);
      } finally { durableTamper.close(); }
      const sqlite = new Database(service.stateDatabase);
      try {
        sqlite.prepare(`UPDATE runtime_review_lanes SET status='failed'
          WHERE review_id=? AND agent='grok' AND role='critic'`).run(first.mapAdmission.gates[0]!.reviewId);
      } finally { sqlite.close(); }
      await expect(admittedRunner.run(processTask)).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/semantic PASS|review barrier/i),
      });
      const forgedPrompt = structuredClone(processTask);
      forgedPrompt.payload!.prompt = `${String(processTask.payload!.prompt)}\nprompt forged outside the durable MAP workflow`;
      await expect(admittedRunner.run(forgedPrompt)).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/queue payload.*snapshot/i),
      });
      const forgedArtifact = structuredClone(processTask);
      forgedArtifact.artifactHash = "f".repeat(64);
      await expect(admittedRunner.run(forgedArtifact)).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/queue payload.*snapshot/i),
      });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(service.runs.list().some((run) => run.stage === "coordination" &&
        String(run.payload?.prompt).includes("Promoted MAP learning projection for codex"))).toBe(true);
      await expect(service.delegate({ ...input, idempotencyKey: "task:write:again" })).rejects.toThrow(/exhausted/i);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  }, 30_000);

  it("does not turn a review request into an implicit Claude recovery probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-degraded-service-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      service.providers.acquireExplicitProbeAdmission("claude", 0);
      service.providers.recordFailoverFailure("claude", { kind: "auth" }, 1);
      service.providers.recordSuccess("grok", 1);
      service.providers.recordSuccess("codex", 1);
      const artifactContent = "degraded immutable artifact";
      const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
      const result = await service.requestReview({ requester: "codex", workspaceRoot: project, artifactHash, artifactContent,
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "degraded-review" });
      expect(result).toMatchObject({ laneCount: 6, activeLaneCount: 4, runState: "DEGRADED_REVIEW_SET" });
      expect(service.runs.list().map((run) => run.payload?.preferredAgent).sort()).toEqual([
        "grok", "grok", "codex", "codex",
      ].sort());
      expect(service.reviews.get(result.reviewId)?.lanes.filter((lane) => lane.agent === "claude")
        .map((lane) => lane.status)).toEqual(["deferred", "deferred"]);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the actual degraded assignee consistently on first response and replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-degraded-delegate-"));
    const project = join(root, "project"); (await import("node:fs")).mkdirSync(project);
    const service = new LocalCollabService(join(root, "state.db"), serviceOptions(root));
    markCapabilityReady(service);
    try {
      service.providers.acquireExplicitProbeAdmission("grok", 0);
      service.providers.recordFailoverFailure("grok", { kind: "auth" }, 1);
      service.providers.recordSuccess("codex", 1);
      const input = { requester: "codex" as const, stage: "planning" as const, project, prompt: "plan",
        ...delegatedArtifact("degraded plan artifact"), approvalScope: "workspace-read" as const, idempotencyKey: "degraded-plan" };
      const first = await service.delegate(input); const replay = await service.delegate(input);
      expect(first.assignedAgent).toBe("codex");
      expect(replay).toEqual(first);
      expect(service.runs.list().every((run) =>
        run.stage?.startsWith("review:") || run.payload?.preferredAgent === "codex",
      )).toBe(true);
    } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
