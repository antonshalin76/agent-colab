import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import canonicalize from "canonicalize";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REVIEWED_COMMIT,
  REVIEWED_LAST_EVENT_SHA256,
  REVIEWED_TREE,
} from "./helpers/implementation-progress-fixture.js";

interface ReviewedFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly blobOid: string;
  readonly bytes: Buffer;
}

interface ReviewedSourceInput {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly files: readonly ReviewedFile[];
}

type VerifyReviewedSource = (input: ReviewedSourceInput, expected: {
  commitOid: string;
  treeOid: string;
  manifestSha256: string;
  lastProgressEventSha256: string;
}) => {
  readonly status: "verified";
  readonly commitOid: string;
  readonly treeOid: string;
  readonly manifestSha256: string;
  readonly progressEventCount: number;
  readonly lastProgressEventSha256: string;
};

const repo = process.cwd();
const REQUIRED_ARTIFACTS = new Set([
  "package.json",
  "package-lock.json",
  "scripts/agent-collab-launcher.mjs",
  "systemd/agent-collab.service",
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
]);
const included = (path: string): boolean =>
  (path.startsWith("src/") && path.endsWith(".ts")) ||
  REQUIRED_ARTIFACTS.has(path);

async function loadVerifier(): Promise<VerifyReviewedSource> {
  const modulePath = pathToFileURL(resolve("src/flow/reviewed-v4-source.ts")).href;
  const module = await import(modulePath);
  return module.verifyReviewedV4Source as VerifyReviewedSource;
}

let cachedReviewedInput: ReviewedSourceInput | undefined;

function reviewedInput(): ReviewedSourceInput {
  if (cachedReviewedInput) return cloneInput(cachedReviewedInput);
  const inventory = execFileSync("git", [
    "-C", repo, "ls-tree", "-r", REVIEWED_COMMIT,
  ], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const match = line.match(/^(100644|100755)\s+blob\s+([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error(`unexpected reviewed tree entry: ${line}`);
    return { mode: match[1] as ReviewedFile["mode"], path: match[3]!, blobOid: match[2]! };
  }).filter(({ path }) => included(path));
  cachedReviewedInput = {
    commitOid: REVIEWED_COMMIT,
    treeOid: execFileSync("git", ["-C", repo, "rev-parse", `${REVIEWED_COMMIT}^{tree}`], {
      encoding: "utf8",
    }).trim(),
    files: inventory.map(({ path, mode, blobOid }) => ({
      path,
      mode,
      blobOid,
      bytes: execFileSync("git", ["-C", repo, "show", `${REVIEWED_COMMIT}:${path}`]),
    })),
  };
  return cloneInput(cachedReviewedInput);
}

function cloneInput(input: ReviewedSourceInput): ReviewedSourceInput {
  return {
    ...input,
    files: input.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
  };
}

function expected(input: ReviewedSourceInput) {
  const manifest = input.files.map(({ path, mode, blobOid, bytes }) => ({
    path,
    mode,
    blobOid,
    bytesSha256: createHash("sha256").update(bytes).digest("hex"),
  }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const encoded = canonicalize(manifest);
  if (encoded === undefined) throw new Error("test manifest is not canonical JSON");
  return {
    commitOid: REVIEWED_COMMIT,
    treeOid: REVIEWED_TREE,
    manifestSha256: createHash("sha256").update(encoded).digest("hex"),
    lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
  };
}

type SourceMutation = {
  readonly name: string;
  readonly mutate: (input: ReviewedSourceInput) => ReviewedSourceInput;
};

const identityMutations: SourceMutation[] = [
  { name: "wrong commit", mutate: (input) => ({ ...input, commitOid: "0".repeat(40) }) },
  { name: "wrong tree", mutate: (input) => ({ ...input, treeOid: "f".repeat(40) }) },
  {
    name: "unexpected fourth event",
    mutate: (input) => ({
      ...input,
      files: [...input.files, {
        path: "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000004-stg-03-pass.json",
        mode: "100644",
        blobOid: "1".repeat(40),
        bytes: Buffer.from("{}\n"),
      }],
    }),
  },
  {
    name: "duplicate manifest entry",
    mutate: (input) => ({ ...input, files: [...input.files, { ...input.files[0]!, bytes: Buffer.from(input.files[0]!.bytes) }] }),
  },
];

const perFileMutations: SourceMutation[] = reviewedInput().files.flatMap(({ path }, index) => [
  {
    name: `changed mode ${path}`,
    mutate: (input) => ({
      ...input,
      files: input.files.map((file, candidate) => candidate === index
        ? { ...file, mode: file.mode === "100644" ? "100755" : "100644" }
        : file),
    }),
  },
  {
    name: `missing ${path}`,
    mutate: (input) => ({ ...input, files: input.files.filter((_, candidate) => candidate !== index) }),
  },
  {
    name: `changed path ${path}`,
    mutate: (input) => ({
      ...input,
      files: input.files.map((file, candidate) => candidate === index ? { ...file, path: `${file.path}.moved` } : file),
    }),
  },
  {
    name: `changed blob oid ${path}`,
    mutate: (input) => ({
      ...input,
      files: input.files.map((file, candidate) => candidate === index ? { ...file, blobOid: "e".repeat(40) } : file),
    }),
  },
  {
    name: `changed bytes ${path}`,
    mutate: (input) => ({
      ...input,
      files: input.files.map((file, candidate) => candidate === index
        ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from("tampered")]) }
        : file),
    }),
  },
]);

describe("pure reviewed state-v4 source verifier", () => {
  it("accepts only the exact reviewed commit/tree/file bytes and leaves input untouched", async () => {
    const verify = await loadVerifier();
    const input = reviewedInput();
    const before = cloneInput(input);
    expect(input.treeOid).toBe(REVIEWED_TREE);
    const acceptance = expected(input);
    expect(verify(input, acceptance)).toEqual({
      status: "verified",
      commitOid: REVIEWED_COMMIT,
      treeOid: REVIEWED_TREE,
      manifestSha256: acceptance.manifestSha256,
      progressEventCount: 3,
      lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
    });
    expect(input).toEqual(before);
  });

  it.each([...identityMutations, ...perFileMutations])("rejects $name", async ({ mutate }) => {
    const verify = await loadVerifier();
    const input = reviewedInput();
    const attacked = mutate(cloneInput(input));
    expect(() => verify(attacked, expected(input))).toThrow(/reviewed|source|identity|tree|manifest|inventory|blob|bytes|path|event/i);
  });
});
