import { describe, expect, it } from "vitest";
import { classifyOutcome, evaluateStartupProbe } from "../src/domain/outcomes.js";

describe("BDD-6/7 outcome policy", () => {
  it.each([
    "quota",
    "rate_limit",
    "overload",
    "network_timeout",
    "model_unavailable",
    "cli_missing",
    "auth",
  ] as const)("allows failover for provider unavailability %s", (kind) => {
    expect(classifyOutcome({ kind })).toEqual({
      failoverEligible: true,
      countsAgainstProvider: true,
    });
  });

  it.each([
    "task_failure",
    "invalid_request",
    "safety_denial",
    "permission_denial",
    "user_cancelled",
  ] as const)("does not bypass or penalize a provider for %s", (kind) => {
    expect(classifyOutcome({ kind })).toEqual({
      failoverEligible: false,
      countsAgainstProvider: false,
    });
  });

  it("rejects unknown failures instead of treating them as provider outages", () => {
    expect(() => classifyOutcome({ kind: "mystery_failure" as never })).toThrow(/unknown outcome/i);
  });
});

describe("BDD-9 startup capability probe", () => {
  const expected = {
    binaryPath: "/opt/agent-collab/bin/grok",
    version: "1.0.0",
    model: "grok-4.6",
    protocolVersion: "agent-collab/v2",
  };
  const observed = {
    binaryPath: expected.binaryPath,
    version: expected.version,
    authenticated: true,
    model: expected.model,
    parsed: {
      protocolVersion: expected.protocolVersion,
      supportsNonInteractive: true,
      supportsResume: true,
    },
  };

  it("becomes ready only after every pinned Grok capability matches", () => {
    expect(evaluateStartupProbe({
      agent: "grok",
      enabled: true,
      expected,
      observed,
    })).toEqual({ health: "healthy", ready: true, failures: [] });

    expect(evaluateStartupProbe({
      agent: "codex",
      enabled: true,
      expected: {
        binaryPath: "/opt/agent-collab/bin/codex",
        version: "0.147.0",
        model: "gpt-5.6-sol",
        protocolVersion: "agent-collab/v2",
      },
      observed: {
        binaryPath: "/opt/agent-collab/bin/codex",
        version: "0.147.0",
        authenticated: true,
        model: "gpt-5.6-sol",
        parsed: {
          protocolVersion: "agent-collab/v2",
          supportsNonInteractive: true,
          supportsResume: true,
        },
      },
    })).toEqual({ health: "healthy", ready: true, failures: [] });
  });

  it.each([
    ["binary_path_mismatch", { binaryPath: "/usr/bin/grok-unpinned" }],
    ["version_mismatch", { version: "0.9.9" }],
    ["authentication_failed", { authenticated: false }],
    ["model_mismatch", { model: "grok-4" }],
    ["response_parse_failed", { parsed: null }],
    ["protocol_mismatch", { parsed: { ...observed.parsed, protocolVersion: "untrusted/v0" } }],
  ] as const)("keeps Grok unavailable for %s", (failure, override) => {
    const result = evaluateStartupProbe({
      agent: "grok",
      enabled: true,
      expected,
      observed: { ...observed, ...override },
    });
    expect(result).toMatchObject({ health: "unavailable", ready: false });
    expect(result.failures).toContain(failure);
  });

  it("reports disabled as non-readiness without trusting a response", () => {
    expect(evaluateStartupProbe({
      agent: "grok",
      enabled: false,
      expected,
      observed: null,
    })).toEqual({
      health: "disabled",
      ready: false,
      failures: ["provider_disabled"],
    });
  });
});
