import { describe, expect, it, vi } from "vitest";
import {
  EVALUATOR_IMPLEMENTATION_IDENTITY_HASH,
  evaluatePilotOracle,
} from "../src/eval/oracle-registry.js";

describe("pilot hidden oracle registry", () => {
  it("scores only registered hidden and regression commands after provider exit", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const result = await evaluatePilotOracle({
      caseId: "PUNTO-BUG-03",
      workspaceRoot: "/attempt/punto",
      oracleRoot: "/private/oracles",
      providerExited: true,
      changedFiles: ["cpp/src/ipc_server.cpp", "cpp/tests/test_main.cpp"],
      execute,
    });

    expect(result).toMatchObject({ points: 100, hardGatesPassed: true });
    expect(result.checks.map((check) => check.id)).toEqual([
      "strict-command-grammar",
      "valid-command-compatibility",
      "project-regression-suite",
      "scope",
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("scores the two translator hard gates independently", async () => {
    let call = 0;
    const execute = vi.fn(async () => call++ === 0
      ? {
        exitCode: 1,
        stdout: JSON.stringify({
          protocolVersion: "agent-collab/translator-oracle/v1",
          checks: {
            terminalIdentityReleased: { passed: true, evidence: "capacity released" },
            terminalSemanticsPreserved: { passed: false, evidence: "duplicate accepted" },
          },
        }),
        stderr: "",
      }
      : { exitCode: 0, stdout: "", stderr: "" });
    const result = await evaluatePilotOracle({
      caseId: "TR-BUG-01",
      workspaceRoot: "/attempt/translator",
      oracleRoot: "/private/oracles",
      providerExited: true,
      changedFiles: ["sidecar/translator_sidecar/provider_engine.py"],
      execute,
    });

    expect(result.hardGatesPassed).toBe(false);
    expect(result.points).toBeLessThan(100);
    expect(result.checks.find((check) => check.id === "terminal-identity-released"))
      .toMatchObject({ passed: true, hardGate: true, evidence: "capacity released" });
    expect(result.checks.find((check) => check.id === "terminal-semantics-preserved"))
      .toMatchObject({ passed: false, hardGate: true, evidence: "duplicate accepted" });
    expect(result.points).toBe(75);
  });

  it("fails both translator gates closed when the structured oracle result is absent", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }));
    const result = await evaluatePilotOracle({
      caseId: "TR-BUG-01",
      workspaceRoot: "/attempt/translator",
      oracleRoot: "/private/oracles",
      providerExited: true,
      changedFiles: [],
      execute,
    });

    expect(result.checks.slice(0, 2).map((item) => item.passed)).toEqual([false, false]);
    expect(result.hardGatesPassed).toBe(false);
  });

  it("refuses pre-exit scoring, unregistered cases, and out-of-scope changes", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await expect(evaluatePilotOracle({
      caseId: "PUNTO-BUG-03",
      workspaceRoot: "/attempt/punto",
      oracleRoot: "/private/oracles",
      providerExited: false,
      changedFiles: [],
      execute,
    })).rejects.toThrow(/provider.*exit/i);
    await expect(evaluatePilotOracle({
      caseId: "PUNTO-OPT-04",
      workspaceRoot: "/attempt/punto",
      oracleRoot: "/private/oracles",
      providerExited: true,
      changedFiles: [],
      execute,
    })).rejects.toThrow(/not.*runnable|oracle.*registered/i);

    const scoped = await evaluatePilotOracle({
      caseId: "TR-BUG-01",
      workspaceRoot: "/attempt/translator",
      oracleRoot: "/private/oracles",
      providerExited: true,
      changedFiles: ["README.md"],
      execute,
    });
    expect(scoped.checks.find((check) => check.id === "scope"))
      .toMatchObject({ passed: false });
  });

  it("exports a stable evaluator implementation identity for frozen manifests", () => {
    expect(EVALUATOR_IMPLEMENTATION_IDENTITY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
