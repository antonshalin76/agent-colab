import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/domain/canonical-json.js";
import {
  adoptReviewedV4SourceAcceptance,
  createSignedReviewedV4Promotion,
  requireReviewedV4SourceAcceptance,
} from "../src/migration/reviewed-v4-source-acceptance.js";
import { buildReviewedV4Promotion } from "../src/migration/reviewed-v4-promotion-builder.js";
import {
  createProgressFixture,
  removeProgressFixture,
  sha256,
  type ProgressFixture,
} from "./helpers/implementation-progress-fixture.js";
import {
  createTestReviewedV4Promotion,
  removeTestReviewedV4RemoteRef,
} from "./helpers/reviewed-v4-source-acceptance-fixture.js";

const ADOPTION_PATH = "migration-v4/source-acceptance/reviewed-source-adoption-v2.json";
const fixtures: ProgressFixture[] = [];
const scratch: string[] = [];

function fixture(): ProgressFixture {
  const value = createProgressFixture();
  fixtures.push(value);
  return value;
}

afterEach(() => {
  for (const value of fixtures.splice(0)) removeProgressFixture(value);
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => removeTestReviewedV4RemoteRef());

describe("reviewed v4 signed source promotion and target adoption", () => {
  it("builds and publishes a production promotion from a clean advertised checkout", () => {
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const root = mkdtempSync(join(tmpdir(), "agent-collab-promotion-builder-"));
    scratch.push(root);
    const checkout = join(root, "checkout");
    execFileSync("git", ["clone", "--quiet", packet.trust.remote.url, checkout]);
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", packet.source.commitOid]);
    const original = packet.promotion as unknown as {
      reviews: Array<{ artifact: unknown }>;
    };
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPath = join(root, "private.pem");
    const auditorReceiptPath = join(root, "auditor.json");
    const criticReceiptPath = join(root, "critic.json");
    const outputPath = join(root, "promotion.json");
    writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(auditorReceiptPath, JSON.stringify(original.reviews[0]!.artifact), { mode: 0o600 });
    writeFileSync(criticReceiptPath, JSON.stringify(original.reviews[1]!.artifact), { mode: 0o600 });

    const result = buildReviewedV4Promotion({
      repositoryRoot: checkout,
      remote: packet.trust.remote,
      privateKeyPath,
      auditorReceiptPath,
      criticReceiptPath,
      outputPath,
      promotionId: "builder-success",
      expiresAt: "2030-09-01T00:00:00.000Z",
      issuedAt: "2026-09-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      protocol: "reviewed-v4-promotion-build/v1",
      outputPath,
      sourceCommitOid: packet.source.commitOid,
    });
    expect(result.promotionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  }, 120_000);

  it("builds a canonical Ed25519 promotion from two exact review artifacts", () => {
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const generated = generateKeyPairSync("ed25519");
    const original = packet.promotion as unknown as {
      plan: { planId: string; planLockSha256: string };
      source: { commitOid: string; treeOid: string; manifestSha256: string; lastProgressEventSha256: string };
      remote: { canonicalUrl: string; refName: string; advertisedCommitOid: string };
      execution: {
        mode: "tsx-source"; entrypoint: "scripts/agent-collab-launcher.mjs";
        entrypointBlobOid: string; entrypointSha256: string; sourceRoot: "src"; distAllowed: false;
      };
      reviews: Array<{ artifact: unknown }>;
    };
    const bytes = createSignedReviewedV4Promotion({
      promotionId: "unit-signed-promotion",
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2030-09-01T00:00:00.000Z",
      plan: original.plan,
      source: original.source,
      remote: {
        url: original.remote.canonicalUrl,
        ref: original.remote.refName,
        advertisedCommitOid: original.remote.advertisedCommitOid,
      },
      execution: original.execution,
      reviewArtifacts: [original.reviews[0]!.artifact, original.reviews[1]!.artifact],
      privateKeyPem: generated.privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(bytes.toString("utf8")).toBe(`${canonicalJson(parsed)}\n`);
    expect(parsed).toMatchObject({
      schemaVersion: "reviewed-v4-promotion/v2",
      promotionId: "unit-signed-promotion",
      operationId: "stg04-production-close",
    });
    expect(parsed.promotionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.signatureBase64).toEqual(expect.any(String));
  });

  it("atomically adopts one signed promotion and replays without durable mutation", () => {
    const state = fixture();
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);

    const first = adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
      adoptedAt: "2026-09-02T00:00:00.000Z",
    });
    const before = readFileSync(first.receiptPath);
    const identity = statSync(first.receiptPath);
    const second = adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
      adoptedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(first).toMatchObject({ status: "accepted", created: true });
    expect(second).toEqual({ ...first, created: false });
    expect(readFileSync(first.receiptPath)).toEqual(before);
    expect(statSync(first.receiptPath).ino).toBe(identity.ino);
    expect(readdirSync(dirname(first.receiptPath)).sort()).toEqual(["reviewed-source-adoption-v2.json"]);
  }, 120_000);

  it.each([
    ["tampered signature", (draft: Record<string, unknown>) => { draft.promotionId = "changed"; }, false],
    ["duplicate review identity", (draft: Record<string, unknown>) => {
      const reviews = draft.reviews as Array<{ artifact: Record<string, unknown>; artifactSha256: string }>;
      reviews[1]!.artifact.role = "auditor";
      reviews[1]!.artifact.runId = reviews[0]!.artifact.runId;
      reviews[1]!.artifact.attemptId = reviews[0]!.artifact.attemptId;
      reviews[1]!.artifact.sessionId = reviews[0]!.artifact.sessionId;
      reviews[1]!.artifactSha256 = sha256(canonicalJson(reviews[1]!.artifact));
    }, true],
    ["non-PASS review", (draft: Record<string, unknown>) => {
      const reviews = draft.reviews as Array<{ artifact: Record<string, unknown>; artifactSha256: string }>;
      const verdict = reviews[0]!.artifact.reviewVerdict as Record<string, unknown>;
      verdict.verdict = "CHANGES_REQUESTED";
      verdict.findings = [{ risk_level: "high", message: "block" }];
      reviews[0]!.artifactSha256 = sha256(canonicalJson(reviews[0]!.artifact));
    }, true],
    ["future-issued promotion", (draft: Record<string, unknown>) => {
      draft.issuedAt = "2029-09-05T00:00:00.000Z";
    }, true],
  ] as const)("rejects %s before creating adoption", (_name, mutateDraft, resign) => {
    const state = fixture();
    const packet = createTestReviewedV4Promotion({ mutateDraft, resign });
    scratch.push(packet.directory);

    expect(() => adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
    })).toThrow(/promotion|signature|review|auditor|critic|PASS|invalid/i);
    expect(existsSync(join(state.stateRoot, ADOPTION_PATH))).toBe(false);
  }, 120_000);

  it("rejects a packet under a different configured Ed25519 key", () => {
    const state = fixture();
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(() => adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: { ...packet.trust, publicKeyPem: wrong },
    })).toThrow(/key|signature|promotion/i);
    expect(existsSync(join(state.stateRoot, ADOPTION_PATH))).toBe(false);
  });

  it("rejects a locally plausible packet when the allowlisted remote does not advertise the commit", () => {
    const state = fixture();
    const emptyRemote = mkdtempSync(join(tmpdir(), "agent-collab-empty-remote-"));
    scratch.push(emptyRemote);
    execFileSync("git", ["init", "--quiet", "--bare", emptyRemote]);
    const packet = createTestReviewedV4Promotion({
      remote: { url: emptyRemote, ref: "refs/heads/reviewed-v4-candidate" },
    });
    scratch.push(packet.directory);

    expect(() => adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
    })).toThrow(/remote|advertised|ref|commit/i);
    expect(existsSync(join(state.stateRoot, ADOPTION_PATH))).toBe(false);
  }, 120_000);

  it("rejects a symlinked external promotion", () => {
    const state = fixture();
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const link = join(packet.directory, "linked-promotion.json");
    symlinkSync(packet.promotionPath, link);

    expect(() => adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: link,
      trust: packet.trust,
    })).toThrow(/canonical|no-follow|regular|path/i);
  });

  it("binds adoption to one canonical root and database inode generation", () => {
    const firstState = fixture();
    const secondState = fixture();
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const adopted = adoptReviewedV4SourceAcceptance({
      stateRoot: firstState.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
    });
    const copied = join(secondState.stateRoot, ADOPTION_PATH);
    mkdirSync(dirname(copied), { recursive: true });
    copyFileSync(adopted.receiptPath, copied);

    expect(() => requireReviewedV4SourceAcceptance({
      stateRoot: secondState.stateRoot,
      adoptionSha256: adopted.receiptSha256,
      trust: packet.trust,
    })).toThrow(/target|identity|root|database|tampered/i);
  }, 120_000);

  it("detects immutable adoption tampering at consumption", () => {
    const state = fixture();
    const packet = createTestReviewedV4Promotion();
    scratch.push(packet.directory);
    const adopted = adoptReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
    });
    writeFileSync(adopted.receiptPath, Buffer.concat([readFileSync(adopted.receiptPath), Buffer.from(" ")]));

    expect(() => requireReviewedV4SourceAcceptance({
      stateRoot: state.stateRoot,
      adoptionSha256: adopted.receiptSha256,
      trust: packet.trust,
    })).toThrow(/adoption|tampered|canonical|invalid/i);
  }, 120_000);
});
