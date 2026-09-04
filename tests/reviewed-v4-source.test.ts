import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REVIEWED_COMMIT,
  REVIEWED_FILES,
  REVIEWED_LAST_EVENT_SHA256,
  REVIEWED_TREE,
} from "./helpers/implementation-progress-fixture.js";

interface ReviewedFile {
  readonly path: string;
  readonly blobOid: string;
  readonly bytes: Buffer;
}

interface ReviewedSourceInput {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly files: readonly ReviewedFile[];
}

type VerifyReviewedSource = (input: ReviewedSourceInput) => {
  readonly status: "verified";
  readonly commitOid: string;
  readonly treeOid: string;
  readonly progressEventCount: number;
  readonly lastProgressEventSha256: string;
};

const repo = process.cwd();

async function loadVerifier(): Promise<VerifyReviewedSource> {
  const modulePath = pathToFileURL(resolve("src/flow/reviewed-v4-source.ts")).href;
  const module = await import(modulePath);
  return module.verifyReviewedV4Source as VerifyReviewedSource;
}

let cachedReviewedInput: ReviewedSourceInput | undefined;

function reviewedInput(): ReviewedSourceInput {
  if (cachedReviewedInput) return cloneInput(cachedReviewedInput);
  const inventory = new Map(execFileSync("git", [
    "-C", repo, "ls-tree", "-r", REVIEWED_COMMIT, "--", ...REVIEWED_FILES,
  ], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const match = line.match(/^\d+\s+blob\s+([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error(`unexpected reviewed tree entry: ${line}`);
    return [match[2]!, match[1]!] as const;
  }));
  cachedReviewedInput = {
    commitOid: REVIEWED_COMMIT,
    treeOid: execFileSync("git", ["-C", repo, "rev-parse", `${REVIEWED_COMMIT}^{tree}`], {
      encoding: "utf8",
    }).trim(),
    files: REVIEWED_FILES.map((path) => ({
      path,
      blobOid: inventory.get(path) ?? (() => { throw new Error(`missing reviewed file: ${path}`); })(),
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

const perFileMutations: SourceMutation[] = REVIEWED_FILES.flatMap((path, index) => [
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
    expect(verify(input)).toEqual({
      status: "verified",
      commitOid: REVIEWED_COMMIT,
      treeOid: REVIEWED_TREE,
      progressEventCount: 3,
      lastProgressEventSha256: REVIEWED_LAST_EVENT_SHA256,
    });
    expect(input).toEqual(before);
  });

  it.each([...identityMutations, ...perFileMutations])("rejects $name", async ({ mutate }) => {
    const verify = await loadVerifier();
    const input = reviewedInput();
    const attacked = mutate(cloneInput(input));
    expect(() => verify(attacked)).toThrow(/reviewed|source|identity|tree|manifest|inventory|blob|bytes|path|event/i);
  });
});
