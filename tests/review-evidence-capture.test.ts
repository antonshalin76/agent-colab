import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalCollabService } from "../src/app/service.js";
import { createReviewPlan } from "../src/domain/review.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { executeReviewLaunchWithFence } from "../src/runtime/review-launch-admission.js";
import { activateRecoveredReviewLanes } from "../src/runtime/review-rejoin.js";
import {
  ReviewEvidenceCapture,
  type ReviewEvidenceCaptureEntryPoint,
  type ReviewEvidenceCaptureOutcome,
} from "../src/runtime/review-evidence-capture.js";
import { createEmptyStateDatabase } from "./helpers/state-database.js";

const roots: string[] = [];

const database = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-capture-"));
  roots.push(root);
  const path = join(root, "state.db");
  return createEmptyStateDatabase(path);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const entryPoints: readonly ReviewEvidenceCaptureEntryPoint[] = [
  "request_review",
  "map_admission",
  "recovery_rejoin",
  "prelaunch",
];

const reviewInput = {
  stageId: "authority-v3",
  artifact: Buffer.from("immutable review evidence"),
  approvalScope: "workspace-read" as const,
  idempotencyKey: "authority-v3-evidence",
  prompts: { auditor: "audit", critic: "critic" },
  sourceFingerprint: "source-v1",
  changedFiles: 1,
};

const unavailableOutcome = (agent: "grok" | "claude" | "codex", observedAt = 103) => ({
  kind: "provider_unavailable" as const,
  agent,
  observedAt,
  source: { sourceFingerprint: "source-v1", valid: true },
  readiness: { harnessReady: false, state: "provider_unavailable" as const, valid: false },
});

const readyOutcome = (agent: "grok" | "claude" | "codex", observedAt = 103) => ({
  kind: "ready" as const,
  agent,
  observedAt,
  source: { sourceFingerprint: "source-v1", valid: true },
  readiness: { harnessReady: true, state: "ready" as const, valid: true },
});

const serviceFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-evidence-entry-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const stateDatabase = join(root, "state.db");
  initializeCurrentExecutionSchema(stateDatabase);
  return { root, project, stateDatabase };
};

