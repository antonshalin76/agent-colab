import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectId = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

const RubricCheckSchema = z.object({
  id: z.string().min(1),
  weight: z.number().int().min(1).max(100),
  hardGate: z.boolean(),
  command: z.array(z.string().min(1)).min(1).optional(),
  evaluator: z.string().min(1).optional(),
}).strict().superRefine((check, context) => {
  if ((check.command === undefined) === (check.evaluator === undefined)) {
    context.addIssue({
      code: "custom",
      message: "rubric check requires exactly one command or evaluator",
    });
  }
});

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  repository: z.string().min(1),
  category: z.enum(["refactor", "reliability", "bug", "optimization"]),
  runnable: z.boolean(),
  source: z.object({
    revision: gitObjectId,
    treeHash: gitObjectId,
  }).strict(),
  task: z.object({
    stageFamily: z.enum([
      "coordination",
      "planning",
      "prd",
      "architecture",
      "ui_ux",
      "bdd",
      "tdd_coding",
      "unit_testing",
      "e2e_testing",
      "e2e_infrastructure",
      "plan_audit",
      "prd_audit",
      "architecture_audit",
      "test_audit",
      "code_audit",
      "code_review",
      "plan_critic",
      "prd_critic",
      "architecture_critic",
      "test_critic",
      "code_critic",
    ]),
    promptHash: sha256,
    taskImageHash: sha256,
    oracleHash: sha256,
  }).strict(),
  rubric: z.object({
    checks: z.array(RubricCheckSchema).min(1),
  }).strict(),
}).strict().superRefine((value, context) => {
  const total = value.rubric.checks.reduce((sum, check) => sum + check.weight, 0);
  if (total !== 100) {
    context.addIssue({
      code: "custom",
      path: ["rubric", "checks"],
      message: "rubric weights must sum to 100",
    });
  }
  const ids = new Set<string>();
  for (const [index, check] of value.rubric.checks.entries()) {
    if (ids.has(check.id)) {
      context.addIssue({
        code: "custom",
        path: ["rubric", "checks", index, "id"],
        message: "rubric check ids must be unique",
      });
    }
    ids.add(check.id);
  }
});

export const EvalSuiteSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["pilot", "full"]),
  seed: z.number().int().nonnegative(),
  baselinePolicy: z.record(z.string().min(1), z.enum(["grok", "codex"])),
  efforts: z.array(z.enum(["medium", "high", "xhigh"])).min(1),
  repetitions: z.number().int().min(4),
  cases: z.array(EvalCaseSchema).min(1),
}).strict().superRefine((suite, context) => {
  if (suite.repetitions % 2 !== 0) {
    context.addIssue({
      code: "custom",
      path: ["repetitions"],
      message: "repetitions must be even for balanced AB/BA order",
    });
  }
  if (new Set(suite.efforts).size !== suite.efforts.length) {
    context.addIssue({
      code: "custom",
      path: ["efforts"],
      message: "efforts must be unique",
    });
  }
  const caseIds = suite.cases.map((item) => item.id);
  if (new Set(caseIds).size !== caseIds.length) {
    context.addIssue({
      code: "custom",
      path: ["cases"],
      message: "case ids must be unique",
    });
  }
  for (const [index, item] of suite.cases.entries()) {
    if (!Object.hasOwn(suite.baselinePolicy, item.task.stageFamily)) {
      context.addIssue({
        code: "custom",
        path: ["baselinePolicy"],
        message: `baseline policy is missing ${item.task.stageFamily} for case ${index}`,
      });
    }
  }
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
