export interface BlindCandidateInput {
  readonly opaqueLabel: string;
  readonly artifactHash: string;
  readonly visibleText: string;
  readonly patch: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BlindJudgePacket {
  readonly opaqueLabel: string;
  readonly artifactHash: string;
  readonly visibleText: string;
  readonly patch: string;
}

const identityKey = /provider|model|session|(?:^|_)path|path$|author|order/i;

const collectIdentitySentinels = (
  value: unknown,
  key = "",
  output = new Set<string>(),
): Set<string> => {
  if (typeof value === "string" && identityKey.test(key) && value.length >= 2) {
    output.add(value);
    if (value.startsWith("/")) output.add(value.slice(1));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIdentitySentinels(item, key, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectIdentitySentinels(nestedValue, nestedKey, output);
    }
  }
  return output;
};

export const createBlindJudgePacket = (
  input: BlindCandidateInput,
): Readonly<BlindJudgePacket> => {
  const judgeContent = `${input.visibleText}\n${input.patch}`.toLocaleLowerCase("en-US");
  for (const sentinel of collectIdentitySentinels(input.metadata)) {
    if (judgeContent.includes(sentinel.toLocaleLowerCase("en-US"))) {
      throw new Error("blind packet contains identity metadata or path sentinel");
    }
  }
  return Object.freeze({
    opaqueLabel: input.opaqueLabel,
    artifactHash: input.artifactHash,
    visibleText: input.visibleText,
    patch: input.patch,
  });
};