describe("ReviewEvidenceCapture typed boundary", () => {
  it("returns the same typed provider-unavailable classification at every production entry seam", () => {
    const capture = new ReviewEvidenceCapture({
      captureSource: () => ({ sourceFingerprint: "source-v1", valid: true }),
      captureReadiness: () => ({ harnessReady: false, state: "provider_unavailable", valid: false }),
      observedAt: () => 101,
    });

    const outcomes = entryPoints.map((entryPoint) => capture.capture({
      entryPoint,
      phase: entryPoint === "prelaunch" ? "prelaunch" : "admission",
      project: "/repo",
      agent: "grok",
      role: "auditor",
    }));

    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        kind: "provider_unavailable",
        agent: "grok",
        observedAt: 101,
        source: { sourceFingerprint: "source-v1", valid: true },
        readiness: { harnessReady: false, state: "provider_unavailable", valid: false },
      });
    }
  });

  it("returns typed valid source/readiness observations without entry-specific policy", () => {
    const capture = new ReviewEvidenceCapture({
      captureSource: () => ({ sourceFingerprint: "source-v1", valid: true }),
      captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
      observedAt: () => 102,
    });

    const outcomes = entryPoints.map((entryPoint) => capture.capture({
      entryPoint,
      phase: entryPoint === "prelaunch" ? "prelaunch" : "admission",
      project: "/repo",
      agent: "claude",
      role: "critic",
    }));

    expect(outcomes.every((outcome) => outcome.kind === "ready")).toBe(true);
    expect(outcomes.map(({ kind, agent, observedAt, source, readiness }) => ({
      kind, agent, observedAt, source, readiness,
    }))).toEqual(Array.from({ length: entryPoints.length }, () => ({
      kind: "ready",
      agent: "claude",
      observedAt: 102,
      source: { sourceFingerprint: "source-v1", valid: true },
      readiness: { harnessReady: true, state: "ready", valid: true },
    })));
  });

  it.each([
    { label: "raw exception", value: new Error("binary unavailable") },
    { label: "raw boolean", value: false },
    { label: "raw observation", value: { harnessReady: false } },
  ])("rejects $label at the ProviderHealthStore typed ingestion boundary", ({ value }) => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    const before = store.snapshot();

    expect(() => store.applyCaptureOutcome(value as never)).toThrow(/typed|capture outcome/i);
    expect(store.snapshot()).toEqual(before);
    store.close();
  });

  it("lets ProviderHealthStore apply a typed outcome without deriving lane policy", () => {
    const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
    const before = store.snapshot();
    const generationsBefore = Object.fromEntries(
      (["grok", "claude", "codex"] as const)
        .map((agent) => [agent, store.latestRecoveryGeneration(agent)]),
    );
    const outcome: ReviewEvidenceCaptureOutcome = unavailableOutcome("grok");

    expect(store.applyCaptureOutcome(outcome)).toMatchObject({
      agent: "grok",
      health: "unavailable",
    });
    const after = store.snapshot();
    expect(after.grok).not.toEqual(before.grok);
    expect(after.claude).toEqual(before.claude);
    expect(after.codex).toEqual(before.codex);
    expect(Object.fromEntries(
      (["grok", "claude", "codex"] as const)
        .map((agent) => [agent, store.latestRecoveryGeneration(agent)]),
    )).toEqual(generationsBefore);
    store.close();
  });

  it.each([
    { boundary: "source", captureSource: () => { throw new Error("source I/O failed"); },
      captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }) },
    { boundary: "readiness", captureSource: () => ({ sourceFingerprint: "source-v1", valid: true }),
      captureReadiness: () => { throw new Error("readiness I/O failed"); } },
  ])("classifies a $boundary capture exception as typed infrastructure_failure without health/G mutation",
    ({ captureSource, captureReadiness }) => {
      const capture = new ReviewEvidenceCapture({ captureSource, captureReadiness, observedAt: () => 104 });
      const outcome = capture.capture({
        entryPoint: "request_review",
        phase: "admission",
        project: "/repo",
        agent: "grok",
        role: "auditor",
      });
      expect(outcome).toMatchObject({ kind: "infrastructure_failure", agent: "grok" });

      const store = new ProviderHealthStore(database(), { cooldownMs: 1_000 });
      const before = store.snapshot();
      const generationsBefore = Object.fromEntries(
        (["grok", "claude", "codex"] as const)
          .map((agent) => [agent, store.latestRecoveryGeneration(agent)]),
      );
      expect(store.applyCaptureOutcome(outcome)).toMatchObject({ applied: false });
      expect(store.snapshot()).toEqual(before);
      expect(Object.fromEntries(
        (["grok", "claude", "codex"] as const)
          .map((agent) => [agent, store.latestRecoveryGeneration(agent)]),
      )).toEqual(generationsBefore);
      store.close();
    });

  it("maps the same unavailable health fact to optional Grok defer and mandatory Codex failure", () => {
    const optionalPlan = createReviewPlan({
      ...reviewInput,
      health: { grok: "unavailable", claude: "disabled", codex: "healthy" },
    });
    expect(optionalPlan.activeLanes.map(({ agent, role }) => `${agent}:${role}`)).toEqual([
      "codex:auditor",
      "codex:critic",
    ]);
    expect(optionalPlan.deferredLanes.filter(({ agent }) => agent === "grok")).toHaveLength(2);

    expect(() => createReviewPlan({
      ...reviewInput,
      health: { grok: "healthy", claude: "disabled", codex: "unavailable" },
    })).toThrow(/mandatory.*codex|codex.*mandatory/i);
  });
});

