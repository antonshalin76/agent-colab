import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBalancedSchedule,
  createExperimentSchedule,
  createStagePairAssignments,
  invertPolicy,
} from "../src/eval/schedule.js";
import { createBlindJudgePacket } from "../src/eval/anonymization.js";
import { runHiddenOracle } from "../src/eval/oracle.js";
import {
  computePairedEvidence,
  decideBenchmark,
  scorePairedBenchmark,
  validateAndFreezeRubric,
} from "../src/eval/scoring.js";
import { createBenchmarkReport } from "../src/eval/report.js";
import { EvalStore } from "../src/eval/store.js";
import {
  ExperimentRunner,
  nextExperimentAction,
} from "../src/eval/experiment.js";

const POLICY = {
  planning: "grok",
  architecture: "codex",
  bdd: "grok",
  tdd_coding: "codex",
  unit_testing: "codex",
  code_review: "codex",
} as const;
const sha = (character: string): string => character.repeat(64);

const PB08_EVIDENCE = {
  suiteId: "local-v1",
  harnessVersion: "eval-v1",
  cells: [{
    blockId: "block-PUNTO-BUG-03-medium-0",
    pairIdentityHash: sha("1"),
    immutableInputHash: sha("2"),
    launchOrder: ["grok", "codex"] as const,
    orderReceiptHash: sha("3"),
    attempts: [{
      opaqueLabel: "candidate-k7",
      exitState: "completed",
      truncationReason: null,
      oracleResultHash: sha("4"),
      usageProvenanceHash: sha("5"),
      candidateDiffHash: sha("6"),
    }, {
      opaqueLabel: "candidate-m2",
      exitState: "failed",
      truncationReason: "wall_timeout",
      oracleResultHash: sha("7"),
      usageProvenanceHash: sha("8"),
      candidateDiffHash: sha("9"),
    }],
  }],
} as const;

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("paired benchmark schedule", () => {
  it("creates a deterministic seeded AB/BA schedule balanced per case", () => {
    const input = {
      seed: "suite-seed-2026-08-24",
      caseIds: ["PUNTO-BUG-03", "TR-BUG-01"],
      repetitions: 4,
      providers: ["grok", "codex"] as const,
    };

    const first = createBalancedSchedule(input);
    const replay = createBalancedSchedule(input);
    const differentSeed = createBalancedSchedule({ ...input, seed: "different-seed" });

    expect(first).toEqual(replay);
    expect(first).not.toEqual(differentSeed);
    expect(first).toHaveLength(input.caseIds.length * input.repetitions);

    for (const caseId of input.caseIds) {
      const rows = first.filter((row) => row.caseId === caseId);
      expect(rows.map((row) => row.repetition).sort()).toEqual([0, 1, 2, 3]);
      expect(rows.filter((row) => row.launchOrder.join(",") === "grok,codex"))
        .toHaveLength(2);
      expect(rows.filter((row) => row.launchOrder.join(",") === "codex,grok"))
        .toHaveLength(2);
    }
  });

  it("requires an even repetition count so every case has exact global AB/BA balance", () => {
    expect(() => createBalancedSchedule({
      seed: "suite-seed",
      caseIds: ["PUNTO-BUG-03", "TR-BUG-01"],
      repetitions: 3,
      providers: ["grok", "codex"] as const,
    })).toThrow(/repetition.*even|even.*repetition/i);
  });

  it("changes only the tested owner in a stage_pair block", () => {
    const block = createStagePairAssignments({
      stage: "planning",
      baselinePolicy: POLICY,
    });

    expect(block.mode).toBe("stage_pair");
    expect(block.fallbackEnabled).toBe(false);
    expect(block.armA).toEqual(POLICY);
    expect(block.armB).toEqual({ ...POLICY, planning: "codex" });

    const changedStages = Object.keys(block.armA).filter(
      (stage) => block.armA[stage as keyof typeof POLICY]
        !== block.armB[stage as keyof typeof POLICY],
    );
    expect(changedStages).toEqual(["planning"]);
  });

  it("builds the policy_crossover arm as the exact inverse and is involutive", () => {
    const inverse = invertPolicy(POLICY);

    expect(inverse).toEqual({
      planning: "codex",
      architecture: "grok",
      bdd: "codex",
      tdd_coding: "grok",
      unit_testing: "grok",
      code_review: "grok",
    });
    expect(invertPolicy(inverse)).toEqual(POLICY);
    expect(Object.keys(inverse)).toEqual(Object.keys(POLICY));
  });

  it("materializes collision-free case x effort x repetition cells with stable arm mapping", () => {
    const input = {
      suiteId: "local-v1",
      seed: "suite-seed-2026-08-24",
      cases: [
        {
          caseId: "PUNTO-BUG-03",
          taskClass: "bug",
          stage: "tdd_coding",
          mode: "stage_pair" as const,
          baselinePolicy: POLICY,
        },
        {
          caseId: "TR-REL-01",
          taskClass: "reliability",
          stage: "planning",
          mode: "policy_crossover" as const,
          baselinePolicy: POLICY,
        },
      ],
      efforts: ["medium", "high", "xhigh"] as const,
      repetitions: 4,
      providers: ["grok", "codex"] as const,
    };

    const cells = createExperimentSchedule(input);
    expect(cells).toEqual(createExperimentSchedule(input));
    expect(cells).toHaveLength(2 * 3 * 4);
    expect(new Set(cells.map((cell) => cell.blockId)).size).toBe(cells.length);
    expect(new Set(cells.map((cell) => JSON.stringify(cell.pairIdentity))).size)
      .toBe(cells.length);

    for (const caseSpec of input.cases) {
      for (const effort of input.efforts) {
        const group = cells.filter((cell) =>
          cell.caseId === caseSpec.caseId && cell.effort === effort);
        expect(group).toHaveLength(4);
        expect(group.filter((cell) => cell.launchOrder.join(",") === "grok,codex"))
          .toHaveLength(2);
        expect(group.filter((cell) => cell.launchOrder.join(",") === "codex,grok"))
          .toHaveLength(2);
        expect(group.map((cell) => cell.repetition).sort()).toEqual([0, 1, 2, 3]);
      }
    }

    const stagePair = cells.find((cell) =>
      cell.caseId === "PUNTO-BUG-03" && cell.effort === "medium");
    expect(stagePair).toMatchObject({
      mode: "stage_pair",
      stage: "tdd_coding",
      armA: { provider: "codex", policy: POLICY },
      armB: { provider: "grok", policy: { ...POLICY, tdd_coding: "grok" } },
      pairIdentity: {
        suiteId: "local-v1",
        caseId: "PUNTO-BUG-03",
        stage: "tdd_coding",
        effort: "medium",
        repetition: expect.any(Number),
        policyId: expect.any(String),
      },
    });

    const crossover = cells.find((cell) =>
      cell.caseId === "TR-REL-01" && cell.effort === "high");
    expect(crossover).toMatchObject({
      mode: "policy_crossover",
      armA: { provider: "mixed", policy: POLICY },
      armB: { provider: "mixed", policy: invertPolicy(POLICY) },
    });
    expect(crossover?.armA.policyId).not.toBe(crossover?.armB.policyId);

    for (const group of [
      cells.filter((cell) => cell.caseId === "PUNTO-BUG-03" && cell.effort === "medium"),
      cells.filter((cell) => cell.caseId === "TR-REL-01" && cell.effort === "high"),
    ]) {
      expect(new Set(group.map((cell) => JSON.stringify(cell.armA))).size).toBe(1);
      expect(new Set(group.map((cell) => JSON.stringify(cell.armB))).size).toBe(1);
    }
  });
});

