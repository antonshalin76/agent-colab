export interface StageConclusion {
  readonly stage: string;
  readonly verdict: "keep_provisional" | "candidate_change" | "inconclusive";
  readonly owner?: "grok" | "codex";
}

export interface PB08AttemptEvidence {
  readonly opaqueLabel: string;
  readonly exitState: string;
  readonly truncationReason: string | null;
  readonly oracleResultHash: string;
  readonly usageProvenanceHash: string;
  readonly candidateDiffHash: string;
}

export interface PB08CellEvidence {
  readonly blockId: string;
  readonly pairIdentityHash: string;
  readonly immutableInputHash: string;
  readonly launchOrder: readonly ["grok" | "codex", "grok" | "codex"];
  readonly orderReceiptHash: string;
  readonly attempts: readonly PB08AttemptEvidence[];
}

export interface PB08Evidence {
  readonly suiteId: string;
  readonly harnessVersion: string;
  readonly cells: readonly PB08CellEvidence[];
}

export interface BenchmarkReportInput {
  readonly coveredStages: readonly string[];
  readonly stageConclusions: readonly StageConclusion[];
  readonly evidence: PB08Evidence;
}

const hashPattern = /^[a-f0-9]{64}$/;
const terminalExitStates = new Set(["completed", "failed", "invalidated"]);
const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
};
const requireText = (value: string, name: string): void => {
  if (value.length === 0) throw new Error(`PB-08 evidence requires ${name}`);
};
const requireHash = (value: string, name: string): void => {
  if (!hashPattern.test(value)) throw new Error(`PB-08 evidence requires ${name}`);
};

const validateEvidence = (evidence: PB08Evidence): void => {
  requireText(evidence.suiteId, "suiteId");
  requireText(evidence.harnessVersion, "harnessVersion");
  if (!Array.isArray(evidence.cells) || evidence.cells.length === 0) {
    throw new Error("PB-08 evidence requires cells");
  }
  for (const cell of evidence.cells) {
    requireText(cell.blockId, "blockId");
    requireHash(cell.pairIdentityHash, "pairIdentityHash");
    requireHash(cell.immutableInputHash, "immutableInputHash");
    requireHash(cell.orderReceiptHash, "orderReceiptHash");
    if (cell.launchOrder.length !== 2 || cell.launchOrder[0] === cell.launchOrder[1]) {
      throw new Error("PB-08 evidence requires a paired launchOrder");
    }
    if (!Array.isArray(cell.attempts) || cell.attempts.length !== 2) {
      throw new Error("PB-08 evidence requires both paired terminal attempts");
    }
    if (new Set(cell.attempts.map((attempt: PB08AttemptEvidence) => attempt.opaqueLabel)).size !== 2) {
      throw new Error("PB-08 evidence requires two unique opaque labels");
    }
    for (const attempt of cell.attempts) {
      requireText(attempt.opaqueLabel, "opaqueLabel");
      if (!terminalExitStates.has(attempt.exitState)) {
        throw new Error("PB-08 evidence requires a terminal exitState");
      }
      requireHash(attempt.oracleResultHash, "oracleResultHash");
      requireHash(attempt.usageProvenanceHash, "usageProvenanceHash");
      requireHash(attempt.candidateDiffHash, "candidateDiffHash");
      if (attempt.truncationReason !== null && attempt.truncationReason.length === 0) {
        throw new Error("PB-08 truncationReason must be null or non-empty");
      }
    }
  }
};

export const createBenchmarkReport = (input: BenchmarkReportInput) => {
  validateEvidence(input.evidence);
  const covered = new Set(input.coveredStages);
  const stageConclusions: StageConclusion[] = [];
  const refusedConclusions: Array<{ stage: string; reason: "uncovered" }> = [];
  for (const conclusion of input.stageConclusions) {
    if (!covered.has(conclusion.stage)) {
      if (conclusion.owner) {
        throw new Error(`${conclusion.stage} is uncovered; an owner conclusion is forbidden`);
      }
      refusedConclusions.push({ stage: conclusion.stage, reason: "uncovered" });
      continue;
    }
    stageConclusions.push({ ...conclusion });
  }
  return Object.freeze({
    coveredStages: Object.freeze([...input.coveredStages]),
    stageConclusions: Object.freeze(stageConclusions.map((item) => Object.freeze(item))),
    refusedConclusions: Object.freeze(refusedConclusions.map((item) => Object.freeze(item))),
    evidence: deepFreeze(structuredClone(input.evidence)),
  });
};
