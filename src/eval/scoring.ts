export interface RubricCheck {
  readonly weight: number;
  readonly evaluator: unknown;
}

export interface RubricInput {
  readonly checks: readonly RubricCheck[];
}

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
};

export const validateAndFreezeRubric = <T extends RubricInput>(rubric: T): T => {
  if (rubric.checks.length === 0) throw new Error("rubric requires weighted checks");
  for (const check of rubric.checks) {
    if (!Number.isInteger(check.weight) || check.weight <= 0) {
      throw new Error("rubric weight must be a positive integer");
    }
  }
  if (rubric.checks.reduce((sum, check) => sum + check.weight, 0) !== 100) {
    throw new Error("rubric weights must sum to 100");
  }
  return deepFreeze(structuredClone(rubric));
};

export type ObservationArm = "A" | "B";

export interface ProvenancedNumber {
  readonly value: number | null;
  readonly provenance: string | null;
}

export interface PairedObservation {
  readonly blockId: string;
  readonly caseId: string;
  readonly taskClass: string;
  readonly stage: string;
  readonly effort: string;
  readonly policyId: string;
  readonly repetition: number;
  readonly arm: ObservationArm;
  readonly deterministicQuality: number;
  readonly blindJudgeResolved: boolean;
  readonly executionStatus: "completed" | "failed" | "invalidated";
  readonly defectMetrics: Readonly<{
    seededDefectsFound: number;
    seededDefectsTotal: number;
    truePositiveFindings: number;
    totalFindings: number;
    escapedDefects: number;
  }>;
  readonly reworkSteps: number;
  readonly wallTimeMs: number;
  readonly usage: Readonly<{
    inputTokens: ProvenancedNumber;
    cachedInputTokens: ProvenancedNumber;
    outputTokens: ProvenancedNumber;
    reasoningTokens: ProvenancedNumber;
    totalTokens: ProvenancedNumber;
    costUsd: ProvenancedNumber;
  }>;
}

export interface PairedEvidenceInput {
  readonly seed: number;
  readonly requiredIndependentCases: number;
  readonly observations: readonly PairedObservation[];
  readonly bootstrapSamples: number;
  readonly bootstrapAlgorithm: "mulberry32-nearest-rank-v1";
}

export type MetricApplicability = "applicable" | "not_applicable" | "unavailable";

export interface DerivedMetrics {
  readonly blindEvaluationComplete: boolean;
  readonly executionFailureRateDelta: number;
  readonly review: Readonly<{
    seededDefectRecallDelta: number | null;
    findingPrecision: number | null;
  }> | null;
  readonly defectEscapeDelta: number | null;
  readonly secondary: Readonly<{
    wallTimeDeltaMs: number;
    tokenDelta: number | null;
    costDeltaUsd: number | null;
    reworkDelta: number | null;
  }>;
  readonly applicability: Readonly<{
    quality: MetricApplicability;
    blindEvaluation: MetricApplicability;
    executionReliability: MetricApplicability;
    review: MetricApplicability;
    defectEscape: MetricApplicability;
    wallTime: MetricApplicability;
    totalTokens: MetricApplicability;
    costUsd: MetricApplicability;
    rework: MetricApplicability;
  }>;
}

export interface PairedEvidence {
  readonly status: "ready" | "inconclusive";
  readonly reasons: readonly string[];
  readonly matchedPairCount: number;
  readonly independentCaseCount: number;
  readonly medianQualityDelta: number | null;
  readonly qualityCi95: Readonly<{ lower: number; upper: number }> | null;
  readonly usageProvenanceComplete: boolean;
  readonly taskClassRegressions: readonly string[];
  readonly byTaskClass: Readonly<Record<string, Readonly<{
    independentCaseCount: number;
    medianQualityDelta: number;
  }>>>;
  readonly metrics: DerivedMetrics;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const bootstrapMedianInterval = (
  independentCaseDeltas: readonly number[],
  samples: number,
  seed: number,
): { lower: number; upper: number } => {
  if (independentCaseDeltas.length === 0) return { lower: 0, upper: 0 };
  const random = mulberry32(seed);
  const medians: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    medians.push(median(Array.from(
      { length: independentCaseDeltas.length },
      () => independentCaseDeltas[Math.floor(random() * independentCaseDeltas.length)]!,
    )));
  }
  medians.sort((left, right) => left - right);
  return {
    lower: medians[Math.ceil(samples * 0.025) - 1]!,
    upper: medians[Math.ceil(samples * 0.975) - 1]!,
  };
};