describe("blind oracle boundary", () => {
  it("emits an allowlisted opaque packet without provider identity or ordering metadata", () => {
    const packet = createBlindJudgePacket({
      opaqueLabel: "candidate-k7",
      artifactHash: "sha256:artifact",
      visibleText: "candidate result",
      patch: "diff --git a/core.ts b/core.ts",
      metadata: {
        provider: "grok",
        model: "grok-4.6",
        sessionId: "grok-session-secret",
        workspacePath: "/tmp/eval/grok-first",
        author: "Anton Shalin",
        launchOrder: 1,
        nested: {
          provider: "grok",
          sourcePath: "/home/anton/scripts/punto",
          order: "AB",
        },
      },
    });

    expect(packet).toEqual({
      opaqueLabel: "candidate-k7",
      artifactHash: "sha256:artifact",
      visibleText: "candidate result",
      patch: "diff --git a/core.ts b/core.ts",
    });

    const serialized = JSON.stringify(packet);
    for (const forbidden of [
      "provider",
      "model",
      "session",
      "workspacePath",
      "sourcePath",
      "author",
      "launchOrder",
      "grok-4.6",
      "grok-session-secret",
      "/tmp/eval/grok-first",
      "/home/anton/scripts/punto",
      "Anton Shalin",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    {
      name: "visible output",
      visibleText: "grok used grok-4.6 in grok-session-secret for Anton Shalin, order AB",
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      name: "patch headers and filenames",
      visibleText: "candidate result",
      patch: [
        "diff --git a/tmp/eval/grok-first/src/main.ts b/tmp/eval/grok-first/src/main.ts",
        "--- /home/anton/scripts/punto/src/main.ts",
        "+++ /tmp/eval/grok-first/src/main.ts",
      ].join("\n"),
    },
  ])("rejects identity sentinels leaked through $name", ({ visibleText, patch }) => {
    expect(() => createBlindJudgePacket({
      opaqueLabel: "candidate-k7",
      artifactHash: "sha256:artifact",
      visibleText,
      patch,
      metadata: {
        provider: "grok",
        model: "grok-4.6",
        sessionId: "grok-session-secret",
        workspacePath: "/tmp/eval/grok-first",
        sourcePath: "/home/anton/scripts/punto",
        author: "Anton Shalin",
        launchOrder: "AB",
      },
    })).toThrow(/identity|sentinel|blind|metadata|path/i);
  });

  it("keeps the hidden oracle outside the candidate workspace and runs it only after exit", async () => {
    const execute = vi.fn(async () => ({ points: 100, hardGatesPassed: true }));

    await expect(runHiddenOracle({
      workspaceRoot: "/tmp/attempts/candidate-k7",
      oracleRoot: "/tmp/eval-private/oracles/PUNTO-BUG-03",
      providerExited: false,
      execute,
    })).rejects.toThrow(/provider.*exit/i);
    expect(execute).not.toHaveBeenCalled();

    await expect(runHiddenOracle({
      workspaceRoot: "/tmp/attempts/candidate-k7",
      oracleRoot: "/tmp/attempts/candidate-k7/.hidden-tests",
      providerExited: true,
      execute,
    })).rejects.toThrow(/oracle.*workspace|workspace.*oracle/i);
    expect(execute).not.toHaveBeenCalled();

    await expect(runHiddenOracle({
      workspaceRoot: "/tmp/attempts/candidate-k7",
      oracleRoot: "/tmp/eval-private/oracles/PUNTO-BUG-03",
      providerExited: true,
      execute,
    })).resolves.toEqual({ points: 100, hardGatesPassed: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("resolves dot-dot paths before enforcing oracle containment", async () => {
    const execute = vi.fn(async () => ({ points: 100, hardGatesPassed: true }));

    await expect(runHiddenOracle({
      workspaceRoot: "/tmp/attempts/candidate-k7",
      oracleRoot: "/tmp/eval-private/../attempts/candidate-k7/.hidden-tests",
      providerExited: true,
      execute,
    })).rejects.toThrow(/oracle.*workspace|workspace.*oracle/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves symlinks before enforcing oracle containment", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-oracle-boundary-"));
    temporaryRoots.push(root);
    const workspaceRoot = join(root, "attempt");
    const hiddenInsideWorkspace = join(workspaceRoot, ".hidden-tests");
    const outsideAlias = join(root, "outside-oracle-alias");
    mkdirSync(hiddenInsideWorkspace, { recursive: true });
    symlinkSync(hiddenInsideWorkspace, outsideAlias, "dir");
    const execute = vi.fn(async () => ({ points: 100, hardGatesPassed: true }));

    await expect(runHiddenOracle({
      workspaceRoot,
      oracleRoot: outsideAlias,
      providerExited: true,
      execute,
    })).rejects.toThrow(/oracle.*workspace|workspace.*oracle/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not mistake a sibling with the same path prefix for workspace containment", async () => {
    const execute = vi.fn(async () => ({ points: 100, hardGatesPassed: true }));

    await expect(runHiddenOracle({
      workspaceRoot: "/tmp/attempts/candidate-k7",
      oracleRoot: "/tmp/attempts/candidate-k7-private-oracle",
      providerExited: true,
      execute,
    })).resolves.toEqual({ points: 100, hardGatesPassed: true });
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("immutable deterministic rubric", () => {
  const rubric = {
    version: "PUNTO-BUG-03-v1",
    checks: [
      {
        id: "strict-command-grammar",
        weight: 60,
        hardGate: true,
        evaluator: { kind: "command", argv: ["npm", "test", "--", "ipc"] },
      },
      {
        id: "regression-suite",
        weight: 40,
        hardGate: true,
        evaluator: { kind: "function", name: "checkRegressionSuite" },
      },
    ],
  } as const;

  it("accepts exactly 100 integer points and deeply freezes the rubric", () => {
    const frozen = validateAndFreezeRubric(rubric);

    expect(frozen.checks.reduce((sum, check) => sum + check.weight, 0)).toBe(100);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.checks)).toBe(true);
    expect(Object.isFrozen(frozen.checks[0])).toBe(true);
    expect(Object.isFrozen(frozen.checks[0]!.evaluator)).toBe(true);
    expect(Object.isFrozen(
      (frozen.checks[0]!.evaluator as { argv: readonly string[] }).argv,
    )).toBe(true);
    expect(() => {
      (frozen.checks[0] as unknown as { weight: number }).weight = 50;
    }).toThrow(TypeError);
  });

  it.each([
    ["sum below 100", [60, 39]],
    ["sum above 100", [60, 41]],
    ["fractional weight", [60.5, 39.5]],
    ["negative weight", [110, -10]],
    ["zero weight", [100, 0]],
  ] as const)("rejects %s", (_name, weights) => {
    expect(() => validateAndFreezeRubric({
      ...rubric,
      checks: rubric.checks.map((check, index) => ({
        ...check,
        weight: weights[index]!,
      })),
    })).toThrow(/weight|100|positive|integer/i);
  });
});

describe("lexicographic benchmark decision", () => {
  const eligible = {
    pairsComplete: true,
    sampleSufficient: true,
    usageProvenanceComplete: true,
    blindJudgeResolved: true,
    medianQualityDelta: 6,
    qualityCi95: { lower: 1, upper: 10 },
    qualityNoninferiorityLower: 1,
    executionFailureRateDelta: 0,
    review: null,
    secondary: {
      wallTimeDeltaMs: 10_000,
      tokenDelta: 5_000,
      costDeltaUsd: 1,
    },
  } as const;

  it("promotes only a quality-qualified alternative even when it is slower and costlier", () => {
    expect(decideBenchmark(eligible)).toMatchObject({
      verdict: "candidate_change",
      basis: "quality",
    });
  });

  it("does not let time, tokens, or cost override inferior quality", () => {
    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: -3,
      qualityCi95: { lower: -5, upper: -1 },
      qualityNoninferiorityLower: -5,
      secondary: {
        wallTimeDeltaMs: -100_000,
        tokenDelta: -1_000_000,
        costDeltaUsd: -100,
      },
    })).toMatchObject({ verdict: "keep_provisional", basis: "quality" });
  });

  it.each([
    ["missing pair", { pairsComplete: false }],
    ["insufficient sample", { sampleSufficient: false }],
    ["missing usage provenance", { usageProvenanceComplete: false }],
    ["blind disagreement", { blindJudgeResolved: false }],
    ["confidence interval crosses zero", { qualityCi95: { lower: 0, upper: 10 } }],
  ] as const)("returns inconclusive for %s", (_name, override) => {
    expect(decideBenchmark({ ...eligible, ...override })).toMatchObject({
      verdict: "inconclusive",
    });
  });

  it("requires review recall not to decrease and precision to stay at least 80 percent", () => {
    expect(decideBenchmark({
      ...eligible,
      review: { seededDefectRecallDelta: -0.01, findingPrecision: 0.95 },
    })).toMatchObject({ verdict: "keep_provisional", basis: "review_quality" });

    expect(decideBenchmark({
      ...eligible,
      review: { seededDefectRecallDelta: 0, findingPrecision: 0.799 },
    })).toMatchObject({ verdict: "keep_provisional", basis: "review_quality" });
  });

  it("rejects a candidate whose execution failure rate worsens", () => {
    expect(decideBenchmark({
      ...eligible,
      executionFailureRateDelta: 0.01,
    })).toMatchObject({ verdict: "keep_provisional", basis: "reliability" });
  });

  it("accepts the exact quality and noninferiority boundaries without rounding", () => {
    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: 5,
      qualityCi95: { lower: Number.EPSILON, upper: 9 },
    })).toMatchObject({ verdict: "candidate_change", basis: "quality" });

    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: 5,
      qualityCi95: { lower: 0, upper: 9 },
    })).toMatchObject({ verdict: "inconclusive" });

    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: 4.999,
      qualityCi95: { lower: Number.EPSILON, upper: 9 },
    })).toMatchObject({ verdict: "keep_provisional", basis: "quality" });

    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: 1,
      qualityCi95: { lower: -2, upper: 4 },
      qualityNoninferiorityLower: -2,
      secondary: {
        wallTimeDeltaMs: -100_000,
        tokenDelta: -1_000_000,
        costDeltaUsd: -100,
      },
    })).toMatchObject({
      verdict: "inconclusive",
      basis: "secondary",
      secondaryWinner: "candidate",
    });

    expect(decideBenchmark({
      ...eligible,
      medianQualityDelta: 1,
      qualityCi95: { lower: -2.001, upper: 4 },
      qualityNoninferiorityLower: -2.001,
      secondary: {
        wallTimeDeltaMs: -100_000,
        tokenDelta: -1_000_000,
        costDeltaUsd: -100,
      },
    })).toMatchObject({
      verdict: "keep_provisional",
      basis: "quality",
      secondaryWinner: null,
    });
  });

  it("accepts the exact review precision boundary when recall does not decrease", () => {
    expect(decideBenchmark({
      ...eligible,
      review: { seededDefectRecallDelta: 0, findingPrecision: 0.8 },
    })).toMatchObject({ verdict: "candidate_change", basis: "quality" });
  });

  it("blocks promotion when any task class regresses despite an aggregate gain", () => {
    expect(decideBenchmark({
      ...eligible,
      taskClassRegressions: ["bug"],
    })).toMatchObject({
      verdict: "keep_provisional",
      basis: "task_class_regression",
    });
  });
});

