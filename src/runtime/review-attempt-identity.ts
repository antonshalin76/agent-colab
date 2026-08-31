import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

export type ReviewAttemptIdentityInput = {
  reviewId: string;
  barrierIdempotencyKey: string;
  agent: "grok" | "claude" | "codex";
  role: "auditor" | "critic";
  ordinal: number;
  legacySessionId?: string;
  legacyIdempotencyKey?: string;
};

export type ReviewAttemptIdentity = {
  attemptId: string;
  sessionId: string;
  idempotencyKey: string;
  canonicalIdentity: string;
};

const IDENTITY_SCHEMA_VERSION = "review-attempt-identity/v1";
const IDENTITY_DOMAIN = Buffer.from("agent-collab/review-attempt/v1\0", "utf8");

function uuidV8FromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createReviewAttemptIdentity(
  input: ReviewAttemptIdentityInput,
): ReviewAttemptIdentity {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error("review attempt ordinal must be a non-negative safe integer");
  }
  if (input.ordinal === 0 &&
      (input.legacySessionId === undefined || input.legacyIdempotencyKey === undefined)) {
    throw new Error("ordinal-zero review attempt identity requires committed legacy identity bytes");
  }

  const canonicalIdentity = canonicalize({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    reviewId: input.reviewId,
    barrierIdempotencyKey: input.barrierIdempotencyKey,
    agent: input.agent,
    role: input.role,
    ordinal: input.ordinal,
  });
  if (canonicalIdentity === undefined) {
    throw new Error("review attempt identity cannot be canonicalized");
  }

  const digest = createHash("sha256")
    .update(IDENTITY_DOMAIN)
    .update(canonicalIdentity, "utf8")
    .digest();
  const attemptId = uuidV8FromDigest(digest);

  return {
    attemptId,
    sessionId: input.ordinal === 0
      ? input.legacySessionId!
      : `review-attempt-${attemptId}`,
    idempotencyKey: input.ordinal === 0
      ? input.legacyIdempotencyKey!
      : `${input.barrierIdempotencyKey}:review-attempt:${digest.toString("hex")}`,
    canonicalIdentity,
  };
}
