import { posix } from "node:path";
import { canonicalJson, computeBytesSha256, computeJsonSha256 } from "../domain/canonical-json.js";
import {
  AMD_0001_ID,
  BASELINE_PLAN_SHA256,
  IMPLEMENTATION_PLAN_ID,
  type ArtifactFact,
  type JsonObject,
  type VerifiedAmendment,
} from "./implementation-amendment.js";

export interface VerifiedProgressEvent {
  readonly event: JsonObject;
  readonly eventJson: string;
  readonly eventSha256: string;
}

export interface ProgressEventVerificationInput {
  readonly existingEvents: readonly JsonObject[];
  readonly candidate: JsonObject;
  readonly eventJson: string;
  readonly artifactFacts: readonly ArtifactFact[];
  readonly startSha256: string;
  readonly baselinePlanSha256: string;
}

export interface ProgressReduction {
  readonly effectivePlanSha256: string;
  readonly invalidatedEventIds: readonly string[];
  readonly eligibleStageIds: readonly string[];
  readonly completedStageIds: readonly string[];
}

export interface ProgressProjection {
  readonly jsonlBytes: Buffer;
  readonly markdownBytes: Buffer;
}

interface OptionalReviewFacts {
  readonly eventId: string;
  readonly eventSha256: string;
  readonly effectivePlanSha256: string;
  readonly consumed: number;
  readonly cap: number;
  readonly delta: number | null;
  readonly knownCostUsd: number | null;
  readonly postStart: {
    readonly launchesConsumed: number;
    readonly launchCap: number;
    readonly costMicroUsdConsumed: number;
    readonly costMicroUsdCap: number;
  } | null;
}

interface ReviewReceiptFact {
  readonly agent: "codex" | "grok" | "claude";
  readonly role: "auditor" | "critic";
  readonly attemptId: string;
  readonly artifactPath: string;
  readonly sha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]+$/;
const STEP_FIELDS = [
  "schemaVersion", "eventId", "sequence", "previousEventSha256", "startSha256", "eventType",
  "planId", "effectivePlanSha256", "stageId", "gateId", "sourceFingerprint", "actor",
  "commandOrOracle", "inputHashes", "outputHashes", "attemptIds", "reviewReceiptHashes",
  "artifactPaths", "terminalResult", "recordedAt", "eventSha256",
] as const;
const ELIGIBLE_FIELDS = [
  "schemaVersion", "eventId", "sequence", "previousEventSha256", "startSha256", "eventType",
  "planId", "effectivePlanSha256", "stageId", "recordedAt", "eventSha256",
] as const;
const BASELINE_STAGES = ["R2-STG-00", "STG-01", "STG-02", "STG-03"] as const;
const POST_AMENDMENT_STAGES = [
  "STG-04", "STG-05", "STG-06", "STG-07", "STG-08",
  "STG-09", "STG-10", "STG-11", "STG-12",
] as const;
const OPTIONAL_AGENTS = ["grok", "claude"] as const;
const REVIEW_ROLES = ["auditor", "critic"] as const;
const OPTIONAL_PROVIDER_FIELDS = ["auditor", "critic", "reason"] as const;
const OPTIONAL_PROVIDERS_FIELDS = ["grok", "claude"] as const;
const LEGACY_OPTIONAL_FIELDS = [
  "schemaVersion", "stageId", "providers", "ambiguousLaunchedAttempts",
  "completedChangesRequested", "certificationLaunchesConsumed", "certificationLaunchCap",
  "knownCostUsd", "costStatus", "recordedAt",
] as const;
const FULL_OPTIONAL_FIELDS = [
  "schemaVersion", "stageId", "providers", "requiredTopology", "blockingPolicy",
  "automaticRejoin", "ambiguousLaunchedAttempts", "completedChangesRequested",
  "certificationLaunchesConsumed", "certificationLaunchCap", "newLaunchesForStage",
  "knownCostUsd", "costStatus", "recordedAt",
] as const;
const POST_START_OPTIONAL_FIELDS = [
  ...FULL_OPTIONAL_FIELDS,
  "postStartLaunchesConsumed", "postStartLaunchCap",
  "postStartCostUsdConsumed", "postStartCostUsdCap",
] as const;
const LEGACY_BARRIER_FIELDS = [
  "schemaVersion", "stageId", "gateId", "sourceFingerprint", "satisfied",
  "requiredCount", "terminalCount", "requiredReceipts",
] as const;
const FULL_BARRIER_FIELDS = [
  ...LEGACY_BARRIER_FIELDS, "optionalLanes", "optionalStatusSha256", "ambiguousLaunchedAttempts",
] as const;
const REQUIRED_TOPOLOGY = Object.freeze({
  codex: Object.freeze(["auditor", "critic"]),
  grok: Object.freeze(["auditor", "critic"]),
  claude: Object.freeze(["auditor", "critic"]),
});
const OPTIONAL_BLOCKING_POLICY = "codex_pair_required_optional_pairs_non_blocking_when_unavailable";
const OPTIONAL_REJOIN_POLICY = "enabled_by_runtime_health_admission_when_capacity_and_provider_health_return";
const ACTIVE_LAUNCH_CAP = 24;
const ACTIVE_COST_CAP_MICRO_USD = 10_000_000;
const LEGACY_NULL_ALLOWLIST = new Set([
  "r2-stg-00-pass@ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7",
  "stg-01-pass@98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97",
]);

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactFields(value: JsonObject, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} fields are not canonical for its event type`);
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} is invalid`);
  return value as number;
}

function usdToMicroUsd(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  const microUsd = value * 1_000_000;
  if (!Number.isSafeInteger(microUsd)) throw new Error(`${label} is not exact to one micro-USD`);
  return microUsd;
}