describe("paired evidence from raw observations", () => {
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
      : sorted[midpoint]!;
  };

  const referenceMulberry32Interval = (
    deltas: readonly number[],
    samples: number,
    seed: number,
  ): { lower: number; upper: number } => {
    let state = seed >>> 0;
    const random = (): number => {
      state = (state + 0x6D2B79F5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    const medians: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const resample = Array.from(
        { length: deltas.length },
        () => deltas[Math.floor(random() * deltas.length)]!,
      );
      medians.push(median(resample));
    }
    medians.sort((left, right) => left - right);
    return {
      lower: medians[Math.ceil(samples * 0.025) - 1]!,
      upper: medians[Math.ceil(samples * 0.975) - 1]!,
    };
  };

  const observation = (
    caseId: string,
    taskClass: "bug" | "reliability",
    repetition: number,
    arm: "A" | "B",
    deterministicQuality: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    blockId: `block:${caseId}:tdd_coding:medium:stage-pair-v1:${repetition}`,
    caseId,
    taskClass,
    stage: "tdd_coding",
    effort: "medium",
    policyId: "stage-pair-v1",
    repetition,
    arm,
    deterministicQuality,
    blindJudgeResolved: true,
    executionStatus: "completed" as const,
    defectMetrics: {
      seededDefectsFound: 8,
      seededDefectsTotal: 10,
      truePositiveFindings: 8,
      totalFindings: 10,
      escapedDefects: 2,
    },
    reworkSteps: 1,
    wallTimeMs: 10_000,
    usage: {
      inputTokens: { value: 100, provenance: "provider" },
      cachedInputTokens: { value: 10, provenance: "provider" },
      outputTokens: { value: 20, provenance: "provider" },
      reasoningTokens: { value: 5, provenance: "provider" },
      totalTokens: { value: 135, provenance: "derived" },
      costUsd: { value: 0.02, provenance: "provider" },
    },
    ...overrides,
  });

  const completeObservations = [
    observation("PUNTO-BUG-03", "bug", 0, "A", 70),
    observation("PUNTO-BUG-03", "bug", 0, "B", 74),
    observation("PUNTO-BUG-03", "bug", 1, "A", 70),
    observation("PUNTO-BUG-03", "bug", 1, "B", 76),
    observation("TR-BUG-01", "bug", 0, "A", 75),
    observation("TR-BUG-01", "bug", 0, "B", 83),
    observation("TR-BUG-01", "bug", 1, "A", 75),
    observation("TR-BUG-01", "bug", 1, "B", 85),
  ];

  it("computes a reproducible paired median and seeded bootstrap interval", () => {
    const expectedInterval = referenceMulberry32Interval(
      [5, 9],
      2_000,
      20_260_824,
    );
    const input = {
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: completeObservations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1" as const,
    };

    const first = computePairedEvidence(input);
    const replay = computePairedEvidence(input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "ready",
      matchedPairCount: 4,
      independentCaseCount: 2,
      medianQualityDelta: 7,
    });
    expect(expectedInterval).toEqual({ lower: 5, upper: 9 });
    expect(first.qualityCi95).toEqual(expectedInterval);
    expect(first.qualityCi95).not.toBeNull();
    if (!first.qualityCi95) throw new Error("expected a sufficient-sample interval");
    expect(Number.isFinite(first.qualityCi95.lower)).toBe(true);
    expect(Number.isFinite(first.qualityCi95.upper)).toBe(true);
    expect(first.qualityCi95).not.toEqual({
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
    });
  });

  it("returns inconclusive for unmatched arms and insufficient matched samples", () => {
    expect(computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: completeObservations.slice(0, -1),
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["missing_pair"]),
    });

    expect(computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 3,
      observations: completeObservations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      status: "inconclusive",
      matchedPairCount: 4,
      independentCaseCount: 2,
      reasons: expect.arrayContaining(["insufficient_sample"]),
    });

    expect(() => computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 1,
      observations: completeObservations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toThrow(/independent cases.*at least 2|at least 2.*independent cases/i);
  });

  it("rejects a block id reused across different stage, effort, policy, or repetition identity", () => {
    const observations = structuredClone(completeObservations);
    observations[1]!.effort = "high";

    expect(() => computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toThrow(/pair identity collision/i);
  });

  it("derives missing field-level usage provenance instead of treating it as zero", () => {
    const observations = structuredClone(completeObservations);
    observations[0]!.usage.costUsd.provenance = "";

    expect(computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      status: "inconclusive",
      usageProvenanceComplete: false,
      reasons: expect.arrayContaining(["missing_usage_provenance"]),
      metrics: { secondary: { tokenDelta: 0, costDeltaUsd: null } },
    });
  });

  it("surfaces a per-task-class regression that an aggregate median would hide", () => {
    const observations = [
      observation("PUNTO-BUG-03", "bug", 0, "A", 90),
      observation("PUNTO-BUG-03", "bug", 0, "B", 86),
      observation("TR-REL-01", "reliability", 0, "A", 60),
      observation("TR-REL-01", "reliability", 0, "B", 72),
      observation("TR-REL-01", "reliability", 1, "A", 60),
      observation("TR-REL-01", "reliability", 1, "B", 72),
      observation("TR-REL-01", "reliability", 2, "A", 60),
      observation("TR-REL-01", "reliability", 2, "B", 72),
    ];

    expect(computePairedEvidence({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      status: "ready",
      medianQualityDelta: 4,
      taskClassRegressions: ["bug"],
      byTaskClass: {
        bug: { independentCaseCount: 1, medianQualityDelta: -4 },
        reliability: { independentCaseCount: 1, medianQualityDelta: 12 },
      },
    });
  });

  it("derives keep_provisional end to end when raw pairs hide a task-class regression", () => {
    const observations = [
      observation("PUNTO-BUG-03", "bug", 0, "A", 90),
      observation("PUNTO-BUG-03", "bug", 0, "B", 86),
      observation("TR-REL-01", "reliability", 0, "A", 60),
      observation("TR-REL-01", "reliability", 0, "B", 72),
      observation("TR-REL-01", "reliability", 1, "A", 60),
      observation("TR-REL-01", "reliability", 1, "B", 72),
      observation("TR-REL-01", "reliability", 2, "A", 60),
      observation("TR-REL-01", "reliability", 2, "B", 72),
    ];

    expect(scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      evidence: {
        matchedPairCount: 4,
        independentCaseCount: 2,
        medianQualityDelta: 4,
        taskClassRegressions: ["bug"],
      },
      decision: {
        verdict: "keep_provisional",
        basis: "task_class_regression",
      },
    });
  });

  it("derives inconclusive end to end from unavailable raw usage provenance", () => {
    const observations = structuredClone(completeObservations);
    observations[3]!.usage.reasoningTokens.provenance = "";

    expect(scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      evidence: {
        usageProvenanceComplete: false,
        reasons: expect.arrayContaining(["missing_usage_provenance"]),
        metrics: { secondary: { tokenDelta: 0, costDeltaUsd: 0 } },
      },
      decision: {
        verdict: "inconclusive",
        basis: "missing_usage_provenance",
      },
    });
  });

  it("derives blind, reliability, review, and secondary metrics from raw observations", () => {
    const blind = structuredClone(completeObservations);
    blind[0]!.blindJudgeResolved = false;
    expect(scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: blind,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      decision: { verdict: "inconclusive", basis: "blind_evaluation_incomplete" },
    });

    const unreliable = structuredClone(completeObservations);
    for (const row of unreliable.filter((item) => item.arm === "B")) {
      row.executionStatus = "failed" as never;
    }
    expect(scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: unreliable,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    })).toMatchObject({
      evidence: { metrics: { executionFailureRateDelta: 1 } },
      decision: { verdict: "keep_provisional", basis: "reliability" },
    });

    const weakerReview = structuredClone(completeObservations);
    for (const row of weakerReview) row.stage = "code_review";
    for (const row of weakerReview.filter((item) => item.arm === "B")) {
      row.defectMetrics.seededDefectsFound = 7;
    }
    const reviewScore = scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: weakerReview,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    });
    expect(reviewScore).toMatchObject({
      evidence: {
        metrics: {
          review: { findingPrecision: 0.8 },
          defectEscapeDelta: 0,
        },
      },
      decision: { verdict: "keep_provisional", basis: "review_quality" },
    });
    expect(reviewScore.evidence.metrics.review?.seededDefectRecallDelta).toBeCloseTo(-0.1);

    const efficient = structuredClone(completeObservations);
    for (const row of efficient.filter((item) => item.arm === "B")) {
      const control = efficient.find((item) =>
        item.blockId === row.blockId && item.arm === "A");
      if (!control) throw new Error("expected matched control observation");
      row.deterministicQuality = control.deterministicQuality;
      row.wallTimeMs = 8_000;
      row.reworkSteps = 0;
      row.usage.totalTokens.value = 100;
      row.usage.costUsd.value = 0.01;
    }
    const scored = scorePairedBenchmark({
      seed: 20_260_824,
      requiredIndependentCases: 2,
      observations: efficient,
      bootstrapSamples: 2_000,
      bootstrapAlgorithm: "mulberry32-nearest-rank-v1",
    });
    expect(scored.evidence.metrics.secondary).toEqual({
      wallTimeDeltaMs: -2_000,
      tokenDelta: -35,
      costDeltaUsd: -0.01,
      reworkDelta: null,
    });
    expect(scored.decision).toMatchObject({
      verdict: "inconclusive",
      basis: "secondary",
      secondaryWinner: "candidate",
    });
  });
});

