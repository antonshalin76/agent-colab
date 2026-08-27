import { describe, expect, it } from "vitest";
import {
  computePairedEvidence,
  scorePairedBenchmark,
  type PairedObservation,
} from "../src/eval/scoring.js";

const observation = (input: {
  caseId: string;
  arm: "A" | "B";
  quality: number;
  stage?: string;
  status?: PairedObservation["executionStatus"];
  blind?: boolean;
}): PairedObservation => ({
  blockId: `block:${input.caseId}`,
  caseId: input.caseId,
  taskClass: "bug",
  stage: input.stage ?? "tdd_coding",
  effort: "medium",
  policyId: "stage-pair-v1",
  repetition: 0,
  arm: input.arm,
  deterministicQuality: input.quality,
  blindJudgeResolved: input.blind ?? true,
  executionStatus: input.status ?? "completed",
  defectMetrics: {
    seededDefectsFound: 1,
    seededDefectsTotal: 1,
    truePositiveFindings: 1,
    totalFindings: 1,
    escapedDefects: 0,
  },
  reworkSteps: 0,
  wallTimeMs: 1_000,
  usage: {
    inputTokens: { value: 10, provenance: "provider" },
    cachedInputTokens: { value: 0, provenance: "provider" },
    outputTokens: { value: 5, provenance: "provider" },
    reasoningTokens: { value: 2, provenance: "provider" },
    totalTokens: { value: input.arm === "A" ? 17 : 15, provenance: "provider" },
    costUsd: { value: input.arm === "A" ? 0.02 : 0.01, provenance: "provider" },
  },
});

const input = (observations: readonly PairedObservation[]) => ({
  seed: 20_260_824,
  requiredIndependentCases: 2,
  observations,
  bootstrapSamples: 1_000,
  bootstrapAlgorithm: "mulberry32-nearest-rank-v1" as const,
});

const twoPairs = (stage = "tdd_coding"): PairedObservation[] => [
  observation({ caseId: "case-1", arm: "A", quality: 70, stage }),
  observation({ caseId: "case-1", arm: "B", quality: 80, stage }),
  observation({ caseId: "case-2", arm: "A", quality: 72, stage }),
  observation({ caseId: "case-2", arm: "B", quality: 82, stage }),
];

describe("paired scoring validity", () => {
  it("excludes an invalidated arm and withholds an inferential interval", () => {
    const observations = twoPairs();
    observations[3] = { ...observations[3]!, executionStatus: "invalidated" };

    const evidence = computePairedEvidence(input(observations));

    expect(evidence).toMatchObject({
      status: "inconclusive",
      matchedPairCount: 1,
      independentCaseCount: 1,
      qualityCi95: null,
      reasons: expect.arrayContaining(["invalid_pair", "insufficient_sample"]),
      metrics: {
        executionFailureRateDelta: 0,
        applicability: {
          quality: "unavailable",
          executionReliability: "applicable",
        },
      },
    });
  });

  it("keeps execution-outcome failures as reliability evidence without inventing judge disagreement", () => {
    const observations = twoPairs().map((row) => row.arm === "B" ? {
      ...row,
      executionStatus: "failed" as const,
      blindJudgeResolved: false,
      deterministicQuality: 0,
    } : row);

    const scored = scorePairedBenchmark(input(observations));

    expect(scored.evidence).toMatchObject({
      matchedPairCount: 2,
      metrics: {
        executionFailureRateDelta: 1,
        blindEvaluationComplete: true,
      },
    });
    expect(scored.evidence.reasons).not.toContain("blind_judge_disagreement");
    expect(scored.decision).toEqual({ verdict: "keep_provisional", basis: "reliability" });
  });

  it("does not apply review precision or recall gates to a coding stage", () => {
    const observations = twoPairs().map((row) => row.arm === "B" ? {
      ...row,
      defectMetrics: {
        ...row.defectMetrics,
        seededDefectsFound: 0,
        truePositiveFindings: 0,
        totalFindings: 10,
      },
    } : row);

    const scored = scorePairedBenchmark(input(observations));

    expect(scored.evidence.metrics).toMatchObject({
      review: null,
      applicability: { review: "not_applicable" },
    });
    expect(scored.decision).toEqual({ verdict: "candidate_change", basis: "quality" });
  });

  it("applies review gates on a review stage and marks denominator-free metrics unavailable", () => {
    const weak = twoPairs("code_review").map((row) => row.arm === "B" ? {
      ...row,
      defectMetrics: { ...row.defectMetrics, seededDefectsFound: 0 },
    } : row);
    expect(scorePairedBenchmark(input(weak)).decision).toEqual({
      verdict: "keep_provisional",
      basis: "review_quality",
    });

    const unavailable = twoPairs("code_review").map((row) => ({
      ...row,
      defectMetrics: {
        ...row.defectMetrics,
        seededDefectsFound: 0,
        seededDefectsTotal: 0,
        truePositiveFindings: 0,
        totalFindings: 0,
      },
    }));
    const scored = scorePairedBenchmark(input(unavailable));
    expect(scored.evidence.metrics).toMatchObject({
      review: { seededDefectRecallDelta: null, findingPrecision: null },
      applicability: { review: "unavailable" },
    });
    expect(scored.decision).toEqual({
      verdict: "inconclusive",
      basis: "review_metrics_unavailable",
    });
  });

  it("labels missing completed blind evaluation as incomplete, not disagreement", () => {
    const observations = twoPairs();
    observations[1] = { ...observations[1]!, blindJudgeResolved: false };

    const scored = scorePairedBenchmark(input(observations));

    expect(scored.evidence.reasons).toContain("blind_evaluation_incomplete");
    expect(scored.evidence.reasons).not.toContain("blind_judge_disagreement");
    expect(scored.decision).toEqual({
      verdict: "inconclusive",
      basis: "blind_evaluation_incomplete",
    });
  });

  it("keeps independently missing token or cost metrics null with explicit applicability", () => {
    const observations = twoPairs();
    observations[0] = {
      ...observations[0]!,
      usage: {
        ...observations[0]!.usage,
        costUsd: { value: null, provenance: "unavailable" },
      },
    };

    const evidence = computePairedEvidence(input(observations));

    expect(evidence.metrics.secondary).toMatchObject({ tokenDelta: -2, costDeltaUsd: null });
    expect(evidence.metrics.applicability).toMatchObject({
      totalTokens: "applicable",
      costUsd: "unavailable",
    });
    expect(evidence.reasons).toContain("missing_usage_provenance");
  });
});