function isoTimestamp(value: number, label: string): string {
  safeInteger(value, `${label} timestamp`);
  return new Date(value).toISOString();
}

function eventWithHash(value: JsonObject): JsonObject {
  return { ...value, eventSha256: computeJsonSha256(value) };
}

function safeArtifactPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\") ||
      posix.normalize(path) !== path || path === ".." || path.startsWith("../")) {
    throw new Error("progress artifact path escapes its evidence root");
  }
  return path;
}

function artifactInventory(facts: readonly ArtifactFact[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const fact of facts) {
    const path = safeArtifactPath(fact.path);
    if (result.has(path) || !Buffer.isBuffer(fact.bytes)) throw new Error("progress artifact inventory is duplicated or invalid");
    result.set(path, fact.bytes);
  }
  return result;
}

function parseArtifact(inventory: Map<string, Buffer>, path: string, label: string): JsonObject {
  const bytes = inventory.get(path);
  if (!bytes) throw new Error(`${label} artifact is missing: ${path}`);
  try { return record(JSON.parse(bytes.toString("utf8")), label); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} artifact is not valid JSON: ${path}`);
    throw error;
  }
}

function hashReferences(
  event: JsonObject,
  field: "inputHashes" | "outputHashes",
  inventory: Map<string, Buffer>,
): Array<{ path: string; sha256: string }> {
  const value = event[field];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be nonempty for PASS evidence`);
  const seen = new Set<string>();
  return value.map((entryValue) => {
    const entry = record(entryValue, field);
    exactFields(entry, ["path", "sha256"], field);
    const path = safeArtifactPath(entry.path);
    const sha256 = String(entry.sha256);
    const bytes = inventory.get(path);
    if (seen.has(path) || !SHA256.test(sha256) || !bytes || computeBytesSha256(bytes) !== sha256) {
      throw new Error(`${field} artifact digest mismatch: ${path}`);
    }
    seen.add(path);
    return { path, sha256 };
  });
}

