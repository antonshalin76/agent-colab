import { canonicalJson, computeBytesSha256, computeJsonSha256 } from "../domain/canonical-json.js";

export type JsonObject = Record<string, unknown>;

export interface ArtifactFact {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface TrustedAmendmentAuthority {
  readonly schemaVersion: "trusted-amendment-authority/v1";
  readonly consumer: string;
  readonly expectedReceiptSha256: string;
  readonly authorizationTextSha256: string;
}

export interface AmendmentVerificationInput {
  readonly amendment: JsonObject;
  readonly authorityReceipt: JsonObject;
  readonly authorizationTextBytes: Buffer;
  readonly acceptedAt: number;
  readonly evidenceArtifacts: readonly ArtifactFact[];
}

export interface VerifiedAmendment {
  readonly amendment: JsonObject;
  readonly authorityReceipt: JsonObject;
  readonly amendmentSha256: string;
  readonly authorityReceiptSha256: string;
  readonly effectivePlanSha256: string;
}

declare const authorizedAmendmentBrand: unique symbol;
export interface AuthorizedAmendment extends VerifiedAmendment {
  readonly [authorizedAmendmentBrand]: true;
}

declare const amendmentAcceptanceBrand: unique symbol;
export interface AmendmentAcceptanceCapability {
  readonly [amendmentAcceptanceBrand]: true;
}

export interface AmendmentCapabilityBinding {
  readonly databasePath: string;
  readonly amendmentId: "AMD-0001";
  readonly amendmentPath: string;
  readonly amendmentFileSha256: string;
  readonly authorityReceiptPath: string;
  readonly authorityReceiptFileSha256: string;
}

export interface AmendmentAcceptanceAuthority {
  readonly issuer: AmendmentCapabilityIssuer;
  readonly service: AmendmentVerificationPort;
  readonly store: AmendmentCommitPort;
}

export interface AmendmentCapabilityIssuer {
  issue(binding: AmendmentCapabilityBinding): AmendmentAcceptanceCapability;
}

export interface AmendmentVerificationPort {
  assertRequest(capability: AmendmentAcceptanceCapability, binding: AmendmentCapabilityBinding): void;
  verifyPersisted(input: AmendmentVerificationInput): VerifiedAmendment;
  authorize(input: {
    readonly capability: AmendmentAcceptanceCapability;
    readonly binding: AmendmentCapabilityBinding;
    readonly verification: AmendmentVerificationInput;
    readonly predecessorEvents: readonly JsonObject[];
    readonly storeIdentity: { readonly databasePath: string; readonly generation: string };
  }): AuthorizedAmendment;
}

export interface AmendmentCommitClaim {
  complete(): void;
  abort(): void;
}

export interface AmendmentCommitPort {
  attach(input: { readonly databasePath: string; readonly generation: string }): void;
  claim(input: AuthorizedAmendment, predecessorEvents: readonly JsonObject[]): AmendmentCommitClaim;
}

export const IMPLEMENTATION_PLAN_ID = "agent-collab-hybrid-flow-v1-r2" as const;
export const BASELINE_PLAN_SHA256 = "af9191ea30d500de7f53cfdb57a890bfc7c1e55df3d3e738ed667bce7a787224" as const;
export const AMD_0001_ID = "AMD-0001" as const;
export const AMD_0001_FILE_SHA256 = "5ea6ba681c0b0d7567d248441924e6e602982fca283d0fbaea27bf7a0c92c685" as const;
export const AMD_0001_AUTHORITY_RECEIPT_SHA256 = "e5a76fdbc55a8b584bebaa842a958418a896853ffb5be08725c7abdccfacf1a3" as const;
export const AMD_0001_AUTHORITY_FILE_SHA256 = "8d3d62db9434f3a5ae422a36b9d76fe9234287363740ba4c7a7994ca930c2562" as const;
export const AMD_0001_AUTHORIZATION_TEXT = "разрешаю оформить и принять AMD-0001 в указанном объёме" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = ["STG-04", "STG-08"] as const;
const GATES = ["STG-04-G1", "STG-04-G2", "STG-08-G1", "STG-08-G2"] as const;
const EVIDENCE_PATHS = [
  "docs/hybrid-flow-v1-r2/amendments/evidence/architecture-slice.md",
  "docs/hybrid-flow-v1-r2/amendments/evidence/stg-03-source-manifest.json",
] as const;
const AUTHORITY_CONSUMER = "agent-collab:implementation-amendment:AMD-0001";
const RECORDED_AT = "2026-09-04T17:09:00+08:00";
const CAPTURED_AT = "2026-09-04T17:08:05+08:00";

export const AMD_0001_CONTRACT_DELTA = {
  "STG-04": {
    add: [
      "bounded_post_commit_telemetry_export",
      "graph_fixture_event_session_usage_persistence",
      "provider_terminal_usage_normalization_and_observation_transport",
      "terminal_flow_payload_archival",
    ],
    deferToStage: {
      stageId: "STG-08",
      capabilities: [
        "graph_transition_and_telemetry_atomicity",
        "runstore_worker_service_cli_telemetry_execution_wiring",
      ],
    },
  },
  "STG-08": {
    add: [
      "graph_transition_and_telemetry_atomicity",
      "runstore_worker_service_cli_telemetry_execution_wiring",
    ],
  },
} as const;

export const AMD_0001_ACCEPTANCE_DELTA = {
  replace: [
    {
      gateId: "STG-04-G1",
      from: "Usage provenance and aggregation tests pass.",
      to: "Graph-fixture event, session, and usage persistence, provider normalization, provenance, aggregation, and crash/replay tests pass.",
    },
    {
      gateId: "STG-04-G2",
      from: "Redaction, archival, and exporter-failure tests pass.",
      to: "Redaction, archival, bounded detached exporter-failure, and legacy zero-effect tests pass; execution wiring remains unchanged.",
    },
  ],
  augment: [
    {
      gateId: "STG-08-G1",
      text: "Execution wiring proves transition-plus-telemetry atomicity and crash/replay safety.",
    },
    {
      gateId: "STG-08-G2",
      text: "No duplicate session, event, usage, or terminal receipt is permitted.",
    },
  ],
} as const;

export const AMD_0001_AUTHORITY_DELTA = {
  approval: "unchanged",
  safety: "unchanged",
  routingV5: "unchanged",
  reviewQuorum: "unchanged",
  liveProviderLaunchCap: "unchanged",
  migration: "not_authorized",
  deployment: "not_authorized",
  providerLaunch: "not_authorized",
  graphActivation: "not_authorized",
  legacyActivation: "not_authorized",
} as const;

const AMENDMENT_FIELDS = [
  "schemaVersion", "amendmentId", "ordinal", "planId", "baselinePlanSha256",
  "previousEffectivePlanSha256", "affectedStageIds", "affectedGateIds", "reason",
  "reasonSha256", "evidence", "evidenceSha256", "contractDelta", "acceptanceDelta",
  "authorityDelta", "invalidatedEventIds", "authorityConsumer", "authorityReceiptSha256",
  "recordedAt", "amendmentSha256",
] as const;
const AUTHORITY_FIELDS = [
  "schemaVersion", "planId", "amendmentId", "ordinal", "consumer",
  "affectedStageIds", "affectedGateIds", "contractDeltaSha256",
  "acceptanceDeltaSha256", "authorityDeltaSha256", "scope",
  "authorizationTextSha256", "capturedAt", "proposalSha256",
] as const;

function exactFields(value: JsonObject, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} fields do not match the exact AMD-0001 contract`);
  }
}

function exactValue(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} is outside the exact AMD-0001 allowlist`);
  }
}

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function verifiedEvidence(amendment: JsonObject, artifacts: readonly ArtifactFact[]): void {
  if (!Array.isArray(amendment.evidence) || amendment.evidence.length !== EVIDENCE_PATHS.length ||
      artifacts.length !== EVIDENCE_PATHS.length) {
    throw new Error("AMD-0001 evidence inventory is incomplete");
  }
  const seen = new Set<string>();
  for (const [index, expectedPath] of EVIDENCE_PATHS.entries()) {
    const reference = record(amendment.evidence[index], "AMD evidence reference");
    exactFields(reference, ["path", "sha256"], "AMD evidence reference");
    const artifact = artifacts[index];
    if (reference.path !== expectedPath || artifact?.path !== expectedPath || seen.has(expectedPath) ||
        !SHA256.test(String(reference.sha256)) || !Buffer.isBuffer(artifact.bytes) ||
        computeBytesSha256(artifact.bytes) !== reference.sha256) {
      throw new Error("AMD-0001 evidence path or digest does not match the accepted artifact bytes");
    }
    seen.add(expectedPath);
  }
  if (computeJsonSha256(amendment.evidence) !== amendment.evidenceSha256) {
    throw new Error("AMD-0001 evidence digest mismatch");
  }
}