describe("ReviewEvidenceCapture production entry wiring", () => {
  it("uses typed ready evidence instead of conflicting legacy skill/readiness fields", async () => {
    const { root, project, stateDatabase } = serviceFixture();
    const evidenceCapture = { capture: vi.fn((input: { agent: "grok" | "claude" | "codex" }) =>
      readyOutcome(input.agent, 200)) } as unknown as ReviewEvidenceCapture;
    const service = new LocalCollabService(stateDatabase, {
      allowedRoots: [root],
      agentSkillRoots: {
        grok: join(root, "legacy-missing-grok-skills"),
        claude: join(root, "legacy-missing-claude-skills"),
        codex: join(homedir(), ".agents", "skills"),
      },
      evidenceCapture,
    });
    for (const agent of ["grok", "claude", "codex"] as const) service.providers.recordSuccess(agent, 1);
    const artifactContent = "typed evidence wins";

    try {
      await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
        artifactContent, artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "b8-typed-wins" }))
        .resolves.toMatchObject({ activeLaneCount: 6, runState: "FULL_CROSS_PROVIDER" });
      expect(evidenceCapture.capture).toHaveBeenCalledWith(expect.objectContaining({
        entryPoint: "request_review",
      }));
    } finally {
      service.close();
    }
  });

  it.each([
    ["harnessReady", { harnessReady: { grok: false, claude: false, codex: false } }],
    ["sourceFingerprint", { sourceFingerprint: "legacy-caller-fingerprint" }],
  ] as const)("rejects the legacy raw %s service option", (_label, legacyOption) => {
    const { root, stateDatabase } = serviceFixture();
    const evidenceCapture = { capture: vi.fn() } as unknown as ReviewEvidenceCapture;
    expect(() => new LocalCollabService(stateDatabase, {
      allowedRoots: [root], evidenceCapture, ...legacyOption,
    } as never)).toThrow(/legacy|raw|typed evidence|unsupported/i);
    expect(evidenceCapture.capture).not.toHaveBeenCalled();
  });

  it("transports the requestReview capture outcome unchanged to ProviderHealthStore", async () => {
    const { root, project, stateDatabase } = serviceFixture();
    const unavailable = unavailableOutcome("grok", 201);
    const evidenceCapture = { capture: vi.fn((input: { agent: "grok" | "claude" | "codex" }) =>
      input.agent === "grok" ? unavailable : readyOutcome(input.agent, 201)) } as unknown as ReviewEvidenceCapture;
    const service = new LocalCollabService(stateDatabase, {
      allowedRoots: [root],
      agentSkillRoots: {
        grok: join(homedir(), ".agents", "skills"),
        claude: join(homedir(), ".agents", "skills"),
        codex: join(homedir(), ".agents", "skills"),
      },
      evidenceCapture,
    });
    for (const agent of ["grok", "claude", "codex"] as const) service.providers.recordSuccess(agent, 1);
    const apply = vi.spyOn(service.providers, "applyCaptureOutcome");
    const artifactContent = "request evidence";

    try {
      await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
        artifactContent, artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        prompt: "review", approvalScope: "workspace-read", idempotencyKey: "b8-request" }))
        .resolves.toMatchObject({ activeLaneCount: 4, runState: "DEGRADED_REVIEW_SET" });
      expect(evidenceCapture.capture).toHaveBeenCalledWith(expect.objectContaining({
        entryPoint: "request_review", agent: "grok",
      }));
      expect(apply).toHaveBeenCalledWith(unavailable);
      expect(apply.mock.calls.find(([outcome]) => outcome === unavailable)?.[0]).toBe(unavailable);
    } finally {
      service.close();
    }
  });

  it.each([
    { agent: "grok", unavailableRole: "auditor" },
    { agent: "grok", unavailableRole: "critic" },
    { agent: "claude", unavailableRole: "auditor" },
    { agent: "claude", unavailableRole: "critic" },
  ] as const)("degrades an asymmetric optional $agent/$unavailableRole pair without blocking Codex",
    async ({ agent, unavailableRole }) => {
      const { root, project, stateDatabase } = serviceFixture();
      const evidenceCapture = { capture: vi.fn((input: {
        agent: "grok" | "claude" | "codex"; role: "auditor" | "critic";
      }) => input.agent === agent && input.role === unavailableRole
        ? unavailableOutcome(input.agent, 211)
        : readyOutcome(input.agent, 211)) } as unknown as ReviewEvidenceCapture;
      const service = new LocalCollabService(stateDatabase, {
        allowedRoots: [root], evidenceCapture,
        agentSkillRoots: {
          grok: join(homedir(), ".agents", "skills"),
          claude: join(homedir(), ".agents", "skills"),
          codex: join(homedir(), ".agents", "skills"),
        },
      });
      for (const provider of ["grok", "claude", "codex"] as const) {
        service.providers.recordSuccess(provider, 1);
      }
      const artifactContent = `optional asymmetric ${agent}/${unavailableRole}`;
      try {
        await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
          artifactContent, artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
          prompt: "review", approvalScope: "workspace-read",
          idempotencyKey: `optional-asymmetric-${agent}-${unavailableRole}` }))
          .resolves.toMatchObject({ activeLaneCount: 4, runState: "DEGRADED_REVIEW_SET" });
      } finally {
        service.close();
      }
    });

  it.each(["auditor", "critic"] as const)(
    "fails closed when the mandatory Codex %s lane is unavailable",
    async (unavailableRole) => {
      const { root, project, stateDatabase } = serviceFixture();
      const evidenceCapture = { capture: vi.fn((input: {
        agent: "grok" | "claude" | "codex"; role: "auditor" | "critic";
      }) => input.agent === "codex" && input.role === unavailableRole
        ? unavailableOutcome("codex", 212)
        : readyOutcome(input.agent, 212)) } as unknown as ReviewEvidenceCapture;
      const service = new LocalCollabService(stateDatabase, { allowedRoots: [root], evidenceCapture });
      for (const provider of ["grok", "claude", "codex"] as const) {
        service.providers.recordSuccess(provider, 1);
      }
      const artifactContent = `mandatory asymmetric ${unavailableRole}`;
      try {
        await expect(service.requestReview({ requester: "codex", workspaceRoot: project,
          artifactContent, artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
          prompt: "review", approvalScope: "workspace-read",
          idempotencyKey: `mandatory-asymmetric-${unavailableRole}` }))
          .rejects.toThrow(/mandatory Codex.*unavailable|mandatory Codex.*divergent/i);
      } finally {
        service.close();
      }
    });

  it("transports the MAP-admission capture outcome through the same boundary", async () => {
    const { root, project, stateDatabase } = serviceFixture();
    const unavailable = unavailableOutcome("grok", 202);
    const evidenceCapture = { capture: vi.fn((input: { agent: "grok" | "claude" | "codex" }) =>
      input.agent === "grok" ? unavailable : readyOutcome(input.agent, 202)) } as unknown as ReviewEvidenceCapture;
    const service = new LocalCollabService(stateDatabase, {
      allowedRoots: [root],
      agentSkillRoots: {
        grok: join(homedir(), ".agents", "skills"),
        claude: join(homedir(), ".agents", "skills"),
        codex: join(homedir(), ".agents", "skills"),
      },
      evidenceCapture,
    });
    for (const agent of ["grok", "claude", "codex"] as const) service.providers.recordSuccess(agent, 1);
    const apply = vi.spyOn(service.providers, "applyCaptureOutcome");
    const artifactContent = "MAP evidence";

    try {
      await expect(service.delegate({ requester: "codex", stage: "planning", project,
        artifactContent, artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        prompt: "plan", approvalScope: "workspace-read", idempotencyKey: "b8-map" }))
        .resolves.toMatchObject({ status: "blocked_map_admission" });
      expect(evidenceCapture.capture).toHaveBeenCalledWith(expect.objectContaining({
        entryPoint: "map_admission", agent: "grok",
      }));
      expect(apply.mock.calls.find(([outcome]) => outcome === unavailable)?.[0]).toBe(unavailable);
    } finally {
      service.close();
    }
  });

  it("transports the recovery-rejoin outcome unchanged and never activates on unavailable", () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    const unavailable = unavailableOutcome("grok", 203);
    const evidenceCapture = { capture: vi.fn(() => unavailable) } as unknown as ReviewEvidenceCapture;
    const apply = vi.spyOn(health, "applyCaptureOutcome");
    const reviews = {
      deferredReviewIds: vi.fn(() => ["review-1"]),
      get: vi.fn(() => ({ project: "/repo", lanes: [
        { agent: "grok", role: "auditor", status: "deferred" },
      ] })),
      barrier: vi.fn(() => ({ satisfied: false })),
      activateDeferred: vi.fn(),
    };

    activateRecoveredReviewLanes({
      agent: "grok", now: 203, reviews, health, evidenceCapture,
    } as never);

    expect(evidenceCapture.capture).toHaveBeenCalledWith(expect.objectContaining({
      entryPoint: "recovery_rejoin", agent: "grok",
    }));
    expect(apply.mock.calls.find(([outcome]) => outcome === unavailable)?.[0]).toBe(unavailable);
    expect(reviews.activateDeferred).not.toHaveBeenCalled();
    health.close();
  });

  it.each([
    { legacyField: "harnessReady", legacyValue: true },
    { legacyField: "captureFingerprint", legacyValue: () => ({ fingerprint: "caller-owned" }) },
  ])("rejects the legacy rejoin $legacyField overload", ({ legacyField, legacyValue }) => {
    const evidenceCapture = {
      capture: vi.fn(() => readyOutcome("grok", 203)),
    } as unknown as ReviewEvidenceCapture;
    const input = {
      agent: "grok",
      now: 203,
      reviews: {
        deferredReviewIds: vi.fn(() => []),
        get: vi.fn(),
        barrier: vi.fn(),
        activateDeferred: vi.fn(),
      },
      health: {
        applyCaptureOutcome: vi.fn(),
        latestRecoveryGeneration: vi.fn(() => 0),
      },
      evidenceCapture,
      [legacyField]: legacyValue,
    };

    expect(() => activateRecoveredReviewLanes(input as never))
      .toThrow(/legacy|raw|harnessReady|captureFingerprint|typed evidence/i);
    expect(evidenceCapture.capture).not.toHaveBeenCalled();
  });

  it("transports the prelaunch outcome unchanged and forbids launch on unavailable", async () => {
    const path = database();
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    const unavailable = unavailableOutcome("grok", 204);
    const evidenceCapture = { capture: vi.fn(() => unavailable) } as unknown as ReviewEvidenceCapture;
    const apply = vi.spyOn(health, "applyCaptureOutcome");
    const launch = vi.fn(async () => ({ kind: "success" }));
    const applyPrelaunchFence = vi.fn(() => ({ status: "no_spawn", reason: "provider_unavailable" }));
    const receiptCursor = vi.fn(() => ({ scopeRevision: 1, predecessorReceiptId: null }));
    const captureReviewReceipt = vi.fn();

    const result = await executeReviewLaunchWithFence({
      run: { id: "run-1", stage: "review:auditor", launched: false,
        payload: { decision: { agent: "grok" }, reviewId: "review-1",
          reviewAttemptId: "attempt-1", reviewAttemptOrdinal: 0,
          reviewDispatchIdentity: { attemptId: "attempt-1", attemptOrdinal: 0, agent: "grok" },
          reviewRole: "auditor", project: "/repo" } },
      health, observedAt: 204, evidenceCapture, launch,
      reviews: { applyPrelaunchFence, receiptCursor, captureReviewReceipt },
    } as never);

    expect(evidenceCapture.capture).toHaveBeenCalledWith(expect.objectContaining({
      entryPoint: "prelaunch", agent: "grok",
    }));
    expect(apply.mock.calls.find(([outcome]) => outcome === unavailable)?.[0]).toBe(unavailable);
    expect(result).toMatchObject({ status: "rejected", providerResult: unavailable,
      prelaunchFence: { status: "no_spawn", reason: "provider_unavailable" } });
    expect(captureReviewReceipt).toHaveBeenCalledTimes(1);
    expect(applyPrelaunchFence).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    health.close();
  });
});
