import type { ReviewRole } from "../domain/review.js";
import type { ReviewProviderId } from "../domain/routing.js";

export type ReviewEvidenceCaptureEntryPoint =
  | "request_review"
  | "map_admission"
  | "recovery_rejoin"
  | "prelaunch";

export interface ReviewEvidenceCaptureInput {
  entryPoint: ReviewEvidenceCaptureEntryPoint;
  phase: "admission" | "prelaunch";
  project: string;
  agent: ReviewProviderId;
  role: ReviewRole;
}

export interface ReviewSourceObservation {
  [key: string]: unknown;
  sourceFingerprint: string;
  valid: boolean;
}

export interface ReviewReadyObservation {
  [key: string]: unknown;
  harnessReady: boolean;
  state: "ready";
  valid: boolean;
}

export interface ReviewUnavailableObservation {
  [key: string]: unknown;
  harnessReady: boolean;
  state: "provider_unavailable";
  valid: boolean;
}

interface CapturedReviewEvidence {
  agent: ReviewProviderId;
  observedAt: number;
  source: ReviewSourceObservation;
}

export interface ReviewEvidenceReadyOutcome extends CapturedReviewEvidence {
  kind: "ready";
  readiness: ReviewReadyObservation;
}

export interface ReviewEvidenceProviderUnavailableOutcome extends CapturedReviewEvidence {
  kind: "provider_unavailable";
  readiness: ReviewUnavailableObservation;
}

export interface ReviewEvidenceInfrastructureFailureOutcome {
  kind: "infrastructure_failure";
  agent: ReviewProviderId;
  observedAt: number;
  boundary: "source" | "readiness";
  reason: "capture_failed" | "invalid_observation";
  source?: never;
  readiness?: never;
}

export type ReviewEvidenceCaptureOutcome =
  | ReviewEvidenceReadyOutcome
  | ReviewEvidenceProviderUnavailableOutcome
  | ReviewEvidenceInfrastructureFailureOutcome;

export interface ReviewEvidenceCaptureOptions {
  captureSource: (input: ReviewEvidenceCaptureInput) => unknown;
  captureReadiness: (input: ReviewEvidenceCaptureInput) => unknown;
  observedAt?: () => number;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isProvider = (value: unknown): value is ReviewProviderId =>
  value === "grok" || value === "claude" || value === "codex";

const isObservedAt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const sourceObservation = (value: unknown): ReviewSourceObservation | null => {
  const candidate = object(value);
  if (candidate === null || !hasExactKeys(candidate, ["sourceFingerprint", "valid"]) ||
      typeof candidate.sourceFingerprint !== "string" || candidate.sourceFingerprint.length === 0 ||
      candidate.valid !== true) return null;
  return { sourceFingerprint: candidate.sourceFingerprint, valid: true };
};

const readinessObservation = (
  value: unknown,
): ReviewReadyObservation | ReviewUnavailableObservation | null => {
  const candidate = object(value);
  if (candidate === null || !hasExactKeys(candidate, ["harnessReady", "state", "valid"])) return null;
  if (candidate.harnessReady === true && candidate.state === "ready" && candidate.valid === true) {
    return { harnessReady: true, state: "ready", valid: true };
  }
  if (candidate.harnessReady === false && candidate.state === "provider_unavailable" &&
      candidate.valid === false) {
    return { harnessReady: false, state: "provider_unavailable", valid: false };
  }
  return null;
};

const infrastructureFailure = (
  input: ReviewEvidenceCaptureInput,
  observedAt: number,
  boundary: ReviewEvidenceInfrastructureFailureOutcome["boundary"],
  reason: ReviewEvidenceInfrastructureFailureOutcome["reason"],
): ReviewEvidenceInfrastructureFailureOutcome => ({
  kind: "infrastructure_failure",
  agent: input.agent,
  observedAt,
  boundary,
  reason,
});

export const isReviewEvidenceCaptureOutcome = (
  value: unknown,
): value is ReviewEvidenceCaptureOutcome => {
  const candidate = object(value);
  if (candidate === null || !isProvider(candidate.agent) || !isObservedAt(candidate.observedAt)) return false;
  if (candidate.kind === "infrastructure_failure") {
    return hasExactKeys(candidate, ["kind", "agent", "observedAt", "boundary", "reason"]) &&
      (candidate.boundary === "source" || candidate.boundary === "readiness") &&
      (candidate.reason === "capture_failed" || candidate.reason === "invalid_observation");
  }
  if (candidate.kind !== "ready" && candidate.kind !== "provider_unavailable") return false;
  if (!hasExactKeys(candidate, ["kind", "agent", "observedAt", "source", "readiness"]) ||
      sourceObservation(candidate.source) === null) return false;
  const readiness = readinessObservation(candidate.readiness);
  return candidate.kind === "ready"
    ? readiness?.state === "ready"
    : readiness?.state === "provider_unavailable";
};

export class ReviewEvidenceCapture {
  private readonly observedAt: () => number;

  constructor(private readonly options: ReviewEvidenceCaptureOptions) {
    this.observedAt = options.observedAt ?? Date.now;
  }

  capture(input: ReviewEvidenceCaptureInput): ReviewEvidenceCaptureOutcome {
    const observedAt = this.observedAt();
    if (!isObservedAt(observedAt)) throw new Error("review evidence capture timestamp must be a non-negative integer");

    let rawSource: unknown;
    try {
      rawSource = this.options.captureSource(input);
    } catch {
      return infrastructureFailure(input, observedAt, "source", "capture_failed");
    }
    const source = sourceObservation(rawSource);
    if (source === null) return infrastructureFailure(input, observedAt, "source", "invalid_observation");

    let rawReadiness: unknown;
    try {
      rawReadiness = this.options.captureReadiness(input);
    } catch {
      return infrastructureFailure(input, observedAt, "readiness", "capture_failed");
    }
    const readiness = readinessObservation(rawReadiness);
    if (readiness === null) {
      return infrastructureFailure(input, observedAt, "readiness", "invalid_observation");
    }
    return readiness.state === "ready"
      ? { kind: "ready", agent: input.agent, observedAt, source, readiness }
      : { kind: "provider_unavailable", agent: input.agent, observedAt, source, readiness };
  }
}