function validateOptionalReview(
  event: JsonObject,
  optional: JsonObject,
  optionalBytesSha256: string,
  barrier: JsonObject,
  oracle: JsonObject,
  receipts: ReadonlyMap<string, ReviewReceiptFact>,
): OptionalReviewFacts {
  const identity = `${String(event.eventId)}@${String(event.eventSha256)}`;
  const isLegacyNull = LEGACY_NULL_ALLOWLIST.has(identity);
  const postAmendment = event.effectivePlanSha256 !== BASELINE_PLAN_SHA256;
  exactFields(
    optional,
    postAmendment ? POST_START_OPTIONAL_FIELDS : isLegacyNull ? LEGACY_OPTIONAL_FIELDS : FULL_OPTIONAL_FIELDS,
    "optional review status",
  );
  if (optional.schemaVersion !== "optional-review-status/v1" || optional.stageId !== event.stageId ||
      optional.recordedAt !== event.recordedAt) {
    throw new Error("optional review status does not match the progress event");
  }
  const providers = record(optional.providers, "optional providers");
  exactFields(providers, OPTIONAL_PROVIDERS_FIELDS, "optional providers");
  const laneStatus = new Map<string, string>();
  for (const agent of OPTIONAL_AGENTS) {
    const provider = record(providers[agent], `optional ${agent} provider`);
    exactFields(provider, OPTIONAL_PROVIDER_FIELDS, `optional ${agent} provider`);
    if (typeof provider.reason !== "string" || provider.reason.length === 0) {
      throw new Error(`optional ${agent} provider reason is invalid`);
    }
    for (const role of REVIEW_ROLES) {
      const status = provider[role];
      if (status !== "optional_unavailable" && status !== "PASS") {
        throw new Error(`optional ${agent} ${role} has a blocking changes_requested or ambiguous result`);
      }
      laneStatus.set(`${agent}:${role}`, status);
    }
  }
  if (safeInteger(optional.ambiguousLaunchedAttempts, "optional ambiguous launched attempts") !== 0 ||
      safeInteger(optional.completedChangesRequested, "optional changes_requested count") !== 0) {
    throw new Error("optional review status contains a blocking launched attempt");
  }
  const cap = safeInteger(optional.certificationLaunchCap, "historical launch cap");
  const consumed = safeInteger(optional.certificationLaunchesConsumed, "historical launch counter");
  if (cap !== 40 || consumed > cap) throw new Error("historical certification launch cap or counter overflow");
  const delta = optional.newLaunchesForStage === undefined
    ? null
    : safeInteger(optional.newLaunchesForStage, "stage launch delta");
  const knownCostUsd = optional.knownCostUsd === null
    ? null
    : (usdToMicroUsd(optional.knownCostUsd, "optional known launch cost"), optional.knownCostUsd as number);
  if (delta !== null && delta > 0 && knownCostUsd === null) {
    throw new Error("a positive optional launch delta requires known cost");
  }
  if (delta === 0 && knownCostUsd !== null && knownCostUsd !== 0) {
    throw new Error("optional launch cost without a launch delta is invalid");
  }

  if (!isLegacyNull) {
    const topology = record(optional.requiredTopology, "optional required topology");
    exactFields(topology, ["codex", "grok", "claude"], "optional required topology");
    if (canonicalJson(topology) !== canonicalJson(REQUIRED_TOPOLOGY) ||
        optional.blockingPolicy !== OPTIONAL_BLOCKING_POLICY ||
        optional.automaticRejoin !== OPTIONAL_REJOIN_POLICY) {
      throw new Error("optional review topology or policy is not exact");
    }
  }

  let postStart: OptionalReviewFacts["postStart"] = null;
  if (postAmendment) {
    if (consumed !== 40 || cap !== 40 || delta === null ||
        optional.postStartLaunchCap !== ACTIVE_LAUNCH_CAP ||
        usdToMicroUsd(optional.postStartCostUsdCap, "post-start cost cap") !== ACTIVE_COST_CAP_MICRO_USD) {
      throw new Error("post-start authority must remain separate from the historical 40/40 receipt");
    }
    if (knownCostUsd !== null && optional.costStatus !== "known_final") {
      throw new Error("known post-start launch cost requires known_final status");
    }
    if (knownCostUsd === null && (delta !== 0 || optional.costStatus !== "not_applicable_no_launch")) {
      throw new Error("unknown post-start cost is valid only when no launch occurred");
    }
    const launchesConsumed = safeInteger(optional.postStartLaunchesConsumed, "post-start launch counter");
    const costMicroUsdConsumed = usdToMicroUsd(optional.postStartCostUsdConsumed, "post-start cumulative cost");
    if (launchesConsumed > ACTIVE_LAUNCH_CAP || costMicroUsdConsumed > ACTIVE_COST_CAP_MICRO_USD) {
      throw new Error("post-start launch or cost authority cap exceeded");
    }
    postStart = Object.freeze({
      launchesConsumed,
      launchCap: ACTIVE_LAUNCH_CAP,
      costMicroUsdConsumed,
      costMicroUsdCap: ACTIVE_COST_CAP_MICRO_USD,
    });
  }

  if (isLegacyNull) {
    exactFields(barrier, LEGACY_BARRIER_FIELDS, "legacy review barrier");
  } else {
    exactFields(barrier, FULL_BARRIER_FIELDS, "review barrier");
    if (barrier.optionalStatusSha256 !== optionalBytesSha256 || barrier.ambiguousLaunchedAttempts !== 0 ||
        !Array.isArray(barrier.optionalLanes) || barrier.optionalLanes.length !== 4) {
      throw new Error("optional review barrier digest or lane inventory mismatch");
    }
    const seen = new Set<string>();
    for (const laneValue of barrier.optionalLanes) {
      const lane = record(laneValue, "optional barrier lane");
      exactFields(lane, ["agent", "role", "status"], "optional barrier lane");
      const key = `${String(lane.agent)}:${String(lane.role)}`;
      if (!laneStatus.has(key) || seen.has(key) || laneStatus.get(key) !== lane.status) {
        throw new Error("optional review barrier lanes are not unique and exhaustive");
      }
      seen.add(key);
      const receipt = receipts.get(key);
      if (lane.status === "PASS" && !receipt) {
        throw new Error(`optional PASS lane ${key} has no exact source-bound receipt`);
      }
      if (lane.status === "optional_unavailable" && receipt) {
        throw new Error(`optional unavailable lane ${key} contains a synthetic receipt`);
      }
    }
    if (seen.size !== laneStatus.size) throw new Error("optional review barrier lanes are not exhaustive");
  }

  const checks = record(oracle.checks, "terminal oracle checks");
  const roleKey = (agent: string, role: string): string => `${agent}${role[0]!.toUpperCase()}${role.slice(1)}`;
  const reviewCheckKeys = Object.keys(checks).filter((key) => key.endsWith("Auditor") || key.endsWith("Critic"));
  if (isLegacyNull) {
    if (checks.optionalProviders !== "explicit_non_blocking_unavailable" ||
        canonicalJson(reviewCheckKeys.sort()) !== canonicalJson(["codexAuditor", "codexCritic"])) {
      throw new Error("legacy terminal oracle optional status is not exact");
    }
  } else {
    const expectedReviewCheckKeys = ["codexAuditor", "codexCritic", ...[...laneStatus.keys()].map((key) => {
      const [agent, role] = key.split(":") as [string, string];
      return roleKey(agent, role);
    })].sort();
    if (canonicalJson(reviewCheckKeys.sort()) !== canonicalJson(expectedReviewCheckKeys)) {
      throw new Error("terminal oracle optional lane inventory is not exact");
    }
    for (const [key, status] of laneStatus) {
      const [agent, role] = key.split(":") as [string, string];
      if (checks[roleKey(agent, role)] !== status) throw new Error("terminal oracle optional status mismatch");
    }
  }
  if (checks.ambiguousAttempts !== 0) throw new Error("terminal oracle contains an ambiguous optional attempt");
  return {
    eventId: String(event.eventId),
    eventSha256: String(event.eventSha256),
    effectivePlanSha256: String(event.effectivePlanSha256),
    consumed,
    cap,
    delta,
    knownCostUsd,
    postStart,
  };
}

