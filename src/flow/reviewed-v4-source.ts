import { computeBytesSha256 } from "../domain/canonical-json.js";

export interface ReviewedV4File {
  readonly path: string;
  readonly blobOid: string;
  readonly bytes: Buffer;
}

export interface ReviewedV4SourceInput {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly files: readonly ReviewedV4File[];
}

export interface VerifiedReviewedV4Source {
  readonly status: "verified";
  readonly commitOid: string;
  readonly treeOid: string;
  readonly progressEventCount: 3;
  readonly lastProgressEventSha256: string;
}

export const REVIEWED_V4_COMMIT = "cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50" as const;
export const REVIEWED_V4_TREE = "955260b898f2465b72ecaabcb43b1453a15e3ebc" as const;
export const REVIEWED_V4_LAST_EVENT_SHA256 = "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469" as const;

const REVIEWED_FILES = [
  ["docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json", "57a66c90e854c8d12cfb9e32949fce358533e04c", "be79f9058a683313645f7353d6775fac76d0a72ca8b6a9457c88889f792e379e"],
  ["docs/hybrid-flow-v1-r2/PLAN_LOCK.json", "36a24097052d432eefb72f29fd7dc28659901de1", "c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf"],
  ["docs/hybrid-flow-v1-r2/stage-close/pre-v4/000001-r2-stg-00-pass.json", "0a304ee2bd66fe9cfc0e9117168d989775a437b1", "45c8482fe8b52d76d7b623220fe9c41c93e0973fe843c31b24c0578e7f309561"],
  ["docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json", "4d8e38c999d9502e6f7309baaf5d147b1e9acc95", "4793eb7b2978ea9842a3b5001936ac136be57f9484679a246f18606d4c6ef750"],
  ["docs/hybrid-flow-v1-r2/stage-close/pre-v4/000003-stg-02-pass.json", "a84543b45ce338da84b1146f87693841fd8d23fe", "2142a5f506cc8e4379f5c566b09c5b6579f5eb85ce809cc55e265869540a0137"],
  ["docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql", "96cd79e6eff7762a8473152fccfaa71ae21f66ca", "43ae43d139ac44f25d2132439600a5405c1082a8278aca60cffeab5e479ead8b"],
  ["scripts/verify-implementation-progress.mjs", "50b753ccc6004764d8f1b6961b7788b5ee8fe89a", "2fcb105a59163b1b65658da1aaf3d57f4171f6bc9c40d12d2f1bf5103b0c4006"],
  ["src/migration/coordinator.ts", "8fc885377c0da77d8a0ee8c45e1149fc5470f966", "448f8a55531ee72602cbaedc93be38b7fdb08ce113f84168d0b41622f9e04ffc"],
] as const;

export function verifyReviewedV4Source(input: ReviewedV4SourceInput): VerifiedReviewedV4Source {
  if (input.commitOid !== REVIEWED_V4_COMMIT || input.treeOid !== REVIEWED_V4_TREE) {
    throw new Error("reviewed v4 source identity does not match the accepted commit and tree");
  }
  if (!Array.isArray(input.files) || input.files.length !== REVIEWED_FILES.length) {
    throw new Error("reviewed v4 source inventory is incomplete or contains an unexpected event");
  }
  const seen = new Set<string>();
  for (const [index, [path, blobOid, bytesSha256]] of REVIEWED_FILES.entries()) {
    const file = input.files[index];
    if (!file || seen.has(file.path) || file.path !== path) {
      throw new Error("reviewed v4 source manifest path inventory is not exact");
    }
    seen.add(file.path);
    if (file.blobOid !== blobOid) throw new Error(`reviewed v4 source blob identity mismatch: ${path}`);
    if (!Buffer.isBuffer(file.bytes) || computeBytesSha256(file.bytes) !== bytesSha256) {
      throw new Error(`reviewed v4 source bytes mismatch: ${path}`);
    }
  }
  return Object.freeze({
    status: "verified",
    commitOid: REVIEWED_V4_COMMIT,
    treeOid: REVIEWED_V4_TREE,
    progressEventCount: 3,
    lastProgressEventSha256: REVIEWED_V4_LAST_EVENT_SHA256,
  });
}
