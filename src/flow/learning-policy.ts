import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StageIdSchema = z.string().regex(/^\d{2}_[a-z][a-z0-9_]*$/);
const ScenarioIdSchema = z.string().regex(/^BDD-\d{3}$/);
const OracleIdSchema = z.string().regex(/^ORACLE-\d{3}$/);
const ControlIdSchema = z.string().regex(/^CTRL-\d{3}$/);
const GuardIdSchema = z.string().regex(/^GUARD-\d{3}$/);
const OwnerIdSchema = z.string().regex(/^OWNER-\d{3}$/);
const EvidenceIdSchema = z.string().regex(/^EVID-\d{3,}$/);
const FindingIdSchema = z.string().regex(/^FIND-\d{3,}$/);
const ScopeSchema = z.enum([
  "local_component",
  "stage",
  "whole_feature",
  "whole_pr",
  "whole_stack",
]);
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const EvidenceReceiptSchema = z.object({
  schemaVersion: z.literal("evidence-receipt/v1"),
  id: EvidenceIdSchema,
  kind: z.enum([
    "test",
    "static_gate",
    "build",
    "remote_gate",
    "live_acceptance",
    "human_review",
    "artifact_validation",
  ]),
  purpose: z.enum([
    "general",
    "review_output",
    "authority_override",
    "code_or_artifact_fix",
    "old_code_sensitive_regression",
    "sibling_surface_scan",
  ]),
  stageId: StageIdSchema,
  oracleId: OracleIdSchema,
  scope: ScopeSchema,
  sourceFingerprint: Sha256Schema,
  artifactHash: Sha256Schema,
  command: z.array(z.string().min(1)).min(1).optional(),
  cwd: z.string().startsWith("/").optional(),
  exitCode: z.number().int().optional(),
  result: z.enum(["PASS", "FAIL", "SKIPPED"]),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  oldCodeSensitive: z.boolean(),
  skippedReason: z.string().min(1).optional(),
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "evidence time range is reversed" });
  }
  if (receipt.result === "SKIPPED" && receipt.skippedReason === undefined) {
    context.addIssue({ code: "custom", path: ["skippedReason"], message: "skipped evidence needs a reason" });
  }
  if (receipt.result !== "SKIPPED" && receipt.exitCode === undefined && receipt.kind !== "human_review") {
    context.addIssue({ code: "custom", path: ["exitCode"], message: "executed evidence needs an exit code" });
  }
  if (receipt.kind !== "human_review" && (receipt.command === undefined || receipt.cwd === undefined)) {
    context.addIssue({ code: "custom", path: ["command"], message: "executable evidence needs command and cwd" });
  }
  if (receipt.result === "PASS" && receipt.kind !== "human_review" && receipt.exitCode !== 0) {
    context.addIssue({ code: "custom", path: ["exitCode"], message: "PASS evidence requires exit code 0" });
  }
  if (receipt.result === "FAIL" && receipt.kind !== "human_review" && receipt.exitCode === 0) {
    context.addIssue({ code: "custom", path: ["exitCode"], message: "FAIL evidence cannot have exit code 0" });
  }
});

const RootCauseClassSchema = z.enum([
  "review_semantic_pass_bypass",
  "learning_control_fingerprint_bypass",
]);
const RegressionMutationSchema = z.enum([
  "MUTATION-REVIEW-SEMANTIC-PASS",
  "MUTATION-LEARNING-CONTROL-FINGERPRINT",
]);

export const FindingLifecycleSchema = z.object({
  schemaVersion: z.literal("finding-lifecycle/v1"),
  findingId: FindingIdSchema,
  classification: z.enum([
    "requirement_gap",
    "architecture_gap",
    "test_oracle_gap",
    "implementation_gap",
    "delivery_gap",
    "process_escape",
  ]),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  status: z.enum(["open", "closed"]),
  owningStage: StageIdSchema,
  affectedScenarioId: ScenarioIdSchema,
  affectedControlId: ControlIdSchema,
  rootCause: z.string().min(1).optional(),
  rootCauseClass: RootCauseClassSchema.optional(),
  escapeAnalysis: z.object({
    missedStage: StageIdSchema,
    escapedOracleId: OracleIdSchema,
    reason: z.string().min(1),
    testSystemOwnerId: OwnerIdSchema,
  }).strict().optional(),
  closure: z.object({
    fixEvidenceId: EvidenceIdSchema,
    regressionEvidenceId: EvidenceIdSchema,
    regressionMutationId: RegressionMutationSchema,
    preventionGuardId: GuardIdSchema,
    siblingScanEvidenceId: EvidenceIdSchema,
    invalidatedStageIds: z.array(StageIdSchema).min(1)
      .refine(unique, "invalidated stages must be unique"),
  }).strict().optional(),
}).strict().superRefine((finding, context) => {
  if (finding.status === "closed" && (
    finding.rootCause === undefined ||
    finding.rootCauseClass === undefined ||
    finding.escapeAnalysis === undefined ||
    finding.closure === undefined
  )) {
    context.addIssue({
      code: "custom",
      message: "closed finding requires typed root cause, escape analysis, and complete closure evidence",
    });
  }
});

export interface CanonicalFindingExecutorDescriptor {
  oracleId: "ORACLE-006" | "ORACLE-010";
  controlId: "CTRL-009" | "CTRL-014";
  scenarioId: "BDD-005" | "BDD-007";
  stageId: "60_independent_review" | "90_learning_close";
  ownerId: "OWNER-005" | "OWNER-007";
  guardId: "GUARD-009" | "GUARD-010";
  allowedInvalidatedStageIds: readonly string[];
  rootCauseClass: z.infer<typeof RootCauseClassSchema>;
  mutationId: z.infer<typeof RegressionMutationSchema>;
}