function validatePassEvidence(
  event: JsonObject,
  inventory: Map<string, Buffer>,
): OptionalReviewFacts {
  if (!SHA256.test(String(event.sourceFingerprint))) throw new Error("progress source fingerprint is invalid");
  const inputs = hashReferences(event, "inputHashes", inventory);
  const outputs = hashReferences(event, "outputHashes", inventory);
  if (!inputs.some(({ sha256 }) => sha256 === event.sourceFingerprint)) {
    throw new Error("progress source manifest does not bind the source fingerprint");
  }
  if (!Array.isArray(event.attemptIds) || event.attemptIds.length < 2 || event.attemptIds.length > 6 ||
      event.attemptIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(event.attemptIds).size !== event.attemptIds.length ||
      !Array.isArray(event.reviewReceiptHashes) || event.reviewReceiptHashes.length !== event.attemptIds.length) {
    throw new Error("PASS progress event requires exact review receipt attempts");
  }
  const receipts = new Map<string, ReviewReceiptFact>();
  for (const referenceValue of event.reviewReceiptHashes) {
    const reference = record(referenceValue, "review receipt reference");
    exactFields(reference, ["agent", "role", "attemptId", "artifactPath", "sha256"], "review receipt reference");
    const agent = String(reference.agent);
    const role = String(reference.role);
    const key = `${agent}:${role}`;
    const path = safeArtifactPath(reference.artifactPath);
    const bytes = inventory.get(path);
    if ((agent !== "codex" && agent !== "grok" && agent !== "claude") ||
        (role !== "auditor" && role !== "critic") || receipts.has(key) ||
        typeof reference.attemptId !== "string" || !reference.attemptId || !SHA256.test(String(reference.sha256)) ||
        !bytes || computeBytesSha256(bytes) !== reference.sha256) {
      throw new Error("review receipt reference provider, role, identity or digest is invalid");
    }
    const receipt = parseArtifact(inventory, path, "review receipt");
    const receiptFields = receipt.reviewerTask === undefined
      ? ["schemaVersion", "agent", "role", "attemptId", "sourceFingerprint", "reviewVerdict"]
      : ["schemaVersion", "agent", "role", "attemptId", "reviewerTask", "sourceFingerprint", "reviewVerdict"];
    exactFields(receipt, receiptFields, "review receipt");
    if (agent !== "codex" && (typeof receipt.reviewerTask !== "string" || receipt.reviewerTask.length === 0)) {
      throw new Error("optional PASS receipt requires an exact reviewer task identity");
    }
    const verdict = record(receipt.reviewVerdict, "review verdict");
    exactFields(verdict, ["schemaVersion", "verdict", "findings"], "review verdict");
    if (receipt.schemaVersion !== "review-receipt/v1" || receipt.agent !== agent || receipt.role !== role ||
        receipt.attemptId !== reference.attemptId || receipt.sourceFingerprint !== event.sourceFingerprint ||
        verdict.schemaVersion !== "review-verdict/v1" || verdict.verdict !== "PASS" ||
        !Array.isArray(verdict.findings) || verdict.findings.some((finding) => {
          const value = record(finding, "review finding");
          exactFields(value, ["risk_level", "message"], "review finding");
          return value.risk_level !== "info" || typeof value.message !== "string" || value.message.length === 0;
        })) {
      throw new Error(`${agent} ${role} receipt is not an exact semantic PASS or source-bound`);
    }
    receipts.set(key, {
      agent,
      role,
      attemptId: reference.attemptId,
      artifactPath: path,
      sha256: String(reference.sha256),
    } as ReviewReceiptFact);
  }
  if (!receipts.has("codex:auditor") || !receipts.has("codex:critic") ||
      canonicalJson([...event.attemptIds].sort()) !== canonicalJson([...receipts.values()].map(({ attemptId }) => attemptId).sort())) {
    throw new Error("Codex auditor and critic receipt attempts do not match the progress event");
  }

  const oracleRef = record(event.commandOrOracle, "terminal oracle reference");
  exactFields(oracleRef, ["kind", "artifactPath", "sha256"], "terminal oracle reference");
  const oraclePath = safeArtifactPath(oracleRef.artifactPath);
  const oracleBytes = inventory.get(oraclePath);
  if (oracleRef.kind !== "oracle" || !SHA256.test(String(oracleRef.sha256)) || !oracleBytes ||
      computeBytesSha256(oracleBytes) !== oracleRef.sha256) throw new Error("terminal oracle digest mismatch");
  const oracle = parseArtifact(inventory, oraclePath, "terminal oracle");
  if (oracle.schemaVersion !== "terminal-oracle/v1" || oracle.stageId !== event.stageId ||
      oracle.gateId !== event.gateId || oracle.sourceFingerprint !== event.sourceFingerprint ||
      oracle.terminalResult !== "PASS") throw new Error("terminal oracle does not match the PASS event");
  if (!outputs.some(({ path, sha256 }) => path === oraclePath && sha256 === oracleRef.sha256)) {
    throw new Error("terminal oracle is not bound as output evidence");
  }

  const parsedOutputs = outputs.map((reference) => ({
    ...reference,
    value: parseArtifact(inventory, reference.path, "output evidence"),
  }));
  const declaredReceiptPaths = new Set([...receipts.values()].map(({ artifactPath }) => artifactPath));
  for (const reference of [...inputs, ...outputs]) {
    const bytes = inventory.get(reference.path)!;
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { continue; }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
        (parsed as JsonObject).schemaVersion === "review-receipt/v1" &&
        !declaredReceiptPaths.has(reference.path)) {
      throw new Error("review receipt artifact is not declared by an exact receipt reference");
    }
  }
  const barriers = parsedOutputs.filter(({ value }) => value.schemaVersion === "review-barrier-evidence/v1");
  const optionalStatuses = parsedOutputs.filter(({ value }) => value.schemaVersion === "optional-review-status/v1");
  if (barriers.length !== 1 || optionalStatuses.length !== 1) {
    throw new Error("PASS evidence requires exactly one barrier and optional review status");
  }
  const barrier = barriers[0]!.value;
  if (barrier.stageId !== event.stageId || barrier.gateId !== event.gateId ||
      barrier.sourceFingerprint !== event.sourceFingerprint || barrier.satisfied !== true ||
      barrier.requiredCount !== 2 || barrier.terminalCount !== 2 ||
      !Array.isArray(barrier.requiredReceipts) || barrier.requiredReceipts.length !== 2) {
    throw new Error("review barrier does not prove exact PASS closure");
  }
  const barrierRoles = new Set<string>();
  for (const requiredValue of barrier.requiredReceipts) {
    const required = record(requiredValue, "barrier receipt");
    exactFields(required, ["agent", "role", "attemptId", "receiptSha256"], "barrier receipt");
    const role = String(required.role);
    const receipt = receipts.get(`codex:${role}`);
    if (required.agent !== "codex" || !receipt || barrierRoles.has(role) ||
        required.attemptId !== receipt.attemptId || required.receiptSha256 !== receipt.sha256) {
      throw new Error("review barrier receipt binding mismatch");
    }
    barrierRoles.add(role);
  }
  if (!barrierRoles.has("auditor") || !barrierRoles.has("critic")) {
    throw new Error("review barrier does not bind Codex auditor and critic");
  }
  const referenced = new Set([
    ...inputs.map(({ path }) => path),
    ...outputs.map(({ path }) => path),
    ...[...receipts.values()].map(({ artifactPath }) => artifactPath),
  ]);
  if (!Array.isArray(event.artifactPaths) || event.artifactPaths.some((path) => typeof path !== "string") ||
      new Set(event.artifactPaths).size !== event.artifactPaths.length ||
      canonicalJson([...event.artifactPaths].sort()) !== canonicalJson([...referenced].sort())) {
    throw new Error("progress artifactPaths do not exactly match hashed PASS evidence");
  }
  return validateOptionalReview(
    event,
    optionalStatuses[0]!.value,
    optionalStatuses[0]!.sha256,
    barrier,
    oracle,
    receipts,
  );
}

