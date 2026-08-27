import { z } from "zod";
import { hashCanonicalJson } from "./run-manifest.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const certificationStages = ["harness", "providers", "canary"] as const;
export type CertificationStage = typeof certificationStages[number];

export const requiredCertificationChecks = Object.freeze({
  harness: Object.freeze([
    "corpus_and_source_locks",
    "shared_skill_freeze",
    "provider_command_contracts",
    "provider_output_normalization",
    "containment_boundaries",
    "timeout_and_process_cleanup",
    "output_diff_file_process_budgets",
    "cpp_oracle_runtime",
    "python_oracle_runtime",
    "cli_json_transport",
    "terminal_persistence_and_resume",
    "blind_mapping_and_scoring",
    "failure_classification",
  ]),
  providers: Object.freeze([
    "codex_identity_and_effort",
    "codex_read_search_edit_test",
    "codex_shared_skill_access",
    "codex_protocol_and_telemetry",
    "grok_identity_and_effort",
    "grok_read_search_edit_test",
    "grok_shared_skill_access",
    "grok_protocol_and_telemetry",
    "provider_tool_network_denial",
    "source_immutability",
    "provider_isolation_and_cleanup",
  ]),
  canary: Object.freeze([
    "single_paired_cell_only",
    "manifest_and_arm_parity",
    "both_attempts_terminal",
    "source_immutability",
    "blind_mapping_sealed",
    "hidden_oracle_gating",
    "no_harness_failure",
  ]),
} satisfies Readonly<Record<CertificationStage, readonly string[]>>);

export const CertificationBindingSchema = z.object({
  version: z.literal("agent-collab-eval-binding-v1"),
  harnessImplementationHash: sha256,
  corpusHash: sha256,
  suiteHash: sha256,
  evaluatorImplementationHash: sha256,
  skillBundleHash: sha256,
  functionalToolProfileHash: sha256,
  environmentContractHash: sha256,
  providerCommandProfileHash: sha256,
  sourceReceiptsHash: sha256,
  machineProfileHash: sha256,
}).strict();

export type CertificationBinding = z.infer<typeof CertificationBindingSchema>;

const CertificationCheckSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  evidenceHash: sha256,
  detail: z.string().min(1).max(500),
}).strict();

const CertificationReceiptBodySchema = z.object({
  version: z.literal("agent-collab-eval-certification-v1"),
  stage: z.enum(certificationStages),
  status: z.enum(["passed", "failed"]),
  createdAt: z.string().datetime({ offset: true }),
  binding: CertificationBindingSchema,
  prerequisiteReceiptHashes: z.array(sha256),
  checks: z.array(CertificationCheckSchema).min(1),
}).strict();

export const CertificationReceiptSchema = CertificationReceiptBodySchema.extend({
  receiptHash: sha256,
}).strict();

export type CertificationCheck = z.infer<typeof CertificationCheckSchema>;
export type CertificationReceipt = z.infer<typeof CertificationReceiptSchema>;

function canonicalChecks(
  stage: CertificationStage,
  input: readonly CertificationCheck[],
): CertificationCheck[] {
  const checks = input.map((check) => CertificationCheckSchema.parse(check));
  const required = requiredCertificationChecks[stage];
  const ids = checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) throw new Error("certification check ids must be unique");
  const missing = required.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !required.includes(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `certification check set mismatch: missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  return [...checks].sort((left, right) => left.id.localeCompare(right.id));
}

export function createCertificationReceipt(input: {
  stage: CertificationStage;
  createdAt: string;
  binding: CertificationBinding;
  prerequisiteReceiptHashes: readonly string[];
  checks: readonly CertificationCheck[];
}): CertificationReceipt {
  const checks = canonicalChecks(input.stage, input.checks);
  const body = CertificationReceiptBodySchema.parse({
    version: "agent-collab-eval-certification-v1",
    stage: input.stage,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    createdAt: input.createdAt,
    binding: input.binding,
    prerequisiteReceiptHashes: [...input.prerequisiteReceiptHashes],
    checks,
  });
  return Object.freeze({ ...body, receiptHash: hashCanonicalJson(body) });
}

export function validateCertificationReceipt(input: {
  receipt: unknown;
  expectedStage: CertificationStage;
  expectedBinding: CertificationBinding;
  expectedPrerequisiteReceiptHashes: readonly string[];
  requirePassed?: boolean;
}): CertificationReceipt {
  const receipt = CertificationReceiptSchema.parse(input.receipt);
  const { receiptHash: _, ...body } = receipt;
  if (hashCanonicalJson(CertificationReceiptBodySchema.parse(body)) !== receipt.receiptHash) {
    throw new Error("certification receipt hash mismatch");
  }
  if (receipt.stage !== input.expectedStage) throw new Error("certification stage mismatch");
  if (hashCanonicalJson(receipt.binding) !== hashCanonicalJson(input.expectedBinding)) {
    throw new Error("certification binding mismatch");
  }
  if (JSON.stringify(receipt.prerequisiteReceiptHashes) !==
      JSON.stringify(input.expectedPrerequisiteReceiptHashes)) {
    throw new Error("certification prerequisite chain mismatch");
  }
  canonicalChecks(receipt.stage, receipt.checks);
  const derivedStatus = receipt.checks.every((check) => check.passed) ? "passed" : "failed";
  if (receipt.status !== derivedStatus) throw new Error("certification status does not match its checks");
  if (input.requirePassed !== false && receipt.status !== "passed") {
    throw new Error(`${receipt.stage} certification did not pass`);
  }
  return Object.freeze(receipt);
}

export function validateCertificationChain(input: {
  binding: CertificationBinding;
  harness: unknown;
  providers?: unknown;
  canary?: unknown;
}): Readonly<{
  harness: CertificationReceipt;
  providers?: CertificationReceipt;
  canary?: CertificationReceipt;
}> {
  const harness = validateCertificationReceipt({
    receipt: input.harness,
    expectedStage: "harness",
    expectedBinding: input.binding,
    expectedPrerequisiteReceiptHashes: [],
  });
  if (input.providers === undefined) return Object.freeze({ harness });
  const providers = validateCertificationReceipt({
    receipt: input.providers,
    expectedStage: "providers",
    expectedBinding: input.binding,
    expectedPrerequisiteReceiptHashes: [harness.receiptHash],
  });
  if (input.canary === undefined) return Object.freeze({ harness, providers });
  const canary = validateCertificationReceipt({
    receipt: input.canary,
    expectedStage: "canary",
    expectedBinding: input.binding,
    expectedPrerequisiteReceiptHashes: [harness.receiptHash, providers.receiptHash],
  });
  return Object.freeze({ harness, providers, canary });
}
