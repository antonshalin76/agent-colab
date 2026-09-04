import { canonicalJson } from "../domain/canonical-json.js";
import {
  verifyProgressEvent,
  type ProgressEventVerificationInput,
  type VerifiedProgressEvent,
} from "./implementation-progress.js";
import type { JsonObject } from "./implementation-amendment.js";

export interface ProgressStoreIdentity {
  readonly databasePath: string;
  readonly generation: string;
}

declare const authorizedProgressEventBrand: unique symbol;
export interface AuthorizedProgressEvent extends VerifiedProgressEvent {
  readonly [authorizedProgressEventBrand]: true;
}

export interface ProgressEventVerificationRequest extends ProgressEventVerificationInput {
  readonly storeIdentity: ProgressStoreIdentity;
}

export interface ProgressEventVerifierPort {
  authorize(input: ProgressEventVerificationRequest): AuthorizedProgressEvent;
  authorizeReplay(input: {
    readonly storeIdentity: ProgressStoreIdentity;
    readonly existingEvents: readonly JsonObject[];
    readonly candidate: JsonObject;
    readonly eventJson: string;
  }): AuthorizedProgressEvent;
}

export interface ProgressEventCommitClaim {
  complete(): void;
  abort(): void;
}

export interface ProgressEventCommitPort {
  attach(identity: ProgressStoreIdentity): void;
  claim(input: AuthorizedProgressEvent, actualEvents: readonly JsonObject[]): ProgressEventCommitClaim;
}

interface AuthorizationState {
  readonly identity: ProgressStoreIdentity;
  readonly eventJson: string;
  readonly eventSha256: string;
  readonly predecessorJson: string;
  status: "ready" | "claimed" | "consumed";
}

const sameIdentity = (left: ProgressStoreIdentity, right: ProgressStoreIdentity): boolean =>
  left.databasePath === right.databasePath && left.generation === right.generation;

export function createImplementationProgressAuthority(): {
  readonly verifier: ProgressEventVerifierPort;
  readonly store: ProgressEventCommitPort;
} {
  let attached: ProgressStoreIdentity | undefined;
  const authorizations = new WeakMap<object, AuthorizationState>();

  const authorize = (
    input: Pick<ProgressEventVerificationRequest, "storeIdentity" | "existingEvents">,
    verified: VerifiedProgressEvent,
  ): AuthorizedProgressEvent => {
    if (!attached || !sameIdentity(attached, input.storeIdentity)) {
      throw new Error("progress verification authority is not attached to this exact store identity");
    }
    const authorization = Object.freeze({ ...verified }) as AuthorizedProgressEvent;
    authorizations.set(authorization, {
      identity: structuredClone(input.storeIdentity),
      eventJson: verified.eventJson,
      eventSha256: verified.eventSha256,
      predecessorJson: canonicalJson(input.existingEvents),
      status: "ready",
    });
    return authorization;
  };

  const verifier: ProgressEventVerifierPort = Object.freeze({
    authorize(input: ProgressEventVerificationRequest) {
      return authorize(input, verifyProgressEvent(input));
    },
    authorizeReplay(input: {
      readonly storeIdentity: ProgressStoreIdentity;
      readonly existingEvents: readonly JsonObject[];
      readonly candidate: JsonObject;
      readonly eventJson: string;
    }) {
      if (input.eventJson !== canonicalJson(input.candidate)) {
        throw new Error("progress replay bytes are not canonical");
      }
      const existing = input.existingEvents.find((event: JsonObject) => event.eventId === input.candidate.eventId);
      if (!existing || canonicalJson(existing) !== input.eventJson ||
          existing.eventSha256 !== input.candidate.eventSha256) {
        throw new Error("progress replay does not match an exact persisted event");
      }
      const sequence = Number(existing.sequence);
      return authorize({
        ...input,
        existingEvents: input.existingEvents.slice(0, sequence - 1),
      }, {
        event: structuredClone(input.candidate),
        eventJson: input.eventJson,
        eventSha256: String(input.candidate.eventSha256),
      });
    },
  });

  const store: ProgressEventCommitPort = Object.freeze({
    attach(identity: ProgressStoreIdentity) {
      if (attached && !sameIdentity(attached, identity)) {
        throw new Error("progress commit authority is already attached to another store identity");
      }
      attached = structuredClone(identity);
    },
    claim(input: AuthorizedProgressEvent, actualEvents: readonly JsonObject[]) {
      if (!attached) throw new Error("progress commit authority is not attached to a store");
      const state = authorizations.get(input as object);
      if (!state || !sameIdentity(state.identity, attached) ||
          state.eventJson !== input.eventJson || state.eventSha256 !== input.eventSha256 ||
          state.predecessorJson !== canonicalJson(actualEvents)) {
        throw new Error("progress event has no exact store-bound verification authority");
      }
      if (state.status !== "ready") {
        throw new Error("progress event commit authorization was already claimed or consumed");
      }
      state.status = "claimed";
      let settled = false;
      return Object.freeze({
        complete() {
          if (settled || state.status !== "claimed") throw new Error("progress event commit claim is not active");
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
  });
  return Object.freeze({ verifier, store });
}