export function verifyImplementationAmendment(
  input: AmendmentVerificationInput,
  trustedAuthority: TrustedAmendmentAuthority,
): VerifiedAmendment {
  const amendment = record(input.amendment, "AMD amendment");
  const authority = record(input.authorityReceipt, "AMD authority receipt");
  exactFields(amendment, AMENDMENT_FIELDS, "AMD amendment");
  exactFields(authority, AUTHORITY_FIELDS, "AMD authority receipt");

  if (trustedAuthority.schemaVersion !== "trusted-amendment-authority/v1" ||
      trustedAuthority.consumer !== AUTHORITY_CONSUMER ||
      !SHA256.test(trustedAuthority.expectedReceiptSha256) ||
      !SHA256.test(trustedAuthority.authorizationTextSha256)) {
    throw new Error("external trusted amendment authority is invalid");
  }
  if (amendment.schemaVersion !== "implementation-amendment/v1" ||
      amendment.amendmentId !== AMD_0001_ID || amendment.ordinal !== 1 ||
      amendment.planId !== IMPLEMENTATION_PLAN_ID ||
      amendment.baselinePlanSha256 !== BASELINE_PLAN_SHA256 ||
      amendment.previousEffectivePlanSha256 !== BASELINE_PLAN_SHA256 ||
      amendment.authorityConsumer !== AUTHORITY_CONSUMER || amendment.recordedAt !== RECORDED_AT) {
    throw new Error("AMD-0001 identity, chain or epoch binding is invalid");
  }
  if (typeof amendment.reason !== "string" || amendment.reason.length === 0 ||
      Buffer.byteLength(amendment.reason) > 4_096 || computeJsonSha256(amendment.reason) !== amendment.reasonSha256) {
    throw new Error("AMD-0001 reason or reason digest is invalid");
  }
  exactValue(amendment.affectedStageIds, STAGES, "AMD affected stages");
  exactValue(amendment.affectedGateIds, GATES, "AMD affected gates");
  exactValue(amendment.contractDelta, AMD_0001_CONTRACT_DELTA, "AMD contract delta");
  exactValue(amendment.acceptanceDelta, AMD_0001_ACCEPTANCE_DELTA, "AMD acceptance delta");
  exactValue(amendment.authorityDelta, AMD_0001_AUTHORITY_DELTA, "AMD authority delta");
  exactValue(amendment.invalidatedEventIds, [], "AMD invalidated event IDs");
  verifiedEvidence(amendment, input.evidenceArtifacts);

  const proposal = structuredClone(amendment);
  delete proposal.authorityReceiptSha256;
  delete proposal.amendmentSha256;
  const proposalSha256 = computeJsonSha256(proposal);
  const authorityReceiptSha256 = computeJsonSha256(authority);
  if (authority.schemaVersion !== "implementation-amendment-authority/v1" ||
      authority.planId !== IMPLEMENTATION_PLAN_ID || authority.amendmentId !== AMD_0001_ID ||
      authority.ordinal !== 1 || authority.consumer !== AUTHORITY_CONSUMER ||
      authority.capturedAt !== CAPTURED_AT || authority.proposalSha256 !== proposalSha256 ||
      authorityReceiptSha256 !== amendment.authorityReceiptSha256 ||
      authorityReceiptSha256 !== trustedAuthority.expectedReceiptSha256) {
    throw new Error("AMD-0001 authority receipt does not match the external trust anchor");
  }
  exactValue(authority.affectedStageIds, STAGES, "authority affected stages");
  exactValue(authority.affectedGateIds, GATES, "authority affected gates");
  exactValue(authority.scope, {
    amendmentAcceptance: true,
    migration: false,
    deployment: false,
    providerLaunch: false,
    graphActivation: false,
    legacyActivation: false,
  }, "authority scope");
  if (authority.contractDeltaSha256 !== computeJsonSha256(AMD_0001_CONTRACT_DELTA) ||
      authority.acceptanceDeltaSha256 !== computeJsonSha256(AMD_0001_ACCEPTANCE_DELTA) ||
      authority.authorityDeltaSha256 !== computeJsonSha256(AMD_0001_AUTHORITY_DELTA)) {
    throw new Error("AMD-0001 authority delta digest mismatch");
  }
  if (!Buffer.isBuffer(input.authorizationTextBytes) ||
      computeBytesSha256(input.authorizationTextBytes) !== authority.authorizationTextSha256 ||
      authority.authorizationTextSha256 !== trustedAuthority.authorizationTextSha256) {
    throw new Error("AMD-0001 authorization text bytes do not match authority");
  }
  const recordedAt = Date.parse(String(amendment.recordedAt));
  const capturedAt = Date.parse(String(authority.capturedAt));
  if (!Number.isSafeInteger(input.acceptedAt) || !Number.isSafeInteger(recordedAt) ||
      !Number.isSafeInteger(capturedAt) || capturedAt > recordedAt || recordedAt >= input.acceptedAt) {
    throw new Error("AMD-0001 authority chronology is invalid");
  }

  const amendmentWithoutDigest = structuredClone(amendment);
  delete amendmentWithoutDigest.amendmentSha256;
  const amendmentSha256 = computeJsonSha256(amendmentWithoutDigest);
  if (amendment.amendmentSha256 !== amendmentSha256) throw new Error("AMD-0001 amendment digest mismatch");
  const effectivePlanSha256 = computeJsonSha256({
    baselinePlanSha256: BASELINE_PLAN_SHA256,
    previousEffectivePlanSha256: BASELINE_PLAN_SHA256,
    ordinal: 1,
    amendmentSha256,
  });
  return Object.freeze({
    amendment: structuredClone(amendment),
    authorityReceipt: structuredClone(authority),
    amendmentSha256,
    authorityReceiptSha256,
    effectivePlanSha256,
  });
}