function validateEventStructure(
  event: JsonObject,
  sequence: number,
  previousEventSha256: string,
  startSha256: string,
  effectivePlanSha256: string,
): void {
  if (event.schemaVersion !== "PlanProgressEvent/v1" || event.planId !== IMPLEMENTATION_PLAN_ID ||
      typeof event.eventId !== "string" || !EVENT_ID.test(event.eventId) ||
      event.sequence !== sequence || event.startSha256 !== startSha256 ||
      event.previousEventSha256 !== previousEventSha256 || !SHA256.test(String(event.eventSha256))) {
    throw new Error("progress ledger identity, sequence, root or predecessor chain is invalid");
  }
  const withoutDigest = structuredClone(event);
  delete withoutDigest.eventSha256;
  if (computeJsonSha256(withoutDigest) !== event.eventSha256) throw new Error("progress event canonical hash mismatch");
  const recordedAt = Date.parse(String(event.recordedAt));
  if (!Number.isSafeInteger(recordedAt)) throw new Error("progress event time is invalid");
  const baselineStage = BASELINE_STAGES[sequence - 1];
  if (baselineStage && (event.eventType !== "step_completed" ||
      event.stageId !== baselineStage || event.gateId !== baselineStage)) {
    throw new Error("progress stage or gate is outside the immutable baseline plan order");
  }
  if (event.eventType === "step_completed") {
    if (event.effectivePlanSha256 !== effectivePlanSha256 || event.terminalResult !== "PASS") {
      throw new Error("completed progress event uses a stale effective plan epoch or non-PASS result");
    }
    if (event.actor !== "codex:/root") throw new Error("completed progress event actor is not the Codex stage owner");
    exactFields(event, STEP_FIELDS, "completed progress event");
  } else if (event.eventType === "step_eligible") {
    exactFields(event, ELIGIBLE_FIELDS, "eligible progress event");
    if (event.effectivePlanSha256 !== effectivePlanSha256 || typeof event.stageId !== "string") {
      throw new Error("eligible progress event uses a stale effective plan epoch");
    }
  } else if (event.eventType !== "amendment_accepted") {
    throw new Error("progress ledger event type is unsupported");
  }
}

function validateHistoricalLaunchFacts(facts: readonly OptionalReviewFacts[]): {
  readonly recordedCap: number;
  readonly consumed: number;
  readonly legacyNullDerivedZero: readonly string[];
} {
  let previousConsumed: number | undefined;
  const legacy: string[] = [];
  for (const fact of facts) {
    const identity = `${fact.eventId}@${fact.eventSha256}`;
    if (fact.effectivePlanSha256 !== BASELINE_PLAN_SHA256 || fact.postStart !== null ||
        fact.cap !== 40 || fact.consumed > 40) {
      throw new Error("historical launch facts are mixed with post-start authority or cap drift");
    }
    if (fact.delta === null) {
      if (!LEGACY_NULL_ALLOWLIST.has(identity)) throw new Error("null stage launch delta is outside the legacy allowlist");
      legacy.push(identity);
    }
    if (previousConsumed !== undefined) {
      const delta = fact.delta ?? 0;
      if (fact.consumed !== previousConsumed + delta) throw new Error("historical launch counter rollback or delta mismatch");
    }
    previousConsumed = fact.consumed;
  }
  if (facts.length > 0 && (facts[0]!.cap !== 40 || previousConsumed !== 40)) {
    throw new Error("historical certification launch accounting is not the accepted 40/40 receipt");
  }
  return { recordedCap: 40, consumed: 40, legacyNullDerivedZero: legacy };
}

