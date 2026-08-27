export interface PairProfileResult {
  matched: boolean;
  launchAllowed: boolean;
  classification: "harness_confounded" | null;
  mismatches: readonly string[];
}

type Arm = Record<string, unknown>;

const hashFields = [
  "promptHash",
  "seedPatchHash",
  "sourceTreeHash",
  "taskImageHash",
  "skillManifestHash",
  "functionalToolProfileHash",
  "nativeToolSemanticsHash",
  "systemInstructionHash",
  "projectInstructionHash",
  "environmentHash",
  "oracleHash",
] as const;

const numberFields = [
  "wallTimeoutMs",
  "outputLimitBytes",
  "diffLimitBytes",
  "maxFiles",
  "maxProcesses",
  "maxAttempts",
] as const;

const identityFields = ["provider", "model", "nativeToolManifestHash"] as const;

function arm(value: unknown): Arm {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Arm
    : {};
}

function validHash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function matchPairProfile(input: unknown): PairProfileResult {
  const pair = arm(input);
  const grok = arm(pair.grok);
  const codex = arm(pair.codex);
  const mismatches: string[] = [];

  if (grok.provider !== "grok") mismatches.push("grok.provider");
  if (codex.provider !== "codex") mismatches.push("codex.provider");
  if (grok.model !== "grok-4.6") mismatches.push("grok.model");
  if (codex.model !== "gpt-5.6-sol") mismatches.push("codex.model");
  if (!validHash(grok.nativeToolManifestHash)) mismatches.push("grok.nativeToolManifestHash");
  if (!validHash(codex.nativeToolManifestHash)) mismatches.push("codex.nativeToolManifestHash");

  const efforts = new Set(["medium", "high", "xhigh"]);
  if (typeof grok.effort !== "string" || !efforts.has(grok.effort) ||
      typeof codex.effort !== "string" || !efforts.has(codex.effort) ||
      grok.effort !== codex.effort) {
    mismatches.push("effort");
  }
  for (const field of hashFields) {
    if (!validHash(grok[field]) || !validHash(codex[field]) || grok[field] !== codex[field]) {
      mismatches.push(field);
    }
  }
  for (const field of numberFields) {
    if (typeof grok[field] !== "number" || !Number.isSafeInteger(grok[field]) || grok[field] <= 0 ||
        typeof codex[field] !== "number" || !Number.isSafeInteger(codex[field]) || codex[field] <= 0 ||
        grok[field] !== codex[field]) {
      mismatches.push(field);
    }
  }

  if (mismatches.length > 0) {
    return Object.freeze({
      matched: false,
      launchAllowed: false,
      classification: "harness_confounded",
      mismatches: Object.freeze([...mismatches]),
    });
  }
  return Object.freeze({
    matched: true,
    launchAllowed: true,
    classification: null,
    mismatches: Object.freeze([] as string[]),
  });
}

export interface PairParityReceipt extends PairProfileResult {
  version: "paired-parity-v1";
  profileHash: string;
  receiptHash: string;
}

function normalizedArm(value: unknown): Record<string, unknown> {
  const source = arm(value);
  return Object.fromEntries(
    [...identityFields, "effort", ...hashFields, ...numberFields]
      .map((field) => [field, source[field] ?? null]),
  );
}

export function createPairParityReceipt(input: unknown): PairParityReceipt {
  const pair = arm(input);
  const normalized = {
    grok: normalizedArm(pair.grok),
    codex: normalizedArm(pair.codex),
  };
  const profileHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const result = matchPairProfile(input);
  const receiptBody = {
    version: "paired-parity-v1" as const,
    profileHash,
    ...result,
    mismatches: Object.freeze([...result.mismatches]),
  };
  const receiptHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  return Object.freeze({ ...receiptBody, receiptHash });
}
import { createHash } from "node:crypto";