export const CANONICAL_FINDING_EXECUTOR_REGISTRY = Object.freeze({
  "ORACLE-006:CTRL-009": Object.freeze({
    oracleId: "ORACLE-006",
    controlId: "CTRL-009",
    scenarioId: "BDD-005",
    stageId: "60_independent_review",
    ownerId: "OWNER-005",
    guardId: "GUARD-009",
    allowedInvalidatedStageIds: Object.freeze([
      "60_independent_review",
      "70_publish_remote_gates",
      "80_integrated_acceptance",
      "90_learning_close",
    ]),
    rootCauseClass: "review_semantic_pass_bypass",
    mutationId: "MUTATION-REVIEW-SEMANTIC-PASS",
  }),
  "ORACLE-010:CTRL-014": Object.freeze({
    oracleId: "ORACLE-010",
    controlId: "CTRL-014",
    scenarioId: "BDD-007",
    stageId: "90_learning_close",
    ownerId: "OWNER-007",
    guardId: "GUARD-010",
    allowedInvalidatedStageIds: Object.freeze(["90_learning_close"]),
    rootCauseClass: "learning_control_fingerprint_bypass",
    mutationId: "MUTATION-LEARNING-CONTROL-FINGERPRINT",
  }),
} satisfies Record<string, CanonicalFindingExecutorDescriptor>);

export const CLOSABLE_FINDING_EXECUTOR_CLASSES = Object.freeze(
  Object.keys(CANONICAL_FINDING_EXECUTOR_REGISTRY),
);

export const APPROVED_LEARNING_CONTROL_IDS = Object.freeze(
  Object.values(CANONICAL_FINDING_EXECUTOR_REGISTRY).map(({ controlId }) => controlId),
);

export function canonicalFindingExecutorDescriptor(
  oracleId: string,
  controlId: string,
): CanonicalFindingExecutorDescriptor | null {
  const key = `${oracleId}:${controlId}` as keyof typeof CANONICAL_FINDING_EXECUTOR_REGISTRY;
  return CANONICAL_FINDING_EXECUTOR_REGISTRY[key] ?? null;
}

export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
export type FindingLifecycle = z.infer<typeof FindingLifecycleSchema>;

export function validateFindingLifecycle(
  evidenceInputs: readonly unknown[],
  findingInput: unknown,
): FindingLifecycle {
  const receipts = evidenceInputs.map((receipt) => EvidenceReceiptSchema.parse(receipt));
  if (!unique(receipts.map(({ id }) => id))) throw new Error("evidence receipt ids must be unique");
  const finding = FindingLifecycleSchema.parse(findingInput);
  if (finding.status === "open") return finding;

  const { closure, escapeAnalysis } = finding;
  const descriptor = canonicalFindingExecutorDescriptor(
    escapeAnalysis!.escapedOracleId,
    finding.affectedControlId,
  );
  if (!descriptor) {
    throw new Error("finding oracle/control defect class has no code-owned closure executor and must remain open");
  }
  if (
    finding.affectedScenarioId !== descriptor.scenarioId ||
    finding.owningStage !== descriptor.stageId ||
    escapeAnalysis!.missedStage !== descriptor.stageId ||
    escapeAnalysis!.testSystemOwnerId !== descriptor.ownerId
  ) {
    throw new Error("finding scenario, stage, and test-system owner are not causally aligned");
  }
  if (finding.rootCauseClass !== descriptor.rootCauseClass) {
    throw new Error("finding root-cause class does not match the canonical oracle/control executor");
  }
  if (closure!.regressionMutationId !== descriptor.mutationId) {
    throw new Error("finding regression mutation does not match the canonical oracle/control executor");
  }
  if (closure!.preventionGuardId !== descriptor.guardId ||
      !closure!.invalidatedStageIds.includes(descriptor.stageId) ||
      closure!.invalidatedStageIds.some((stageId) =>
        !descriptor.allowedInvalidatedStageIds.includes(stageId))) {
    throw new Error("finding prevention and invalidation do not match the canonical executor class");
  }
  if (!unique([
    closure!.fixEvidenceId,
    closure!.regressionEvidenceId,
    closure!.siblingScanEvidenceId,
  ])) throw new Error("finding closure evidence roles require distinct receipts");

  const evidence = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const fix = evidence.get(closure!.fixEvidenceId);
  const regression = evidence.get(closure!.regressionEvidenceId);
  const sibling = evidence.get(closure!.siblingScanEvidenceId);
  if (fix?.result !== "PASS" || regression?.result !== "PASS" || sibling?.result !== "PASS") {
    throw new Error("finding closure evidence must exist and PASS");
  }
  if (
    fix.sourceFingerprint !== regression.sourceFingerprint ||
    fix.sourceFingerprint !== sibling.sourceFingerprint ||
    fix.artifactHash !== regression.artifactHash ||
    fix.artifactHash !== sibling.artifactHash
  ) throw new Error("finding closure evidence must bind one exact packet");
  if (fix.purpose !== "code_or_artifact_fix" ||
      regression.purpose !== "old_code_sensitive_regression" ||
      sibling.purpose !== "sibling_surface_scan" ||
      !regression.oldCodeSensitive ||
      [fix, regression, sibling].some((receipt) =>
        receipt.stageId !== descriptor.stageId || receipt.oracleId !== descriptor.oracleId)) {
    throw new Error("finding evidence does not match its canonical executor class");
  }
  return finding;
}
