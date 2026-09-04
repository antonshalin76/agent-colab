import { posix } from "node:path";
import {
  canonicalJson,
  computeBytesSha256,
  computeJsonSha256,
} from "../domain/canonical-json.js";
import {
  AMD_0001_AUTHORIZATION_TEXT,
  AMD_0001_AUTHORITY_FILE_SHA256,
  AMD_0001_FILE_SHA256,
  AMD_0001_ID,
  BASELINE_PLAN_SHA256,
  IMPLEMENTATION_PLAN_ID,
  type AmendmentAcceptanceCapability,
  type AmendmentCapabilityBinding,
  type AmendmentVerificationPort,
  type ArtifactFact,
  type JsonObject,
  type AuthorizedAmendment,
  type VerifiedAmendment,
} from "../flow/implementation-amendment.js";
import {
  buildNextStageEligibilityEvent,
  reduceImplementationProgress,
  renderImplementationProgressProjection,
  verifyAcceptedAmendmentEvents,
  verifyLiveProviderLaunchAccounting,
} from "../flow/implementation-progress.js";
import type {
  AuthorizedProgressEvent,
  ProgressEventVerifierPort,
  ProgressStoreIdentity,
} from "../flow/implementation-progress-authority.js";

const START_SHA256 = "851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee";
const SOURCE_BASELINE_HEAD = "d0f6cda738cf08ff851f14192ff48e636c1f0f17";
const AMD_PATH = "docs/hybrid-flow-v1-r2/amendments/AMD-0001.json";
const AMD_AUTHORITY_PATH = "docs/hybrid-flow-v1-r2/amendments/AMD-0001-authority.json";

interface ProgressSnapshot {
  readonly watermarkSequence: number;
  readonly watermarkEventSha256: string;
  readonly events: readonly JsonObject[];
}

interface ProgressStore {
  appendVerifiedEvent(input: AuthorizedProgressEvent): { eventId: string; sequence: number; replayed: boolean };
  appendVerifiedEventsAtomically(input: readonly AuthorizedProgressEvent[]): {
    eventId: string; sequence: number; replayed: boolean;
  };
  authorityIdentity(): ProgressStoreIdentity;
  acceptVerifiedAmendment(input: { verifiedAmendment: AuthorizedAmendment; acceptedAt: number }): {
    effectivePlanSha256: string;
    replayed: boolean;
  };
  snapshotProjection(): ProgressSnapshot;
}

interface SourceFacts {
  readonly start: JsonObject;
  readonly planLock: JsonObject;
  readonly planAnchorParent: string;
}

export interface ImplementationProgressVerification {
  readonly status: "verified";
  readonly authority: "sqlite";
  readonly progressEventCount: number;
  readonly lastEventSha256: string;
  readonly effectivePlanSha256: string;
  readonly projectionStatus: "current" | "pending" | "stale";
  readonly invalidatedEventIds: readonly string[];
  readonly launchAccounting: {
    readonly historical: {
      readonly recordedCap: number;
      readonly consumed: number;
      readonly legacyNullDerivedZero: readonly string[];
    };
    readonly postStart: {
      readonly cap: number;
      readonly consumed: number;
      readonly remaining: number;
      readonly costCapUsd: number;
      readonly costConsumedUsd: number;
      readonly costRemainingUsd: number;
    };
  };
}

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function safeArtifactPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") ||
      value.includes("\0") || posix.normalize(value) !== value || value === ".." || value.startsWith("../")) {
    throw new Error(`${label} artifact path escapes its evidence root`);
  }
  return value;
}

function assertSourceFacts(source: SourceFacts): void {
  const start = record(source.start, "implementation start");
  const planLock = record(source.planLock, "implementation plan lock");
  const startWithoutDigest = structuredClone(start);
  delete startWithoutDigest.startSha256;
  const baseline = record(planLock.sourceBaseline, "implementation plan source baseline");
  if (start.schemaVersion !== "implementation-start/v1" || start.planId !== IMPLEMENTATION_PLAN_ID ||
      start.startSha256 !== START_SHA256 || computeJsonSha256(startWithoutDigest) !== START_SHA256 ||
      start.sourceBaselineHead !== SOURCE_BASELINE_HEAD || source.planAnchorParent !== SOURCE_BASELINE_HEAD ||
      start.liveProviderScope !== "max_24_launches_usd_10" || start.routingPolicy !== "routing-v5" ||
      planLock.schemaVersion !== "implementation-plan-lock/v1" || planLock.planId !== IMPLEMENTATION_PLAN_ID ||
      planLock.planSha256 !== BASELINE_PLAN_SHA256 || baseline.sourceBaselineHead !== SOURCE_BASELINE_HEAD ||
      baseline.routingPolicy !== "routing-v5") {
    throw new Error("implementation start, plan lock, source baseline or active 24-launch authority is invalid");
  }
}