function validatePostStartLaunchFacts(facts: readonly OptionalReviewFacts[]): {
  readonly cap: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly costCapUsd: number;
  readonly costConsumedUsd: number;
  readonly costRemainingUsd: number;
} {
  let launchesConsumed = 0;
  let costMicroUsdConsumed = 0;
  for (const fact of facts) {
    if (fact.effectivePlanSha256 === BASELINE_PLAN_SHA256 || fact.postStart === null || fact.delta === null ||
        fact.cap !== 40 || fact.consumed !== 40) {
      throw new Error("post-start launch evidence is not separated from the historical 40/40 receipt");
    }
    const stageCostMicroUsd = fact.knownCostUsd === null
      ? 0
      : usdToMicroUsd(fact.knownCostUsd, "post-start stage cost");
    launchesConsumed += fact.delta;
    costMicroUsdConsumed += stageCostMicroUsd;
    if (fact.postStart.launchCap !== ACTIVE_LAUNCH_CAP ||
        fact.postStart.costMicroUsdCap !== ACTIVE_COST_CAP_MICRO_USD ||
        fact.postStart.launchesConsumed !== launchesConsumed ||
        fact.postStart.costMicroUsdConsumed !== costMicroUsdConsumed) {
      throw new Error("post-start cumulative launch or cost counter rollback, delta mismatch, or cap drift");
    }
    if (launchesConsumed > ACTIVE_LAUNCH_CAP || costMicroUsdConsumed > ACTIVE_COST_CAP_MICRO_USD) {
      throw new Error("post-start live provider launch or USD cost authority exceeded");
    }
  }
  return Object.freeze({
    cap: ACTIVE_LAUNCH_CAP,
    consumed: launchesConsumed,
    remaining: ACTIVE_LAUNCH_CAP - launchesConsumed,
    costCapUsd: ACTIVE_COST_CAP_MICRO_USD / 1_000_000,
    costConsumedUsd: costMicroUsdConsumed / 1_000_000,
    costRemainingUsd: (ACTIVE_COST_CAP_MICRO_USD - costMicroUsdConsumed) / 1_000_000,
  });
}

function reduce(
  events: readonly JsonObject[],
  startSha256: string,
  baselinePlanSha256: string,
  inventory?: Map<string, Buffer>,
  allowPendingEligibility = false,
): ProgressReduction & { historical: ReturnType<typeof validateHistoricalLaunchFacts> } {
  if (!SHA256.test(startSha256) || baselinePlanSha256 !== BASELINE_PLAN_SHA256) {
    throw new Error("progress ledger start or baseline plan root is invalid");
  }
  let previous = startSha256;
  let effective: string = baselinePlanSha256;
  let previousRecordedAt = -1;
  const completed = new Map<string, { eventId: string; sequence: number; epoch: string }>();
  const eligible = new Set<string>();
  const invalidated = new Set<string>();
  const optionalFacts: OptionalReviewFacts[] = [];
  let amdAccepted = false;
  let postAmendmentStageIndex = 0;
  let expectedPostAmendmentEvent: "eligibility" | "completion" | "terminal" | null = null;
  for (const [index, source] of events.entries()) {
    const event = record(source, "progress event");
    const sequence = index + 1;
    validateEventStructure(event, sequence, previous, startSha256, effective);
    const recordedAt = Date.parse(String(event.recordedAt));
    if (recordedAt <= previousRecordedAt) throw new Error("progress event chronology is not strictly increasing");
    previousRecordedAt = recordedAt;
    if (sequence > BASELINE_STAGES.length && effective === BASELINE_PLAN_SHA256 &&
        event.eventType !== "amendment_accepted") {
      throw new Error("the only legal transition after STG-03 is exact AMD-0001 acceptance");
    }
    if (event.eventType === "step_completed") {
      if (inventory) optionalFacts.push(validatePassEvidence(event, inventory));
      const stageId = String(event.stageId);
      if (completed.has(stageId)) throw new Error(`duplicate completion for ${stageId} is not permitted`);
      if (amdAccepted) {
        const expectedStage = POST_AMENDMENT_STAGES[postAmendmentStageIndex];
        if (expectedPostAmendmentEvent !== "completion" || stageId !== expectedStage ||
            event.gateId !== expectedStage || !eligible.has(stageId)) {
          throw new Error(`post-amendment completion ${stageId} is not currently eligible or in immutable order`);
        }
      }
      completed.set(stageId, { eventId: String(event.eventId), sequence, epoch: String(event.effectivePlanSha256) });
      eligible.delete(stageId);
      if (amdAccepted) {
        if (postAmendmentStageIndex === POST_AMENDMENT_STAGES.length - 1) {
          expectedPostAmendmentEvent = "terminal";
        } else {
          postAmendmentStageIndex += 1;
          expectedPostAmendmentEvent = "eligibility";
        }
      }
    } else if (event.eventType === "amendment_accepted") {
      if (amdAccepted) throw new Error("duplicate post-amendment authority transition is not permitted");
      if (event.previousEffectivePlanSha256 !== effective || !SHA256.test(String(event.effectivePlanSha256)) ||
          event.effectivePlanSha256 === effective || !Array.isArray(event.invalidatedEventIds) ||
          event.invalidatedEventIds.some((id) => typeof id !== "string" || !id)) {
        throw new Error("amendment accepted event has an invalid epoch or invalidation set");
      }
      const explicit = new Set(event.invalidatedEventIds as string[]);
      const invalidatedSequences = [...completed.values()].filter(({ eventId }) => explicit.has(eventId)).map(({ sequence: value }) => value);
      if (explicit.size > 0 && invalidatedSequences.length !== explicit.size) {
        throw new Error("amendment invalidation references an unknown completed event");
      }
      if (invalidatedSequences.length > 0) {
        const first = Math.min(...invalidatedSequences);
        for (const [stageId, completion] of completed) {
          if (completion.sequence >= first && completion.epoch === effective) {
            invalidated.add(completion.eventId);
            completed.delete(stageId);
          }
        }
      }
      effective = String(event.effectivePlanSha256);
      if (event.amendmentId === AMD_0001_ID) {
        if (sequence !== 5 || BASELINE_STAGES.some((stageId) => !completed.has(stageId)) || eligible.size !== 0) {
          throw new Error("AMD-0001 is outside its exact STG-03 predecessor transition");
        }
        amdAccepted = true;
        postAmendmentStageIndex = 0;
        expectedPostAmendmentEvent = "eligibility";
      }
    } else {
      const stageId = String(event.stageId);
      if (eligible.has(stageId) || completed.has(stageId)) {
        throw new Error(`duplicate or completed eligibility for ${stageId} is not permitted`);
      }
      if (amdAccepted) {
        const expectedStage = POST_AMENDMENT_STAGES[postAmendmentStageIndex];
        if (expectedPostAmendmentEvent !== "eligibility" || stageId !== expectedStage) {
          throw new Error(`post-amendment eligibility ${stageId} is outside immutable stage order`);
        }
        expectedPostAmendmentEvent = "completion";
      }
      eligible.add(stageId);
    }
    previous = String(event.eventSha256);
  }
  if (amdAccepted && expectedPostAmendmentEvent === "eligibility" && !allowPendingEligibility) {
    throw new Error("post-amendment completion is missing its atomically derived next-stage eligibility");
  }
  return {
    effectivePlanSha256: effective,
    invalidatedEventIds: [...invalidated],
    eligibleStageIds: [...eligible],
    completedStageIds: [...completed.keys()],
    historical: validateHistoricalLaunchFacts(
      optionalFacts.filter(({ effectivePlanSha256 }) => effectivePlanSha256 === BASELINE_PLAN_SHA256),
    ),
  };
}

