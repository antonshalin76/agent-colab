import { describe, expect, it } from "vitest";
import {
  createCertificationReceipt,
  requiredCertificationChecks,
  validateCertificationChain,
  validateCertificationReceipt,
  type CertificationBinding,
  type CertificationCheck,
  type CertificationStage,
} from "../src/eval/certification.js";
import { createCanarySchedule } from "../src/eval/schedule.js";
import { validateCanaryOracleGating } from "../src/eval/canary-runner.js";
import {
  providerCertificationBlockers,
  summarizeCodexCapabilityActivity,
  summarizeGrokCapabilityActivity,
} from "../src/eval/provider-certification-runner.js";
import { createCertificationRunRoot, createCertificationSubdirectory } from "../src/eval/run-root.js";
import { hashCanonicalJson } from "../src/eval/run-manifest.js";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sha = (character: string): string => character.repeat(64);

const binding: CertificationBinding = {
  version: "agent-collab-eval-binding-v1",
  harnessImplementationHash: sha("1"),
  corpusHash: sha("2"),
  suiteHash: sha("3"),
  evaluatorImplementationHash: sha("4"),
  skillBundleHash: sha("5"),
  functionalToolProfileHash: sha("6"),
  environmentContractHash: sha("7"),
  providerCommandProfileHash: sha("8"),
  sourceReceiptsHash: sha("9"),
  machineProfileHash: sha("a"),
};

function checks(stage: CertificationStage, failed?: string): CertificationCheck[] {
  return requiredCertificationChecks[stage].map((id) => ({
    id,
    passed: id !== failed,
    evidenceHash: sha(id === failed ? "b" : "c"),
    detail: id === failed ? "focused check failed" : "focused check passed",
  }));
}

const create = (
  stage: CertificationStage,
  prerequisiteReceiptHashes: readonly string[],
  failed?: string,
) => createCertificationReceipt({
  stage,
  createdAt: "2026-08-24T00:00:00.000Z",
  binding,
  prerequisiteReceiptHashes,
  checks: checks(stage, failed),
});