describe("coverage-safe reporting", () => {
  it("refuses owner conclusions for stages not covered by the declared corpus", () => {
    expect(() => createBenchmarkReport({
      coveredStages: ["planning", "architecture", "bdd", "tdd_coding"],
      stageConclusions: [
        { stage: "planning", verdict: "candidate_change", owner: "codex" },
        { stage: "ui_ux", verdict: "candidate_change", owner: "grok" },
      ],
      evidence: PB08_EVIDENCE,
    })).toThrow(/ui_ux.*uncovered|uncovered.*ui_ux/i);
  });

  it("allows an explicit inconclusive entry without asserting an uncovered owner", () => {
    expect(createBenchmarkReport({
      coveredStages: ["planning"],
      stageConclusions: [
        { stage: "planning", verdict: "keep_provisional", owner: "grok" },
        { stage: "ui_ux", verdict: "inconclusive" },
      ],
      evidence: PB08_EVIDENCE,
    })).toMatchObject({
      stageConclusions: [
        { stage: "planning", verdict: "keep_provisional", owner: "grok" },
      ],
      refusedConclusions: [{ stage: "ui_ux", reason: "uncovered" }],
      evidence: PB08_EVIDENCE,
    });
  });

  it("requires complete PB-08 hashes and terminal evidence for every reported cell", () => {
    const incomplete = structuredClone(PB08_EVIDENCE) as Record<string, unknown>;
    const cells = incomplete.cells as Array<Record<string, unknown>>;
    delete cells[0]!.orderReceiptHash;

    expect(() => createBenchmarkReport({
      coveredStages: ["planning"],
      stageConclusions: [
        { stage: "planning", verdict: "keep_provisional", owner: "grok" },
      ],
      evidence: incomplete as never,
    })).toThrow(/PB-08|orderReceiptHash|evidence/i);
  });
});