interface MutablePair {
  readonly identity: string;
  readonly caseId: string;
  readonly taskClass: string;
  A?: PairedObservation;
  B?: PairedObservation;
  duplicate: boolean;
}

interface CompletePair extends MutablePair {
  A: PairedObservation;
  B: PairedObservation;
}

const fieldHasProvenance = (field: ProvenancedNumber): boolean =>
  field.value !== null && Number.isFinite(field.value) && field.value >= 0
  && typeof field.provenance === "string" && field.provenance.length > 0;

const usageComplete = (observation: PairedObservation): boolean =>
  Object.values(observation.usage).every(fieldHasProvenance);

const isReviewStage = (stage: string | undefined): boolean =>
  stage === "code_review" || stage?.startsWith("review:") === true;

const clusterMetric = (
  pairs: readonly CompletePair[],
  metric: (pair: CompletePair) => number,
): number => {
  const byCase = new Map<string, number[]>();
  for (const pair of pairs) {
    const values = byCase.get(pair.caseId) ?? [];
    values.push(metric(pair));
    byCase.set(pair.caseId, values);
  }
  return median([...byCase.values()].map((values) => median(values)));
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export const computePairedEvidence = (input: PairedEvidenceInput): PairedEvidence => {
  if (!Number.isSafeInteger(input.seed)) throw new Error("bootstrap seed must be an integer");
  if (!Number.isSafeInteger(input.requiredIndependentCases)
    || input.requiredIndependentCases < 2) {
    throw new Error("independent cases must be at least 2");
  }
  if (!Number.isSafeInteger(input.bootstrapSamples) || input.bootstrapSamples <= 0) {
    throw new Error("bootstrap samples must be a positive integer");
  }
  if (input.bootstrapAlgorithm !== "mulberry32-nearest-rank-v1") {
    throw new Error("unsupported bootstrap algorithm");
  }

  const pairs = new Map<string, MutablePair>();
  const blockIdentities = new Map<string, string>();
  const analysisCells = new Set<string>();
  for (const observation of input.observations) {
    if (!Number.isFinite(observation.deterministicQuality)
      || observation.deterministicQuality < 0
      || observation.deterministicQuality > 100) {
      throw new Error("deterministic quality must be within 0..100");
    }
    if (!Number.isSafeInteger(observation.reworkSteps) || observation.reworkSteps < 0
      || !Number.isFinite(observation.wallTimeMs) || observation.wallTimeMs < 0) {
      throw new Error("rework and wall time metrics must be non-negative");
    }
    const defectValues = Object.values(observation.defectMetrics);
    if (defectValues.some((value) => !Number.isSafeInteger(value) || value < 0)
      || observation.defectMetrics.seededDefectsFound
        > observation.defectMetrics.seededDefectsTotal
      || observation.defectMetrics.truePositiveFindings
        > observation.defectMetrics.totalFindings) {
      throw new Error("defect metrics must be bounded non-negative integers");
    }
    analysisCells.add([observation.stage, observation.effort, observation.policyId].join("\0"));
    const identity = [
      observation.blockId,
      observation.caseId,
      observation.stage,
      observation.effort,
      observation.policyId,
      observation.repetition,
    ].join("\0");
    const priorIdentity = blockIdentities.get(observation.blockId);
    if (priorIdentity && priorIdentity !== identity) {
      throw new Error("pair identity collision for block id");
    }
    blockIdentities.set(observation.blockId, identity);
    const pair = pairs.get(identity) ?? {
      identity,
      caseId: observation.caseId,
      taskClass: observation.taskClass,
      duplicate: false,
    };
    if (pair.taskClass !== observation.taskClass) {
      throw new Error("pair identity collision for task class");
    }
    if (pair[observation.arm]) pair.duplicate = true;
    else pair[observation.arm] = observation;
    pairs.set(identity, pair);
  }
  if (analysisCells.size > 1) {
    throw new Error("paired evidence must cover one stage, effort, and policy cell");
  }

  const completePairs: CompletePair[] = [];
  let missingPair = false;
  let invalidPair = false;
  for (const pair of pairs.values()) {
    if (!pair.A || !pair.B || pair.duplicate) missingPair = true;
    else if (pair.A.executionStatus === "invalidated"
      || pair.B.executionStatus === "invalidated") invalidPair = true;
    else completePairs.push(pair as CompletePair);
  }

  const qualityByCase = new Map<string, { taskClass: string; deltas: number[] }>();
  for (const pair of completePairs) {
    const cluster = qualityByCase.get(pair.caseId) ?? {
      taskClass: pair.taskClass,
      deltas: [],
    };
    if (cluster.taskClass !== pair.taskClass) {
      throw new Error("case id cannot span task classes in one evidence set");
    }
    cluster.deltas.push(pair.B.deterministicQuality - pair.A.deterministicQuality);
    qualityByCase.set(pair.caseId, cluster);
  }
  const caseDeltas = [...qualityByCase.values()].map((cluster) => median(cluster.deltas));

  const reasons: string[] = [];
  if (missingPair) reasons.push("missing_pair");
  if (invalidPair) reasons.push("invalid_pair");
  if (qualityByCase.size < input.requiredIndependentCases) reasons.push("insufficient_sample");

  const pairedObservations = completePairs.flatMap((pair) => [pair.A, pair.B]);
  const usageProvenanceComplete = pairedObservations.length > 0
    && pairedObservations.every(usageComplete);
  const tokenProvenanceComplete = pairedObservations.length > 0
    && pairedObservations.every((item) => fieldHasProvenance(item.usage.totalTokens));
  const costProvenanceComplete = pairedObservations.length > 0
    && pairedObservations.every((item) => fieldHasProvenance(item.usage.costUsd));
  if (pairedObservations.length > 0 && !usageProvenanceComplete) {
    reasons.push("missing_usage_provenance");
  }
  const completedObservations = pairedObservations.filter(
    (item) => item.executionStatus === "completed",
  );
  const blindEvaluationComplete = completedObservations.every(
    (item) => item.blindJudgeResolved,
  );
  if (!blindEvaluationComplete) reasons.push("blind_evaluation_incomplete");

  const classCases = new Map<string, number[]>();
  for (const cluster of qualityByCase.values()) {
    const values = classCases.get(cluster.taskClass) ?? [];
    values.push(median(cluster.deltas));
    classCases.set(cluster.taskClass, values);
  }
  const byTaskClass: Record<string, {
    independentCaseCount: number;
    medianQualityDelta: number;
  }> = {};
  for (const [taskClass, values] of classCases) {
    byTaskClass[taskClass] = {
      independentCaseCount: values.length,
      medianQualityDelta: median(values),
    };
  }
  const taskClassRegressions = Object.entries(byTaskClass)
    .filter(([, evidence]) => evidence.medianQualityDelta < 0)
    .map(([taskClass]) => taskClass)
    .sort();

  const armA = completePairs.map((pair) => pair.A);
  const armB = completePairs.map((pair) => pair.B);
  const seededTotalA = sum(armA.map((item) => item.defectMetrics.seededDefectsTotal));
  const seededTotalB = sum(armB.map((item) => item.defectMetrics.seededDefectsTotal));
  const findingsTotalB = sum(armB.map((item) => item.defectMetrics.totalFindings));
  const recallA = seededTotalA === 0 ? null : rate(
    sum(armA.map((item) => item.defectMetrics.seededDefectsFound)),
    seededTotalA,
  );
  const recallB = seededTotalB === 0 ? null : rate(
    sum(armB.map((item) => item.defectMetrics.seededDefectsFound)),
    seededTotalB,
  );
  const findingPrecision = findingsTotalB === 0 ? null : rate(
    sum(armB.map((item) => item.defectMetrics.truePositiveFindings)),
    findingsTotalB,
  );
  const reviewApplicable = isReviewStage(input.observations[0]?.stage);
  const reviewMetricsAvailable = reviewApplicable
    && recallA !== null && recallB !== null && findingPrecision !== null;
  if (reviewApplicable && !reviewMetricsAvailable) reasons.push("review_metrics_unavailable");
  const usageDelta = (
    pair: CompletePair,
    key: keyof PairedObservation["usage"],
  ): number => pair.B.usage[key].value! - pair.A.usage[key].value!;
  const qualityApplicable = !missingPair && !invalidPair
    && qualityByCase.size >= input.requiredIndependentCases;
  const comparisonMetricsAvailable = completePairs.length > 0;
  const metrics: DerivedMetrics = {
    blindEvaluationComplete,
    executionFailureRateDelta: rate(
      armB.filter((item) => item.executionStatus === "failed").length,
      armB.length,
    ) - rate(
      armA.filter((item) => item.executionStatus === "failed").length,
      armA.length,
    ),
    review: reviewApplicable ? {
      seededDefectRecallDelta: recallA === null || recallB === null ? null : recallB - recallA,
      findingPrecision,
    } : null,
    defectEscapeDelta: comparisonMetricsAvailable
      ? clusterMetric(
        completePairs,
        (pair) => pair.B.defectMetrics.escapedDefects - pair.A.defectMetrics.escapedDefects,
      )
      : null,
    secondary: {
      wallTimeDeltaMs: clusterMetric(
        completePairs,
        (pair) => pair.B.wallTimeMs - pair.A.wallTimeMs,
      ),
      tokenDelta: tokenProvenanceComplete
        ? clusterMetric(completePairs, (pair) => usageDelta(pair, "totalTokens"))
        : null,
      costDeltaUsd: costProvenanceComplete
        ? clusterMetric(completePairs, (pair) => usageDelta(pair, "costUsd"))
        : null,
      reworkDelta: null,
    },
    applicability: {
      quality: qualityApplicable ? "applicable" : "unavailable",
      blindEvaluation: completedObservations.length === 0
        ? "not_applicable"
        : blindEvaluationComplete ? "applicable" : "unavailable",
      executionReliability: comparisonMetricsAvailable ? "applicable" : "unavailable",
      review: !reviewApplicable
        ? "not_applicable"
        : reviewMetricsAvailable ? "applicable" : "unavailable",
      defectEscape: comparisonMetricsAvailable ? "applicable" : "unavailable",
      wallTime: comparisonMetricsAvailable ? "applicable" : "unavailable",
      totalTokens: tokenProvenanceComplete ? "applicable" : "unavailable",
      costUsd: costProvenanceComplete ? "applicable" : "unavailable",
      rework: "not_applicable",
    },
  };

  return deepFreeze({
    status: reasons.length === 0 ? "ready" as const : "inconclusive" as const,
    reasons,
    matchedPairCount: completePairs.length,
    independentCaseCount: qualityByCase.size,
    medianQualityDelta: caseDeltas.length === 0 ? null : median(caseDeltas),
    qualityCi95: qualityApplicable
      ? bootstrapMedianInterval(caseDeltas, input.bootstrapSamples, input.seed)
      : null,
    usageProvenanceComplete,
    taskClassRegressions,
    byTaskClass,
    metrics,
  });
};

export interface BenchmarkDecisionInput {
  readonly pairsComplete: boolean;
  readonly hasInvalidPairs?: boolean;
  readonly sampleSufficient: boolean;
  readonly usageProvenanceComplete: boolean;
  readonly blindJudgeResolved: boolean;
  readonly medianQualityDelta: number | null;
  readonly qualityCi95: Readonly<{ lower: number; upper: number }> | null;
  readonly qualityNoninferiorityLower: number | null;
  readonly executionFailureRateDelta: number;
  readonly review: Readonly<{
    seededDefectRecallDelta: number | null;
    findingPrecision: number | null;
  }> | null;
  readonly reviewApplicable?: boolean;
  readonly secondary: Readonly<{
    wallTimeDeltaMs: number;
    tokenDelta: number | null;
    costDeltaUsd: number | null;
    reworkDelta?: number | null;
  }>;
  readonly defectEscapeDelta?: number | null;
  readonly taskClassRegressions?: readonly string[];
}

export type BenchmarkVerdict = "keep_provisional" | "candidate_change" | "inconclusive";
export type DecisionBasis =
  | "quality"
  | "review_quality"
  | "reliability"
  | "task_class_regression"
  | "secondary"
  | "missing_pair"
  | "invalid_pair"
  | "insufficient_sample"
  | "missing_usage_provenance"
  | "blind_evaluation_incomplete"
  | "review_metrics_unavailable";

export interface BenchmarkDecision {
  readonly verdict: BenchmarkVerdict;
  readonly basis: DecisionBasis;
  readonly secondaryWinner?: "candidate" | "provisional" | null;
}

export const decideBenchmark = (input: BenchmarkDecisionInput): BenchmarkDecision => {
  if (input.hasInvalidPairs) return { verdict: "inconclusive", basis: "invalid_pair" };
  if (!input.pairsComplete) return { verdict: "inconclusive", basis: "missing_pair" };
  if (input.executionFailureRateDelta > 0) {
    return { verdict: "keep_provisional", basis: "reliability" };
  }
  if (!input.sampleSufficient) return { verdict: "inconclusive", basis: "insufficient_sample" };
  if (!input.usageProvenanceComplete) {
    return { verdict: "inconclusive", basis: "missing_usage_provenance" };
  }
  if (!input.blindJudgeResolved) {
    return { verdict: "inconclusive", basis: "blind_evaluation_incomplete" };
  }
  if ((input.taskClassRegressions?.length ?? 0) > 0) {
    return { verdict: "keep_provisional", basis: "task_class_regression" };
  }
  if (input.reviewApplicable && (!input.review
    || input.review.seededDefectRecallDelta === null
    || input.review.findingPrecision === null)) {
    return { verdict: "inconclusive", basis: "review_metrics_unavailable" };
  }
  if (input.review && input.review.seededDefectRecallDelta !== null
    && input.review.findingPrecision !== null
    && (input.review.seededDefectRecallDelta < 0
    || input.review.findingPrecision < 0.8
    || (input.defectEscapeDelta ?? 0) > 0)) {
    return { verdict: "keep_provisional", basis: "review_quality" };
  }
  if (input.medianQualityDelta === null || input.qualityCi95 === null
    || input.qualityNoninferiorityLower === null) {
    return { verdict: "inconclusive", basis: "insufficient_sample" };
  }
  if (input.medianQualityDelta >= 5 && input.qualityCi95.lower > 0) {
    return { verdict: "candidate_change", basis: "quality" };
  }
  if (input.qualityNoninferiorityLower < -2) {
    return { verdict: "keep_provisional", basis: "quality", secondaryWinner: null };
  }
  if (input.qualityCi95.lower > 0) {
    return { verdict: "keep_provisional", basis: "quality" };
  }
  const secondaryValues = Object.values(input.secondary)
    .filter((delta): delta is number => delta !== null && delta !== undefined);
  const candidateWinsSecondary = secondaryValues.length > 0
    && secondaryValues.every((delta) => delta <= 0)
    && secondaryValues.some((delta) => delta < 0);
  return candidateWinsSecondary
    ? { verdict: "inconclusive", basis: "secondary", secondaryWinner: "candidate" }
    : { verdict: "inconclusive", basis: "quality" };
};

export const scorePairedBenchmark = (
  input: PairedEvidenceInput,
): Readonly<{ evidence: PairedEvidence; decision: BenchmarkDecision }> => {
  const evidence = computePairedEvidence(input);
  const decision = decideBenchmark({
    pairsComplete: !evidence.reasons.includes("missing_pair"),
    hasInvalidPairs: evidence.reasons.includes("invalid_pair"),
    sampleSufficient: !evidence.reasons.includes("insufficient_sample"),
    usageProvenanceComplete: evidence.usageProvenanceComplete,
    blindJudgeResolved: evidence.metrics.blindEvaluationComplete,
    medianQualityDelta: evidence.medianQualityDelta,
    qualityCi95: evidence.qualityCi95,
    qualityNoninferiorityLower: evidence.qualityCi95?.lower ?? null,
    executionFailureRateDelta: evidence.metrics.executionFailureRateDelta,
    review: evidence.metrics.review,
    reviewApplicable: evidence.metrics.applicability.review !== "not_applicable",
    defectEscapeDelta: evidence.metrics.defectEscapeDelta,
    secondary: evidence.metrics.secondary,
    taskClassRegressions: evidence.taskClassRegressions,
  });
  return deepFreeze({ evidence, decision });
};