export function verifyProgressEvent(input: ProgressEventVerificationInput): VerifiedProgressEvent {
  reduce(input.existingEvents, input.startSha256, input.baselinePlanSha256, undefined, true);
  const candidate = record(input.candidate, "candidate progress event");
  if (input.eventJson !== canonicalJson(candidate)) throw new Error("candidate progress event JSON is not canonical");
  reduce([...input.existingEvents, candidate], input.startSha256, input.baselinePlanSha256, undefined, true);
  if (candidate.eventType === "step_completed") validatePassEvidence(candidate, artifactInventory(input.artifactFacts));
  return Object.freeze({
    event: structuredClone(candidate),
    eventJson: input.eventJson,
    eventSha256: String(candidate.eventSha256),
  });
}

export function reduceImplementationProgress(input: {
  readonly events: readonly JsonObject[];
  readonly startSha256: string;
  readonly baselinePlanSha256: string;
  readonly artifactFacts: readonly ArtifactFact[];
}): ProgressReduction {
  const reduced = reduce(input.events, input.startSha256, input.baselinePlanSha256, artifactInventory(input.artifactFacts));
  return Object.freeze({
    effectivePlanSha256: reduced.effectivePlanSha256,
    invalidatedEventIds: Object.freeze([...reduced.invalidatedEventIds]),
    eligibleStageIds: Object.freeze([...reduced.eligibleStageIds]),
    completedStageIds: Object.freeze([...reduced.completedStageIds]),
  });
}

export function verifyHistoricalLaunchAccounting(input: {
  readonly events: readonly JsonObject[];
  readonly artifactFacts: readonly ArtifactFact[];
}): ReturnType<typeof validateHistoricalLaunchFacts> {
  const inventory = artifactInventory(input.artifactFacts);
  const facts = input.events.filter((event) => event.eventType === "step_completed")
    .map((event) => validatePassEvidence(event, inventory))
    .filter(({ effectivePlanSha256 }) => effectivePlanSha256 === BASELINE_PLAN_SHA256);
  return validateHistoricalLaunchFacts(facts);
}

export function verifyLiveProviderLaunchAccounting(input: {
  readonly implementationStart: JsonObject;
  readonly events: readonly JsonObject[];
  readonly artifactFacts: readonly ArtifactFact[];
}): {
  readonly historical: {
    readonly recordedCap: number;
    readonly consumed: number;
    readonly legacyNullDerivedZero: readonly string[];
  };
  readonly postStart: ReturnType<typeof validatePostStartLaunchFacts>;
} {
  if (input.implementationStart.liveProviderScope !== "max_24_launches_usd_10") {
    throw new Error("implementation start authority requires active post-start cap 24 and USD 10");
  }
  const inventory = artifactInventory(input.artifactFacts);
  const facts = input.events.filter((event) => event.eventType === "step_completed")
    .map((event) => validatePassEvidence(event, inventory));
  const historical = validateHistoricalLaunchFacts(
    facts.filter(({ effectivePlanSha256 }) => effectivePlanSha256 === BASELINE_PLAN_SHA256),
  );
  const postStart = validatePostStartLaunchFacts(
    facts.filter(({ effectivePlanSha256 }) => effectivePlanSha256 !== BASELINE_PLAN_SHA256),
  );
  return Object.freeze({
    historical: Object.freeze({ ...historical, legacyNullDerivedZero: Object.freeze([...historical.legacyNullDerivedZero]) }),
    postStart,
  });
}