describe("durable experiment runner integration", () => {
  const prepareRunningPair = (store: EvalStore, key: string) => {
    const block = store.createBlock({
      idempotencyKey: key,
      manifestHash: sha("a"),
      seed: 20_260_824,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    });
    const grok = store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: `${key}-grok-session`,
    });
    const codex = store.createAttempt({
      blockId: block.id,
      provider: "codex",
      repetition: 0,
      sessionId: `${key}-codex-session`,
    });
    store.advanceBlock(block.id, "preflighted", { receiptHash: sha("d") });
    store.advanceBlock(block.id, "running", { receiptHash: sha("e") });
    return { block, grok, codex };
  };

  it("commits launched state and receipt before invoking the launcher, then never repeats after a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-eval-runner-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "eval.db");
    let store = new EvalStore(databasePath);
    const { block } = prepareRunningPair(store, "crash-visible");
    let launchReceiptObserved = "";
    const launcher = vi.fn(async (request: {
      attemptId: string;
      launchReceiptHash: string;
    }) => {
      const independentReader = new EvalStore(databasePath);
      const persisted = independentReader.getAttempt(request.attemptId);
      independentReader.close();

      expect(persisted).toMatchObject({
        id: request.attemptId,
        status: "launched",
        launchReceiptHash: request.launchReceiptHash,
      });
      expect(request.launchReceiptHash).toMatch(/^[a-f0-9]{64}$/);
      launchReceiptObserved = request.launchReceiptHash;
      throw new Error("simulated harness crash after external launch");
    });
    const runner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => ({ unchanged: true, mismatches: [] }),
      providerHealth: async () => ({ grok: "healthy", codex: "healthy" }),
      launchOrder: ["grok", "codex"],
      launcher,
    });

    await expect(runner.runNext(block.id)).rejects.toThrow(/simulated harness crash/i);
    expect(launcher).toHaveBeenCalledOnce();
    expect(launchReceiptObserved).toMatch(/^[a-f0-9]{64}$/);
    const launchedAttempt = store.listAttempts(block.id)
      .find((attempt) => attempt.status === "launched");
    expect(launchedAttempt).toMatchObject({
      status: "launched",
      launchReceiptHash: launchReceiptObserved,
    });
    if (!launchedAttempt) throw new Error("expected one launched attempt");
    store.close();

    store = new EvalStore(databasePath);
    const resumedLauncher = vi.fn(async () => {
      throw new Error("terminal or uncertain attempt was launched twice");
    });
    const resumedRunner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => ({ unchanged: true, mismatches: [] }),
      providerHealth: async () => ({ grok: "healthy", codex: "healthy" }),
      launchOrder: ["grok", "codex"],
      launcher: resumedLauncher,
    });
    await expect(resumedRunner.runNext(block.id)).resolves.toEqual({
      kind: "reconciliation_required",
      attemptId: launchedAttempt.id,
      reason: "persisted_launched_attempt",
    });
    expect(resumedLauncher).not.toHaveBeenCalled();
    store.close();
  });

  it("invalidates the whole pair on an integrity receipt mismatch before any launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-eval-integrity-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "eval.db");
    const store = new EvalStore(databasePath);
    const { block } = prepareRunningPair(store, "integrity-mismatch");
    const launcher = vi.fn(async () => ({
      status: "completed" as const,
      evidenceHash: sha("f"),
    }));
    const runner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => ({
        unchanged: false,
        mismatches: ["source_integrity_receipt"],
      }),
      providerHealth: async () => ({ grok: "healthy", codex: "healthy" }),
      launchOrder: ["grok", "codex"],
      launcher,
    });

    await expect(runner.runNext(block.id)).resolves.toEqual({
      kind: "mark_block_inconclusive",
      reason: "source_integrity_mismatch",
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(store.getBlock(block.id)).toMatchObject({ state: "inconclusive" });
    expect(store.listAttempts(block.id)).toHaveLength(2);
    expect(store.listAttempts(block.id).every((attempt) => attempt.status === "invalidated"))
      .toBe(true);
    store.close();
  });

  it("rechecks integrity between arms and never launches arm two after a mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-eval-between-arms-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "eval.db");
    const store = new EvalStore(databasePath);
    const { block } = prepareRunningPair(store, "between-arms-mismatch");
    const firstAttempt = store.listAttempts(block.id)
      .find((attempt) => attempt.provider === "grok");
    const secondAttempt = store.listAttempts(block.id)
      .find((attempt) => attempt.provider === "codex");
    if (!firstAttempt || !secondAttempt) throw new Error("expected a complete pair");
    let integrityMatches = true;
    const armOneLauncher = vi.fn(async () => ({
      status: "completed" as const,
      evidenceHash: sha("f"),
    }));
    const armTwoLauncher = vi.fn(async () => ({
      status: "completed" as const,
      evidenceHash: sha("9"),
    }));
    const launcher = vi.fn(async (request: {
      attemptId: string;
      provider: "grok" | "codex";
      launchReceiptHash: string;
    }) => request.attemptId === firstAttempt.id
      ? armOneLauncher()
      : armTwoLauncher());
    const runner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => integrityMatches
        ? { unchanged: true, mismatches: [] }
        : { unchanged: false, mismatches: ["source_integrity_receipt"] },
      providerHealth: async () => ({ grok: "healthy", codex: "healthy" }),
      launchOrder: ["grok", "codex"],
      launcher,
    });

    await expect(runner.runNext(block.id)).resolves.toEqual({
      kind: "attempt_completed",
      attemptId: firstAttempt.id,
    });
    expect(armOneLauncher).toHaveBeenCalledOnce();
    expect(armTwoLauncher).not.toHaveBeenCalled();
    expect(store.getAttempt(firstAttempt.id)).toMatchObject({
      status: "completed",
      evidenceHash: sha("f"),
    });

    integrityMatches = false;
    await expect(runner.runNext(block.id)).resolves.toEqual({
      kind: "mark_block_inconclusive",
      reason: "source_integrity_mismatch",
    });

    expect(armOneLauncher).toHaveBeenCalledOnce();
    expect(armTwoLauncher).not.toHaveBeenCalled();
    expect(launcher).toHaveBeenCalledOnce();
    expect(store.getBlock(block.id)).toMatchObject({ state: "inconclusive" });
    expect(store.getAttempt(firstAttempt.id)).toMatchObject({ status: "completed" });
    expect(store.getAttempt(secondAttempt.id)).toMatchObject({ status: "invalidated" });
    expect(store.isAttemptLaunchable(firstAttempt.id)).toBe(false);
    expect(store.isAttemptLaunchable(secondAttempt.id)).toBe(false);
    store.close();
  });

  it("marks the paired block inconclusive without launch when either scheduled provider is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-eval-health-"));
    temporaryRoots.push(root);
    const store = new EvalStore(join(root, "eval.db"));
    const { block } = prepareRunningPair(store, "provider-unavailable");
    const launcher = vi.fn(async () => ({
      status: "completed" as const,
      evidenceHash: sha("f"),
    }));
    const runner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => ({ unchanged: true, mismatches: [] }),
      providerHealth: async () => ({ grok: "healthy", codex: "unavailable" }),
      launchOrder: ["grok", "codex"],
      launcher,
    });

    await expect(runner.runNext(block.id)).resolves.toEqual({
      kind: "mark_block_inconclusive",
      reason: "provider_unavailable",
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(store.getBlock(block.id)).toMatchObject({ state: "inconclusive" });
    expect(store.listAttempts(block.id).every((attempt) => attempt.status === "invalidated"))
      .toBe(true);
    store.close();
  });

  it("does not let ExperimentRunner launch before the block reaches running", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-eval-block-state-"));
    temporaryRoots.push(root);
    const store = new EvalStore(join(root, "eval.db"));
    const block = store.createBlock({
      idempotencyKey: "not-running",
      manifestHash: sha("a"),
      seed: 20_260_824,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    });
    store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: "not-running-grok",
    });
    store.createAttempt({
      blockId: block.id,
      provider: "codex",
      repetition: 0,
      sessionId: "not-running-codex",
    });
    store.advanceBlock(block.id, "preflighted", { receiptHash: sha("d") });
    const launcher = vi.fn(async () => ({
      status: "completed" as const,
      evidenceHash: sha("f"),
    }));
    const runner = new ExperimentRunner({
      store,
      verifyIntegrity: async () => ({ unchanged: true, mismatches: [] }),
      providerHealth: async () => ({ grok: "healthy", codex: "healthy" }),
      launchOrder: ["grok", "codex"],
      launcher,
    });

    await expect(runner.runNext(block.id)).resolves.toEqual({
      kind: "block_not_runnable",
      state: "preflighted",
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(store.listAttempts(block.id).every((attempt) => attempt.status === "planned"))
      .toBe(true);
    store.close();
  });
});

