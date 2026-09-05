import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../../src/domain/canonical-json.js";
import { reviewedV4ManifestSha256 } from "../../src/flow/reviewed-v4-source.js";
import {
  adoptReviewedV4SourceAcceptance,
  type ReviewedV4PromotionTrust,
} from "../../src/migration/reviewed-v4-source-acceptance.js";

const repositoryRoot = resolve(".");
const remoteRef = "refs/heads/reviewed-v4-candidate";
const lastProgressEventSha256 = "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469";
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const keyId = createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

let remoteRoot: string | undefined;
const adoptedByStateRoot = new Map<string, string>();
let cachedSource: {
  commitOid: string;
  treeOid: string;
  manifestSha256: string;
  lastProgressEventSha256: string;
  entrypointBlobOid: string;
  entrypointSha256: string;
} | undefined;

function testRemote(): string {
  if (remoteRoot) return remoteRoot;
  remoteRoot = mkdtempSync(join(tmpdir(), "agent-collab-reviewed-remote-"));
  execFileSync("git", ["init", "--quiet", "--bare", remoteRoot]);
  return remoteRoot;
}

function candidateSource() {
  if (cachedSource) return cachedSource;
  const temporary = mkdtempSync(join(tmpdir(), "agent-collab-source-index-"));
  const index = join(temporary, "index");
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "agent-collab test",
    GIT_AUTHOR_EMAIL: "agent-collab-test@invalid",
    GIT_COMMITTER_NAME: "agent-collab test",
    GIT_COMMITTER_EMAIL: "agent-collab-test@invalid",
  };
  try {
    execFileSync("git", ["-C", repositoryRoot, "read-tree", "HEAD"], { env: environment });
    execFileSync("git", ["-C", repositoryRoot, "add", "-A", "--", "src", "package.json",
      "package-lock.json", "scripts/agent-collab-launcher.mjs", "systemd/agent-collab.service",
      "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql",
      "docs/hybrid-flow-v1-r2"], { env: environment });
    const treeOid = execFileSync("git", ["-C", repositoryRoot, "write-tree"], {
      env: environment, encoding: "utf8",
    }).trim();
    const commitOid = execFileSync("git", ["-C", repositoryRoot, "commit-tree", treeOid, "-p", "HEAD",
      "-m", "test: reviewed v4 source candidate"], { env: environment, encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repositoryRoot, "push", "--quiet", "--force", testRemote(),
      `${commitOid}:${remoteRef}`]);
    const rows = execFileSync("git", ["-C", repositoryRoot, "ls-tree", "-r", commitOid], {
      encoding: "utf8",
    }).trim().split("\n").map((row) => {
      const match = row.match(/^(100644|100755)\s+blob\s+([a-f0-9]{40})\t(.+)$/);
      if (!match) throw new Error("test source tree entry is malformed");
      return { mode: match[1] as "100644" | "100755", blobOid: match[2]!, path: match[3]! };
    }).filter(({ path }) => (path.startsWith("src/") && path.endsWith(".ts")) || [
      "package.json", "package-lock.json", "scripts/agent-collab-launcher.mjs", "systemd/agent-collab.service",
      "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql",
      "docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json",
      "docs/hybrid-flow-v1-r2/PLAN_LOCK.json",
      "docs/hybrid-flow-v1-r2/STATE_V4_PROGRESS_SEED.json",
      "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000001-r2-stg-00-pass.json",
      "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json",
      "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000003-stg-02-pass.json",
      "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000004-stg-03-pass.json",
      "docs/hybrid-flow-v1-r2/amendments/AMD-0001.json",
      "docs/hybrid-flow-v1-r2/amendments/AMD-0001-authority.json",
      "docs/hybrid-flow-v1-r2/amendments/evidence/architecture-slice.md",
      "docs/hybrid-flow-v1-r2/stage-close/STG-03-source-manifest.json",
    ].includes(path));
    const files = rows.map((row) => ({ ...row, bytes: readFileSync(join(repositoryRoot, row.path)) }));
    const entrypoint = files.find(({ path }) => path === "scripts/agent-collab-launcher.mjs");
    if (!entrypoint) throw new Error("test source has no launcher entrypoint");
    cachedSource = {
      commitOid,
      treeOid,
      manifestSha256: reviewedV4ManifestSha256(files),
      lastProgressEventSha256,
      entrypointBlobOid: entrypoint.blobOid,
      entrypointSha256: sha256(readFileSync(join(repositoryRoot, entrypoint.path))),
    };
    return cachedSource;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function reviewedV4TestTrust(): ReviewedV4PromotionTrust {
  return {
    publicKeyPem,
    repositoryRoot,
    remote: { url: testRemote(), ref: remoteRef },
  };
}

export function createTestReviewedV4Promotion(input: {
  readonly mutateDraft?: (draft: Record<string, unknown>) => void;
  readonly resign?: boolean;
  readonly remote?: { readonly url: string; readonly ref: string };
} = {}) {
  const source = candidateSource();
  const remote = input.remote ?? { url: testRemote(), ref: remoteRef };
  const review = (role: "auditor" | "critic", ordinal: number) => {
    const artifact = {
      schemaVersion: "review-receipt/v2",
      agent: "codex",
      role,
      runId: `codex-${role}-run-${ordinal}`,
      attemptId: `codex-${role}-attempt-${ordinal}`,
      sessionId: `codex-${role}-session-${ordinal}`,
      sourceIdentity: {
        commitOid: source.commitOid,
        treeOid: source.treeOid,
        manifestSha256: source.manifestSha256,
      },
      reviewVerdict: { schemaVersion: "review-verdict/v1", verdict: "PASS", findings: [] },
    };
    return { artifact, artifactSha256: sha256(canonicalJson(artifact)) };
  };
  const planLockBytes = readFileSync(join(repositoryRoot, "docs/hybrid-flow-v1-r2/PLAN_LOCK.json"));
  const planLock = JSON.parse(planLockBytes.toString("utf8")) as { planId: string };
  const draft: Record<string, unknown> = {
    schemaVersion: "reviewed-v4-promotion/v2",
    promotionId: "reviewed-v4-production-candidate",
    keyId,
    operationId: "stg04-production-close",
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2030-09-05T00:00:00.000Z",
    plan: { planId: planLock.planId, planLockSha256: sha256(planLockBytes) },
    source: { ...source, entrypointBlobOid: undefined, entrypointSha256: undefined },
    remote: { canonicalUrl: remote.url, refName: remote.ref, advertisedCommitOid: source.commitOid },
    execution: {
      mode: "tsx-source",
      entrypoint: "scripts/agent-collab-launcher.mjs",
      entrypointBlobOid: source.entrypointBlobOid,
      entrypointSha256: source.entrypointSha256,
      sourceRoot: "src",
      distAllowed: false,
    },
    reviews: [review("auditor", 1), review("critic", 2)],
  };
  const sourceDraft = draft.source as Record<string, unknown>;
  delete sourceDraft.entrypointBlobOid;
  delete sourceDraft.entrypointSha256;
  input.mutateDraft?.(draft);
  const promotionSha256 = sha256(canonicalJson(draft));
  const signatureBase64 = sign(null, Buffer.from(canonicalJson({ ...draft, promotionSha256 })), keys.privateKey)
    .toString("base64");
  const promotion = { ...draft, promotionSha256, signatureBase64 };
  if (input.mutateDraft && input.resign === false) {
    (promotion as Record<string, unknown>).promotionId = "tampered-after-signing";
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-collab-source-promotion-"));
  const promotionPath = join(directory, "reviewed-v4-promotion.json");
  writeFileSync(promotionPath, `${canonicalJson(promotion)}\n`, { mode: 0o600 });
  return {
    directory,
    promotionPath,
    promotion,
    source,
    trust: { publicKeyPem, repositoryRoot, remote },
  };
}

export function adoptTestReviewedV4SourceAcceptance(stateRoot: string): string {
  const existing = adoptedByStateRoot.get(stateRoot);
  if (existing) return existing;
  const packet = createTestReviewedV4Promotion();
  try {
    const adoptionSha256 = adoptReviewedV4SourceAcceptance({
      stateRoot,
      externalPromotionPath: packet.promotionPath,
      trust: packet.trust,
    }).receiptSha256;
    adoptedByStateRoot.set(stateRoot, adoptionSha256);
    return adoptionSha256;
  } finally {
    rmSync(packet.directory, { recursive: true, force: true });
  }
}

export function removeTestReviewedV4RemoteRef(): void {
  if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  remoteRoot = undefined;
  cachedSource = undefined;
  adoptedByStateRoot.clear();
}
