import { createHash } from "node:crypto";
import { join } from "node:path";
import { ORACLE_SANDBOX_POLICY_IDENTITY } from "./oracle-sandbox.js";

export interface OracleExecutionRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly workspaceAccess: "read_only" | "read_write";
  readonly env?: Readonly<Record<string, string>>;
}

export interface OracleExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly outputLimitExceeded?: boolean;
  readonly cleanupVerified?: boolean;
}

export interface PilotOracleCheck {
  readonly id: string;
  readonly weight: number;
  readonly hardGate: boolean;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface PilotOracleResult {
  readonly points: number;
  readonly hardGatesPassed: boolean;
  readonly checks: readonly PilotOracleCheck[];
}

type Executor = (request: OracleExecutionRequest) => Promise<OracleExecutionResult>;

const EVALUATOR_IMPLEMENTATION_IDENTITY = Object.freeze({
  protocolVersion: "agent-collab/pilot-evaluator/v2",
  cases: {
    "PUNTO-BUG-03": ["strict-command-grammar:45:hard", "valid-command-compatibility:25:hard", "project-regression-suite:20:hard", "scope:10"],
    "TR-BUG-01": ["terminal-identity-released:45:hard", "terminal-semantics-preserved:25:hard", "provider-engine-regressions:20:hard", "scope:10"],
  },
  translatorResultProtocol: "agent-collab/translator-oracle/v1",
  sandbox: ORACLE_SANDBOX_POLICY_IDENTITY,
});

export const EVALUATOR_IMPLEMENTATION_IDENTITY_HASH = createHash("sha256")
  .update(JSON.stringify(EVALUATOR_IMPLEMENTATION_IDENTITY))
  .digest("hex");

const boundedEvidence = (result: OracleExecutionResult): string => {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n[truncated]` : text;
};

const check = (
  id: string,
  weight: number,
  hardGate: boolean,
  passed: boolean,
  evidence: string,
): PilotOracleCheck => Object.freeze({ id, weight, hardGate, passed, evidence });

const allowedScope = (caseId: string, files: readonly string[]): boolean => {
  const allowed = caseId === "PUNTO-BUG-03"
    ? [/^cpp\/src\/ipc_server\.cpp$/, /^cpp\/include\/punto\/ipc_server\.hpp$/, /^cpp\/tests\//]
    : [
      /^sidecar\/translator_sidecar\/provider_engine\.py$/,
      /^sidecar\/tests\/test_provider_engine\.py$/,
    ];
  return files.every((file) => allowed.some((pattern) => pattern.test(file)));
};

interface TranslatorCheckResult {
  passed: boolean;
  evidence: string;
}

const parseTranslatorResult = (result: OracleExecutionResult): {
  terminalIdentityReleased: TranslatorCheckResult;
  terminalSemanticsPreserved: TranslatorCheckResult;
} | null => {
  try {
    const value = JSON.parse(result.stdout) as {
      protocolVersion?: unknown;
      checks?: Record<string, { passed?: unknown; evidence?: unknown }>;
    };
    const identity = value.checks?.terminalIdentityReleased;
    const semantics = value.checks?.terminalSemanticsPreserved;
    if (value.protocolVersion !== "agent-collab/translator-oracle/v1" ||
        typeof identity?.passed !== "boolean" || typeof identity.evidence !== "string" ||
        typeof semantics?.passed !== "boolean" || typeof semantics.evidence !== "string") return null;
    return {
      terminalIdentityReleased: { passed: identity.passed, evidence: identity.evidence },
      terminalSemanticsPreserved: { passed: semantics.passed, evidence: semantics.evidence },
    };
  } catch {
    return null;
  }
};

export async function evaluatePilotOracle(input: {
  caseId: string;
  workspaceRoot: string;
  oracleRoot: string;
  providerExited: boolean;
  changedFiles: readonly string[];
  execute: Executor;
}): Promise<PilotOracleResult> {
  if (!input.providerExited) throw new Error("hidden oracle requires provider exit");
  if (input.caseId !== "PUNTO-BUG-03" && input.caseId !== "TR-BUG-01") {
    throw new Error(`oracle is not registered as runnable: ${input.caseId}`);
  }

  const checks: PilotOracleCheck[] = [];
  if (input.caseId === "PUNTO-BUG-03") {
    const binary = "/scratch/PUNTO-BUG-03";
    const compiled = await input.execute({
      file: "/usr/bin/c++",
      args: [
        "-std=c++20",
        "-pthread",
        "-I",
        join(input.workspaceRoot, "cpp", "include"),
        join(input.oracleRoot, "PUNTO-BUG-03.cpp"),
        join(input.workspaceRoot, "cpp", "src", "ipc_server.cpp"),
        "-o",
        binary,
      ],
      cwd: input.oracleRoot,
      timeoutMs: 120_000,
      workspaceAccess: "read_only",
    });
    const hidden = compiled.exitCode === 0
      ? await input.execute({
        file: binary, args: [], cwd: input.oracleRoot, timeoutMs: 30_000,
        workspaceAccess: "read_only",
      })
      : compiled;
    const hiddenPassed = compiled.exitCode === 0 && hidden.exitCode === 0;
    const evidence = boundedEvidence(hiddenPassed ? hidden : compiled);
    checks.push(check("strict-command-grammar", 45, true, hiddenPassed, evidence));
    checks.push(check("valid-command-compatibility", 25, true, hiddenPassed, evidence));
    const regression = await input.execute({
      file: "/bin/bash",
      args: [
        "-lc",
        "cmake -S cpp -B build-oracle -DBUILD_TRAY=OFF -DCMAKE_BUILD_TYPE=Debug " +
        "&& cmake --build build-oracle -j2 " +
        "&& ctest --test-dir build-oracle --output-on-failure",
      ],
      cwd: input.workspaceRoot,
      timeoutMs: 300_000,
      workspaceAccess: "read_write",
    });
    checks.push(check(
      "project-regression-suite",
      20,
      true,
      regression.exitCode === 0,
      boundedEvidence(regression),
    ));
  } else {
    const hidden = await input.execute({
      file: "/usr/bin/python3",
      args: [join(input.oracleRoot, "TR-BUG-01.py"), input.workspaceRoot],
      cwd: input.oracleRoot,
      timeoutMs: 60_000,
      workspaceAccess: "read_only",
    });
    const parsed = parseTranslatorResult(hidden);
    checks.push(check(
      "terminal-identity-released", 45, true,
      parsed?.terminalIdentityReleased.passed === true,
      parsed?.terminalIdentityReleased.evidence ?? boundedEvidence(hidden),
    ));
    checks.push(check(
      "terminal-semantics-preserved", 25, true,
      parsed?.terminalSemanticsPreserved.passed === true,
      parsed?.terminalSemanticsPreserved.evidence ?? boundedEvidence(hidden),
    ));
    const regression = await input.execute({
      file: "/usr/bin/python3",
      args: ["-m", "pytest", "-q", "sidecar/tests/test_provider_engine.py"],
      cwd: input.workspaceRoot,
      timeoutMs: 180_000,
      workspaceAccess: "read_write",
      env: { PYTHONPATH: "sidecar" },
    });
    checks.push(check(
      "provider-engine-regressions",
      20,
      true,
      regression.exitCode === 0,
      boundedEvidence(regression),
    ));
  }
  const scoped = allowedScope(input.caseId, input.changedFiles);
  checks.push(check("scope", 10, false, scoped, scoped ? "expected files only" : "out-of-scope files"));
  const points = checks.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0);
  return Object.freeze({
    points,
    hardGatesPassed: checks.filter((item) => item.hardGate).every((item) => item.passed),
    checks: Object.freeze(checks),
  });
}