export class ImplementationProgressService {
  readonly #store: ProgressStore;
  readonly #databasePath: string;
  readonly #readArtifact: (path: string) => Buffer;
  readonly #readProjection: () => { jsonl?: Buffer; markdown?: Buffer };
  readonly #sourceFacts: SourceFacts;
  readonly #progressVerifier: ProgressEventVerifierPort | undefined;
  readonly #amendmentAuthority: AmendmentVerificationPort | undefined;

  constructor(input: {
    readonly store: ProgressStore;
    readonly databasePath: string;
    readonly readArtifact: (path: string) => Buffer;
    readonly readProjection: () => { jsonl?: Buffer; markdown?: Buffer };
    readonly sourceFacts: SourceFacts;
    readonly progressVerifier?: ProgressEventVerifierPort;
    readonly amendmentAuthority?: AmendmentVerificationPort;
  }) {
    this.#store = input.store;
    this.#databasePath = input.databasePath;
    this.#readArtifact = input.readArtifact;
    this.#readProjection = input.readProjection;
    this.#sourceFacts = structuredClone(input.sourceFacts);
    this.#progressVerifier = input.progressVerifier;
    this.#amendmentAuthority = input.amendmentAuthority;
    assertSourceFacts(this.#sourceFacts);
  }

  appendEvent(input: { readonly event: JsonObject; readonly eventJson: string }): {
    eventId: string;
    sequence: number;
    replayed: boolean;
  } {
    this.verify();
    if (input.event.eventType === "amendment_accepted") {
      throw new Error("public amendment_accepted append is forbidden; acceptAmendment authority is required");
    }
    if (input.event.eventType === "step_eligible") {
      throw new Error("public step_eligible append is forbidden; eligibility is derived by the stage transition");
    }
    if (input.event.eventType !== "step_completed") {
      throw new Error("public progress append accepts only a completed stage transition");
    }
    const snapshot = this.#store.snapshotProjection();
    const existing = snapshot.events.find((event) => event.eventId === input.event.eventId);
    if (existing) {
      if (input.eventJson !== canonicalJson(input.event) || canonicalJson(existing) !== input.eventJson) {
        throw new Error("progress event replay conflicts with immutable event bytes");
      }
      if (input.event.effectivePlanSha256 !== BASELINE_PLAN_SHA256) {
        const expectedEligibility = buildNextStageEligibilityEvent(input.event);
        if (expectedEligibility !== null) {
          const committedEligibility = snapshot.events[Number(input.event.sequence)];
          if (!committedEligibility || canonicalJson(committedEligibility) !== canonicalJson(expectedEligibility)) {
            throw new Error("completed stage replay is missing its exact atomic next-stage eligibility");
          }
        }
      }
      const verifiedReplay = this.#requireProgressVerifier().authorizeReplay({
        storeIdentity: this.#store.authorityIdentity(),
        existingEvents: snapshot.events,
        candidate: input.event,
        eventJson: input.eventJson,
      });
      return this.#store.appendVerifiedEvent(verifiedReplay);
    }
    const candidateEvents = [...snapshot.events, input.event];
    const artifactFacts = this.#artifactFacts(candidateEvents);
    const verified = this.#requireProgressVerifier().authorize({
      storeIdentity: this.#store.authorityIdentity(),
      existingEvents: snapshot.events,
      candidate: input.event,
      eventJson: input.eventJson,
      artifactFacts,
      startSha256: START_SHA256,
      baselinePlanSha256: BASELINE_PLAN_SHA256,
    });
    verifyLiveProviderLaunchAccounting({
      implementationStart: this.#sourceFacts.start,
      events: candidateEvents,
      artifactFacts,
    });
    if (input.event.effectivePlanSha256 === BASELINE_PLAN_SHA256) {
      return this.#store.appendVerifiedEvent(verified);
    }
    const eligibility = buildNextStageEligibilityEvent(input.event);
    const verifiedEligibility = eligibility === null ? null : this.#requireProgressVerifier().authorize({
      storeIdentity: this.#store.authorityIdentity(),
      existingEvents: candidateEvents,
      candidate: eligibility,
      eventJson: canonicalJson(eligibility),
      artifactFacts: [],
      startSha256: START_SHA256,
      baselinePlanSha256: BASELINE_PLAN_SHA256,
    });
    return this.#store.appendVerifiedEventsAtomically(
      verifiedEligibility ? [verified, verifiedEligibility] : [verified],
    );
  }

  acceptAmendment(
    input: {
      readonly amendmentPath: string;
      readonly authorityReceiptPath: string;
      readonly authorizationTextBytes: Buffer;
      readonly acceptedAt: number;
    },
    capability: AmendmentAcceptanceCapability,
  ): { effectivePlanSha256: string; replayed: boolean } {
    const authority = this.#requireAmendmentAuthority();
    const binding = {
      databasePath: this.#databasePath,
      amendmentId: AMD_0001_ID,
      amendmentPath: input.amendmentPath,
      amendmentFileSha256: AMD_0001_FILE_SHA256,
      authorityReceiptPath: input.authorityReceiptPath,
      authorityReceiptFileSha256: AMD_0001_AUTHORITY_FILE_SHA256,
    } as const;
    authority.assertRequest(capability, binding);
    this.verify();
    const predecessorEvents = this.#store.snapshotProjection().events;
    const verifiedAmendment = this.#readAndVerifyAmendment({
      amendmentPath: input.amendmentPath,
      authorityReceiptPath: input.authorityReceiptPath,
      authorizationTextBytes: input.authorizationTextBytes,
      acceptedAt: input.acceptedAt,
      capability,
      binding,
      predecessorEvents,
    });
    const result = this.#store.acceptVerifiedAmendment({ verifiedAmendment, acceptedAt: input.acceptedAt });
    const verifiedState = this.verify();
    if (verifiedState.progressEventCount < 6 ||
        verifiedState.effectivePlanSha256 !== verifiedAmendment.effectivePlanSha256) {
      throw new Error("AMD-0001 post-acceptance ledger verification failed");
    }
    return result;
  }

  verify(): ImplementationProgressVerification {
    assertSourceFacts(this.#sourceFacts);
    const snapshot = this.#store.snapshotProjection();
    const artifactFacts = this.#artifactFacts(snapshot.events);
    const reduced = reduceImplementationProgress({
      events: snapshot.events,
      startSha256: START_SHA256,
      baselinePlanSha256: BASELINE_PLAN_SHA256,
      artifactFacts,
    });
    const launchAccounting = verifyLiveProviderLaunchAccounting({
      implementationStart: this.#sourceFacts.start,
      events: snapshot.events,
      artifactFacts,
    });
    if (snapshot.events.some((event) => event.eventType === "amendment_accepted")) {
      const acceptance = snapshot.events[4];
      if (!acceptance) throw new Error("AMD-0001 acceptance event is missing");
      const verifiedAmendment = this.#readAndVerifyPersistedAmendment({
        amendmentPath: AMD_PATH,
        authorityReceiptPath: AMD_AUTHORITY_PATH,
        authorizationTextBytes: Buffer.from(AMD_0001_AUTHORIZATION_TEXT, "utf8"),
        acceptedAt: Date.parse(String(acceptance.recordedAt)),
      });
      verifyAcceptedAmendmentEvents({ events: snapshot.events, verifiedAmendment });
      if (reduced.effectivePlanSha256 !== verifiedAmendment.effectivePlanSha256) {
        throw new Error("AMD-0001 effective plan epoch does not match the accepted amendment");
      }
    }
    const projectionStatus = this.#projectionStatus(snapshot.events);
    return Object.freeze({
      status: "verified",
      authority: "sqlite",
      progressEventCount: snapshot.watermarkSequence,
      lastEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: reduced.effectivePlanSha256,
      projectionStatus,
      invalidatedEventIds: Object.freeze([...reduced.invalidatedEventIds]),
      launchAccounting: Object.freeze({
        historical: Object.freeze({
          ...launchAccounting.historical,
          legacyNullDerivedZero: Object.freeze([...launchAccounting.historical.legacyNullDerivedZero]),
        }),
        postStart: Object.freeze({ ...launchAccounting.postStart }),
      }),
    });
  }

  #requireAmendmentAuthority(): AmendmentVerificationPort {
    if (!this.#amendmentAuthority) throw new Error("issued amendment authority capability identity is required");
    return this.#amendmentAuthority;
  }

  #requireProgressVerifier(): ProgressEventVerifierPort {
    if (!this.#progressVerifier) throw new Error("progress verifier authority port is required");
    return this.#progressVerifier;
  }

  #readAndVerifyAmendment(input: {
    readonly amendmentPath: string;
    readonly authorityReceiptPath: string;
    readonly authorizationTextBytes: Buffer;
    readonly acceptedAt: number;
    readonly capability: AmendmentAcceptanceCapability;
    readonly binding: AmendmentCapabilityBinding;
    readonly predecessorEvents: readonly JsonObject[];
  }): AuthorizedAmendment {
    const authority = this.#requireAmendmentAuthority();
    const amendment = this.#readCanonicalDocument(
      input.amendmentPath,
      AMD_PATH,
      AMD_0001_FILE_SHA256,
      "AMD-0001 amendment",
    );
    const authorityReceipt = this.#readCanonicalDocument(
      input.authorityReceiptPath,
      AMD_AUTHORITY_PATH,
      AMD_0001_AUTHORITY_FILE_SHA256,
      "AMD-0001 authority receipt",
    );
    const evidence = amendment.evidence;
    if (!Array.isArray(evidence)) throw new Error("AMD-0001 evidence inventory is missing");
    const evidenceArtifacts = evidence.map((reference) => {
      const path = safeArtifactPath(record(reference, "AMD-0001 evidence reference").path, "AMD-0001 evidence");
      return { path, bytes: this.#readArtifactBytes(path, "AMD-0001 evidence") };
    });
    return authority.authorize({
      capability: input.capability,
      binding: input.binding,
      predecessorEvents: input.predecessorEvents,
      storeIdentity: this.#store.authorityIdentity(),
      verification: {
        amendment,
        authorityReceipt,
        authorizationTextBytes: Buffer.from(input.authorizationTextBytes),
        acceptedAt: input.acceptedAt,
        evidenceArtifacts,
      },
    });
  }

  #readAndVerifyPersistedAmendment(input: {
    readonly amendmentPath: string;
    readonly authorityReceiptPath: string;
    readonly authorizationTextBytes: Buffer;
    readonly acceptedAt: number;
  }): VerifiedAmendment {
    const authority = this.#requireAmendmentAuthority();
    const verification = this.#readAmendmentVerificationInput(input);
    return authority.verifyPersisted(verification);
  }

  #readAmendmentVerificationInput(input: {
    readonly amendmentPath: string;
    readonly authorityReceiptPath: string;
    readonly authorizationTextBytes: Buffer;
    readonly acceptedAt: number;
  }): {
    readonly amendment: JsonObject;
    readonly authorityReceipt: JsonObject;
    readonly authorizationTextBytes: Buffer;
    readonly acceptedAt: number;
    readonly evidenceArtifacts: readonly ArtifactFact[];
  } {
    const amendment = this.#readCanonicalDocument(
      input.amendmentPath, AMD_PATH, AMD_0001_FILE_SHA256, "AMD-0001 amendment",
    );
    const authorityReceipt = this.#readCanonicalDocument(
      input.authorityReceiptPath, AMD_AUTHORITY_PATH, AMD_0001_AUTHORITY_FILE_SHA256, "AMD-0001 authority receipt",
    );
    if (!Array.isArray(amendment.evidence)) throw new Error("AMD-0001 evidence inventory is missing");
    return {
      amendment,
      authorityReceipt,
      authorizationTextBytes: Buffer.from(input.authorizationTextBytes),
      acceptedAt: input.acceptedAt,
      evidenceArtifacts: amendment.evidence.map((reference) => {
        const path = safeArtifactPath(record(reference, "AMD-0001 evidence reference").path, "AMD-0001 evidence");
        return { path, bytes: this.#readArtifactBytes(path, "AMD-0001 evidence") };
      }),
    };
  }

  #readCanonicalDocument(
    requestPath: string,
    expectedPath: string,
    expectedFileSha256: string,
    label: string,
  ): JsonObject {
    if (requestPath !== expectedPath) throw new Error(`${label} file path is not authority-bound`);
    const bytes = this.#readArtifactBytes(requestPath, label);
    if (computeBytesSha256(bytes) !== expectedFileSha256) throw new Error(`${label} file digest mismatch`);
    let value: JsonObject;
    try { value = record(JSON.parse(bytes.toString("utf8")), label); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${label} file is not valid JSON`, { cause: error });
      throw error;
    }
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"))) {
      throw new Error(`${label} file bytes are not canonical`);
    }
    return value;
  }

  #artifactFacts(events: readonly JsonObject[]): ArtifactFact[] {
    const paths = new Set<string>();
    for (const event of events) {
      if (event.eventType !== "step_completed") continue;
      if (!Array.isArray(event.artifactPaths)) continue;
      for (const value of event.artifactPaths) paths.add(safeArtifactPath(value, "progress"));
    }
    return [...paths].map((path) => ({ path, bytes: this.#readArtifactBytes(path, "progress artifact") }));
  }

  #readArtifactBytes(path: string, label: string): Buffer {
    const safePath = safeArtifactPath(path, label);
    try {
      const bytes = this.#readArtifact(safePath);
      if (!Buffer.isBuffer(bytes)) throw new Error(`${label} reader did not return Buffer bytes`);
      return Buffer.from(bytes);
    } catch (error) {
      throw new Error(`${label} file is missing or unreadable: ${safePath}`, { cause: error });
    }
  }

  #projectionStatus(events: readonly JsonObject[]): "current" | "pending" | "stale" {
    const projection = this.#readProjection();
    if (!projection.jsonl || !projection.markdown) return "pending";
    const expected = renderImplementationProgressProjection(events);
    return projection.jsonl.equals(expected.jsonlBytes) && projection.markdown.equals(expected.markdownBytes)
      ? "current"
      : "stale";
  }
}