describe("experiment resume and outage handling", () => {
  it("does not use production fallback when either provider is unavailable before launch", () => {
    expect(nextExperimentAction({
      blockId: "block-1",
      blockStatus: "preflighted",
      providers: { grok: "unavailable", codex: "healthy" },
      launchOrder: ["grok", "codex"],
      attempts: [
        { attemptId: "block-1:grok:0", provider: "grok", status: "planned" },
        { attemptId: "block-1:codex:0", provider: "codex", status: "planned" },
      ],
    })).toEqual({
      kind: "mark_block_inconclusive",
      reason: "provider_unavailable",
    });
  });

  it("resumes with the remaining planned half and never relaunches a terminal attempt", () => {
    const state = {
      blockId: "block-2",
      blockStatus: "running" as const,
      providers: { grok: "healthy" as const, codex: "healthy" as const },
      launchOrder: ["grok", "codex"] as const,
      attempts: [
        { attemptId: "block-2:grok:0", provider: "grok" as const, status: "completed" as const },
        { attemptId: "block-2:codex:0", provider: "codex" as const, status: "planned" as const },
      ],
    };

    expect(nextExperimentAction(state)).toEqual({
      kind: "launch_attempt",
      attemptId: "block-2:codex:0",
    });

    expect(nextExperimentAction({
      ...state,
      attempts: state.attempts.map((attempt) => ({
        ...attempt,
        status: "completed" as const,
      })),
    })).toEqual({ kind: "check_block" });
  });

  it("reconciles a persisted launched attempt after restart before any new launch", () => {
    const action = nextExperimentAction({
      blockId: "block-3",
      blockStatus: "running",
      providers: { grok: "unavailable", codex: "healthy" },
      launchOrder: ["grok", "codex"],
      attempts: [
        { attemptId: "block-3:grok:0", provider: "grok", status: "launched" },
        { attemptId: "block-3:codex:0", provider: "codex", status: "planned" },
      ],
    });

    expect(action).toEqual({
      kind: "reconciliation_required",
      attemptId: "block-3:grok:0",
      reason: "persisted_launched_attempt",
    });
    expect(action.kind).not.toBe("launch_attempt");
  });

  it("rejects launch from a non-running block and obeys the scheduled provider order", () => {
    expect(nextExperimentAction({
      blockId: "block-4",
      blockStatus: "preflighted",
      providers: { grok: "healthy", codex: "healthy" },
      launchOrder: ["grok", "codex"],
      attempts: [
        { attemptId: "block-4:codex:0", provider: "codex", status: "planned" },
        { attemptId: "block-4:grok:0", provider: "grok", status: "planned" },
      ],
    })).toEqual({
      kind: "block_not_runnable",
      state: "preflighted",
    });

    expect(nextExperimentAction({
      blockId: "block-4",
      blockStatus: "running",
      providers: { grok: "healthy", codex: "healthy" },
      launchOrder: ["grok", "codex"],
      attempts: [
        { attemptId: "block-4:codex:0", provider: "codex", status: "planned" },
        { attemptId: "block-4:grok:0", provider: "grok", status: "planned" },
      ],
    })).toEqual({
      kind: "launch_attempt",
      attemptId: "block-4:grok:0",
    });
  });
});