export function buildNextStageEligibilityEvent(completionValue: JsonObject): JsonObject | null {
  const completion = record(completionValue, "stage completion");
  if (completion.eventType !== "step_completed" || completion.terminalResult !== "PASS") {
    throw new Error("next-stage eligibility requires a PASS completion event");
  }
  const stageIndex = POST_AMENDMENT_STAGES.indexOf(String(completion.stageId) as typeof POST_AMENDMENT_STAGES[number]);
  if (stageIndex < 0) throw new Error("completion stage is outside the post-amendment immutable plan");
  if (stageIndex === POST_AMENDMENT_STAGES.length - 1) return null;
  const nextStage = POST_AMENDMENT_STAGES[stageIndex + 1]!;
  const recordedAt = Date.parse(String(completion.recordedAt));
  if (!Number.isSafeInteger(recordedAt)) throw new Error("completion time is invalid for next-stage eligibility");
  return eventWithHash({
    schemaVersion: "PlanProgressEvent/v1",
    eventId: `${nextStage.toLowerCase()}-eligible-after-${String(completion.eventId)}`,
    sequence: safeInteger(completion.sequence, "completion sequence") + 1,
    previousEventSha256: completion.eventSha256,
    startSha256: completion.startSha256,
    eventType: "step_eligible",
    planId: IMPLEMENTATION_PLAN_ID,
    effectivePlanSha256: completion.effectivePlanSha256,
    stageId: nextStage,
    recordedAt: isoTimestamp(recordedAt + 1, "next-stage eligibility"),
  });
}

export interface AmendmentAcceptanceEvents {
  readonly acceptance: JsonObject;
  readonly eligibility: JsonObject;
}

export function buildAmendmentAcceptanceEvents(input: {
  readonly verifiedAmendment: VerifiedAmendment;
  readonly acceptedAt: number;
  readonly predecessor: JsonObject;
}): AmendmentAcceptanceEvents {
  const predecessor = record(input.predecessor, "AMD-0001 predecessor");
  if (predecessor.eventId !== "stg-03-pass" || predecessor.sequence !== 4 ||
      predecessor.planId !== IMPLEMENTATION_PLAN_ID ||
      predecessor.effectivePlanSha256 !== BASELINE_PLAN_SHA256 ||
      !SHA256.test(String(predecessor.eventSha256)) || !SHA256.test(String(predecessor.startSha256))) {
    throw new Error("AMD-0001 predecessor chain or effective plan epoch is invalid");
  }
  const acceptance = eventWithHash({
    schemaVersion: "PlanProgressEvent/v1",
    eventId: "amd-0001-accepted",
    sequence: 5,
    previousEventSha256: predecessor.eventSha256,
    startSha256: predecessor.startSha256,
    eventType: "amendment_accepted",
    planId: IMPLEMENTATION_PLAN_ID,
    effectivePlanSha256: input.verifiedAmendment.effectivePlanSha256,
    previousEffectivePlanSha256: BASELINE_PLAN_SHA256,
    amendmentId: AMD_0001_ID,
    ordinal: 1,
    amendmentSha256: input.verifiedAmendment.amendmentSha256,
    authorityReceiptSha256: input.verifiedAmendment.authorityReceiptSha256,
    authorityReceipt: structuredClone(input.verifiedAmendment.authorityReceipt),
    invalidatedEventIds: structuredClone(input.verifiedAmendment.amendment.invalidatedEventIds),
    recordedAt: isoTimestamp(input.acceptedAt, "amendment acceptance"),
  });
  const eligibility = eventWithHash({
    schemaVersion: "PlanProgressEvent/v1",
    eventId: "amd-0001-stg-04-eligible",
    sequence: 6,
    previousEventSha256: acceptance.eventSha256,
    startSha256: acceptance.startSha256,
    eventType: "step_eligible",
    planId: IMPLEMENTATION_PLAN_ID,
    effectivePlanSha256: input.verifiedAmendment.effectivePlanSha256,
    stageId: "STG-04",
    recordedAt: isoTimestamp(input.acceptedAt + 1, "STG-04 eligibility"),
  });
  return Object.freeze({
    acceptance: Object.freeze(acceptance),
    eligibility: Object.freeze(eligibility),
  });
}

export function verifyAcceptedAmendmentEvents(input: {
  readonly events: readonly JsonObject[];
  readonly verifiedAmendment: VerifiedAmendment;
}): AmendmentAcceptanceEvents {
  if (input.events.length < 6) throw new Error("AMD-0001 accepted event chain is incomplete");
  const acceptance = record(input.events[4], "AMD-0001 acceptance event");
  const acceptedAt = Date.parse(String(acceptance.recordedAt));
  const expected = buildAmendmentAcceptanceEvents({
    verifiedAmendment: input.verifiedAmendment,
    acceptedAt,
    predecessor: input.events[3]!,
  });
  if (canonicalJson(acceptance) !== canonicalJson(expected.acceptance) ||
      canonicalJson(input.events[5]) !== canonicalJson(expected.eligibility)) {
    throw new Error("AMD-0001 acceptance or STG-04 eligibility event semantics are invalid");
  }
  const amendmentEvents = input.events.filter((event) => event.eventType === "amendment_accepted");
  if (amendmentEvents.length !== 1) throw new Error("AMD-0001 accepted amendment ordinal is not unique");
  return expected;
}

export function renderImplementationProgressProjection(events: readonly JsonObject[]): ProgressProjection {
  const jsonlBytes = Buffer.from(events.length === 0 ? "" : `${events.map(canonicalJson).join("\n")}\n`, "utf8");
  const lines = events.map((event) => {
    const marker = event.eventType === "step_completed" ? "x" : " ";
    const subject = event.stageId ?? event.amendmentId ?? event.eventId;
    return `- [${marker}] ${String(subject)} (${String(event.eventType)})`;
  });
  const markdownBytes = Buffer.from([
    "# Verified implementation progress",
    "",
    `Verified events: ${events.length}`,
    "",
    "Historical certification receipt: 40/40 launches.",
    "Active immutable post-start authority: 24 launches.",
    "",
    ...lines,
    "",
  ].join("\n"), "utf8");
  return { jsonlBytes, markdownBytes };
}
