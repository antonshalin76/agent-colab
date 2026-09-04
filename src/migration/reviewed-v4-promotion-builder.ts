import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { captureReviewedV4PromotionSource, type ReviewedV4RemoteTrust } from "../flow/reviewed-v4-source.js";
import { createSignedReviewedV4Promotion } from "./reviewed-v4-source-acceptance.js";

const SHA256 = /^[a-f0-9]{64}$/;

function readPinnedFile(path: string, label: string, requirePrivateMode = false): Buffer {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${label} path must be absolute, canonical and no-follow`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    const expectedUid = process.getuid?.();
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 ||
        current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino ||
        (requirePrivateMode && ((opened.mode & 0o777) !== 0o600 ||
          (expectedUid !== undefined && opened.uid !== expectedUid)))) {
      throw new Error(`${label} identity or mode is invalid`);
    }
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function parseObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is malformed`, { cause: error }); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function publishExclusive(path: string, bytes: Buffer): void {
  if (!isAbsolute(path) || resolve(path) !== path || existsSync(path)) {
    throw new Error("reviewed v4 promotion output must be an absent absolute canonical path");
  }
  const parent = dirname(path);
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) {
    throw new Error("reviewed v4 promotion output parent must be a canonical real directory");
  }
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    linkSync(temporary, path);
    unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve publication error */ }
    throw error;
  } finally { closeSync(descriptor); }
}

export function buildReviewedV4Promotion(input: {
  readonly repositoryRoot: string;
  readonly remote: ReviewedV4RemoteTrust;
  readonly privateKeyPath: string;
  readonly auditorReceiptPath: string;
  readonly criticReceiptPath: string;
  readonly outputPath: string;
  readonly promotionId: string;
  readonly expiresAt: string;
  readonly issuedAt?: string;
}): {
  readonly protocol: "reviewed-v4-promotion-build/v1";
  readonly outputPath: string;
  readonly promotionSha256: string;
  readonly sourceCommitOid: string;
} {
  const repositoryRoot = realpathSync(resolve(input.repositoryRoot));
  const snapshot = captureReviewedV4PromotionSource({ repositoryRoot, remote: input.remote });
  const planLockBytes = readPinnedFile(
    join(repositoryRoot, "docs/hybrid-flow-v1-r2/PLAN_LOCK.json"),
    "reviewed v4 plan lock",
  );
  const planLock = parseObject(planLockBytes, "reviewed v4 plan lock");
  if (typeof planLock.planId !== "string" || !planLock.planId) {
    throw new Error("reviewed v4 plan lock has no plan identity");
  }
  const bytes = createSignedReviewedV4Promotion({
    promotionId: input.promotionId,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    plan: {
      planId: planLock.planId,
      planLockSha256: createHash("sha256").update(planLockBytes).digest("hex"),
    },
    source: snapshot.sourceIdentity,
    remote: { ...input.remote, advertisedCommitOid: snapshot.sourceIdentity.commitOid },
    execution: snapshot.execution,
    reviewArtifacts: [
      parseObject(readPinnedFile(input.auditorReceiptPath, "Codex auditor receipt"), "Codex auditor receipt"),
      parseObject(readPinnedFile(input.criticReceiptPath, "Codex critic receipt"), "Codex critic receipt"),
    ],
    privateKeyPem: readPinnedFile(input.privateKeyPath, "reviewed v4 promotion private key", true),
  });
  const promotion = parseObject(bytes, "reviewed v4 promotion");
  if (typeof promotion.promotionSha256 !== "string" || !SHA256.test(promotion.promotionSha256)) {
    throw new Error("reviewed v4 promotion builder produced no digest");
  }
  publishExclusive(input.outputPath, bytes);
  return Object.freeze({
    protocol: "reviewed-v4-promotion-build/v1" as const,
    outputPath: input.outputPath,
    promotionSha256: promotion.promotionSha256,
    sourceCommitOid: snapshot.sourceIdentity.commitOid,
  });
}