function sameBinding(left: AmendmentCapabilityBinding, right: AmendmentCapabilityBinding): boolean {
  return left.databasePath === right.databasePath && left.amendmentId === right.amendmentId &&
    left.amendmentPath === right.amendmentPath && left.amendmentFileSha256 === right.amendmentFileSha256 &&
    left.authorityReceiptPath === right.authorityReceiptPath &&
    left.authorityReceiptFileSha256 === right.authorityReceiptFileSha256;
}

export function createAmendmentAcceptanceAuthority(
  trustedAuthority: TrustedAmendmentAuthority,
): AmendmentAcceptanceAuthority {
  const trusted = structuredClone(trustedAuthority);
  const issued = new WeakSet<object>();
  const bindings = new WeakMap<object, AmendmentCapabilityBinding>();
  const authorizations = new WeakMap<object, {
    readonly binding: AmendmentCapabilityBinding;
    readonly storeIdentity: { readonly databasePath: string; readonly generation: string };
    readonly predecessorJson: string;
    status: "ready" | "claimed" | "consumed";
  }>();
  let attached: { readonly databasePath: string; readonly generation: string } | undefined;
  const issue = (binding: AmendmentCapabilityBinding): AmendmentAcceptanceCapability => {
    if (binding.amendmentId !== AMD_0001_ID || !binding.databasePath || !binding.amendmentPath ||
        !binding.authorityReceiptPath || !SHA256.test(binding.amendmentFileSha256) ||
        !SHA256.test(binding.authorityReceiptFileSha256)) {
      throw new Error("amendment authority binding is invalid");
    }
    const token = Object.freeze({}) as AmendmentAcceptanceCapability;
    issued.add(token);
    bindings.set(token, structuredClone(binding));
    return token;
  };
  const assertCapability = (
    capability: AmendmentAcceptanceCapability,
    binding: AmendmentCapabilityBinding,
  ): void => {
    if (!capability || !issued.has(capability)) {
      throw new Error("issued amendment authority capability identity is required");
    }
    const accepted = bindings.get(capability);
    if (!accepted || !sameBinding(accepted, binding)) {
      throw new Error("amendment authority capability binding does not match the database target");
    }
  };
  return Object.freeze({
    issuer: Object.freeze({ issue }),
    service: Object.freeze({
      assertRequest: assertCapability,
      verifyPersisted: (input: AmendmentVerificationInput) => verifyImplementationAmendment(input, trusted),
      authorize(input: {
        readonly capability: AmendmentAcceptanceCapability;
        readonly binding: AmendmentCapabilityBinding;
        readonly verification: AmendmentVerificationInput;
        readonly predecessorEvents: readonly JsonObject[];
        readonly storeIdentity: { readonly databasePath: string; readonly generation: string };
      }) {
        assertCapability(input.capability, input.binding);
        if (!attached || attached.databasePath !== input.binding.databasePath ||
            attached.databasePath !== input.storeIdentity.databasePath ||
            attached.generation !== input.storeIdentity.generation) {
          throw new Error("amendment authority is not attached to the exact SQLite store target");
        }
        const verified = Object.freeze({ ...verifyImplementationAmendment(input.verification, trusted) }) as AuthorizedAmendment;
        authorizations.set(verified, {
          binding: structuredClone(input.binding),
          storeIdentity: structuredClone(input.storeIdentity),
          predecessorJson: canonicalJson(input.predecessorEvents),
          status: "ready",
        });
        return verified;
      },
    }),
    store: Object.freeze({
      attach(input: { readonly databasePath: string; readonly generation: string }) {
        if (attached && attached.databasePath !== input.databasePath) {
          throw new Error("amendment commit authority is already attached to another store identity");
        }
        attached = structuredClone(input);
      },
      claim(input: AuthorizedAmendment, predecessorEvents: readonly JsonObject[]) {
        const state = authorizations.get(input as object);
        if (!attached || !state || state.binding.databasePath !== attached.databasePath ||
            state.storeIdentity.generation !== attached.generation ||
            state.predecessorJson !== canonicalJson(predecessorEvents)) {
          throw new Error("verified amendment has no exact store-bound acceptance capability attestation");
        }
        if (state.status !== "ready") throw new Error("amendment commit authorization was already claimed or consumed");
        state.status = "claimed";
        let settled = false;
        return Object.freeze({
          complete() {
            if (settled || state.status !== "claimed") throw new Error("amendment commit claim is not active");
            settled = true;
            state.status = "consumed";
          },
          abort() {
            if (settled) return;
            settled = true;
            if (state.status === "claimed") state.status = "ready";
          },
        });
      },
    }),
  });
}