describe("eval certification gates", () => {
  it("requires two successful attempts and two hidden-oracle executions", () => {
    expect(validateCanaryOracleGating([
      { status: "completed", failure: null, oracle: { points: 100 } },
      { status: "completed", failure: null, oracle: { points: 90 } },
    ])).toBe(true);
    expect(validateCanaryOracleGating([
      { status: "completed", failure: null, oracle: { points: 100 } },
      { status: "failed", failure: { kind: "execution_outcome", reason: "file_budget_exceeded" }, oracle: null },
    ])).toBe(false);
    expect(validateCanaryOracleGating([
      { status: "completed", failure: null, oracle: null },
      { status: "failed", failure: { kind: "execution_outcome", reason: "task_failure" }, oracle: null },
    ])).toBe(false);
    expect(validateCanaryOracleGating([
      { status: "failed", failure: { kind: "execution_outcome", reason: "task_failure" }, oracle: null },
      { status: "failed", failure: { kind: "execution_outcome", reason: "task_failure" }, oracle: null },
    ])).toBe(false);
  });

  it("builds one canonical medium-effort repetition-zero canary cell", () => {
    const rows = createCanarySchedule({
      suiteId: "suite-v1",
      seed: 42,
      case: {
        caseId: "CASE-1",
        taskClass: "bug",
        stage: "tdd_coding",
        mode: "stage_pair",
        baselinePolicy: { tdd_coding: "codex" },
      },
      providers: ["grok", "codex"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      effort: "medium",
      repetition: 0,
      pairIdentity: { suiteId: "suite-v1-canary" },
    });
  });

  it("keeps provider calls fail-closed while audit evidence gaps remain", () => {
    expect(providerCertificationBlockers).toHaveLength(4);
    expect(providerCertificationBlockers.join(" ")).toMatch(
      /process-level evidence.*raw provider state.*durable pre-launch.*every corpus repository/is,
    );
  });

  it("reduces provider-native activity to sanitized capability booleans", () => {
    const codex = [
      { type: "item.completed", item: { type: "command_execution", command: "cat input.txt && rg NEEDLE src" } },
      { type: "item.completed", item: { type: "file_change" } },
      { type: "item.completed", item: { type: "command_execution", command: "./tests/check.sh" } },
    ].map((item) => JSON.stringify(item)).join("\n");
    expect(summarizeCodexCapabilityActivity(codex)).toEqual({
      read: true, search: true, edit: true, test: true,
    });

    const sessionId = "11111111-1111-4111-8111-111111111111";
    const grok = ["read_file", "grep", "search_replace", "run_terminal_command"]
      .map((tool_name) => JSON.stringify({
        sid: sessionId,
        msg: "shell.tool.exec_done",
        ctx: { tool_name, success: true },
      })).join("\n");
    expect(summarizeGrokCapabilityActivity(grok, sessionId)).toEqual({
      read: true, search: true, edit: true, test: true,
    });
    expect(summarizeGrokCapabilityActivity(grok, "other-session")).toEqual({
      read: false, search: false, edit: false, test: false,
    });
  });

  it("accepts only a complete passed harness-provider-canary chain bound to identical inputs", () => {
    const harness = create("harness", []);
    const providers = create("providers", [harness.receiptHash]);
    const canary = create("canary", [harness.receiptHash, providers.receiptHash]);

    expect(validateCertificationChain({ binding, harness, providers, canary }))
      .toEqual({ harness, providers, canary });
  });

  it("blocks the next stage when any required check failed", () => {
    const harness = create("harness", [], "cpp_oracle_runtime");

    expect(harness.status).toBe("failed");
    expect(() => validateCertificationChain({ binding, harness }))
      .toThrow(/harness certification did not pass/i);
  });

  it("rejects missing, duplicate, or unexpected checks", () => {
    const complete = checks("harness");
    expect(() => createCertificationReceipt({
      stage: "harness",
      createdAt: "2026-08-24T00:00:00.000Z",
      binding,
      prerequisiteReceiptHashes: [],
      checks: complete.slice(1),
    })).toThrow(/check set mismatch/i);
    expect(() => createCertificationReceipt({
      stage: "harness",
      createdAt: "2026-08-24T00:00:00.000Z",
      binding,
      prerequisiteReceiptHashes: [],
      checks: [...complete, complete[0]!],
    })).toThrow(/unique/i);
  });

  it("rejects receipt tampering, binding drift, and prerequisite substitution", () => {
    const harness = create("harness", []);
    const tampered = structuredClone(harness);
    tampered.checks[0]!.detail = "rewritten evidence";
    expect(() => validateCertificationReceipt({
      receipt: tampered,
      expectedStage: "harness",
      expectedBinding: binding,
      expectedPrerequisiteReceiptHashes: [],
    })).toThrow(/hash mismatch/i);

    expect(() => validateCertificationReceipt({
      receipt: harness,
      expectedStage: "harness",
      expectedBinding: { ...binding, corpusHash: sha("d") },
      expectedPrerequisiteReceiptHashes: [],
    })).toThrow(/binding mismatch/i);

    const providers = create("providers", [harness.receiptHash]);
    expect(() => validateCertificationReceipt({
      receipt: providers,
      expectedStage: "providers",
      expectedBinding: binding,
      expectedPrerequisiteReceiptHashes: [sha("e")],
    })).toThrow(/prerequisite chain mismatch/i);
  });

  it("derives status instead of trusting a rehashed status field", () => {
    const failed = create("harness", [], "cpp_oracle_runtime");
    const forgedBody = { ...failed, status: "passed" as const };
    const { receiptHash: _oldHash, ...body } = forgedBody;
    const forged = { ...body, receiptHash: hashCanonicalJson(body) };
    expect(() => validateCertificationReceipt({
      receipt: forged,
      expectedStage: "harness",
      expectedBinding: binding,
      expectedPrerequisiteReceiptHashes: [],
    })).toThrow(/status does not match/i);
  });

  it("rejects symlinked run roots and nested certification directories", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-collab-cert-"));
    const protectedRoot = join(base, "protected");
    const outside = join(base, "outside");
    mkdirSync(protectedRoot);
    mkdirSync(outside);
    const linkedRoot = join(base, "linked-root");
    symlinkSync(outside, linkedRoot);
    expect(() => createCertificationRunRoot({ runRoot: linkedRoot, protectedRoots: [protectedRoot] }))
      .toThrow(/symbolic link/i);

    const runRoot = createCertificationRunRoot({
      runRoot: join(base, "real-run"),
      protectedRoots: [protectedRoot],
    });
    symlinkSync(outside, join(runRoot, "canary"));
    expect(() => createCertificationSubdirectory(runRoot, "canary/workspace"))
      .toThrow(/symbolic link/i);
  });
});
