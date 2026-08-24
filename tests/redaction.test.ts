import { describe, expect, it } from "vitest";
import { redactSensitive, sanitizeResult } from "../src/security/redaction.js";

describe("secret-free logs and results", () => {
  const sentinels = [
    "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE",
    "ctx7sk-FAKEFAKEFAKEFAKEFAKE",
    "Authorization: Bearer FAKE_BEARER_TOKEN",
    "TAVILY_API_KEY=FAKE_TAVILY_TOKEN",
    'Authorization: Bearer "QUOTED_BEARER_TOKEN"',
    'OPENAI_API_KEY: "FAKE_COLON_TOKEN"',
    "sk-proj-FAKEPROJECTTOKEN1234567890",
    "ghp_FAKEGITHUBTOKEN1234567890",
    '"access_token": "lowercase-json-secret"',
    "client_secret=lowercase-assignment-secret",
    "api_key=genericsecret123456",
    "token=standalone-lowercase-token",
    "AKIAFAKEACCESSKEY1234",
    "-----BEGIN PRIVATE KEY-----\nFAKEBASE64PRIVATEKEYMATERIAL1234567890\n-----END PRIVATE KEY-----",
  ];

  it.each(sentinels)("redacts %s", (sentinel) => {
    const output = redactSensitive(`before ${sentinel} after`);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(sentinel);
  });

  it("sanitizes nested runner results before persistence or MCP output", () => {
    const result = sanitizeResult({
      text: "ok sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE",
      logs: ["Authorization: Bearer FAKE_BEARER_TOKEN"],
      metadata: { toolArgs: "--api-key FAKE_TOOL_TOKEN", safe: "kept" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/FAKEFAKE|FAKE_BEARER|FAKE_TOOL/);
    expect(serialized).toContain("kept");
  });

  it("redacts values by sensitive object key even when the value has no recognizable prefix", () => {
    expect(sanitizeResult({ access_token: "opaque", nested: { clientSecret: "also-opaque" }, safe: "kept" }))
      .toEqual({ access_token: "[REDACTED]", nested: { clientSecret: "[REDACTED]" }, safe: "kept" });
  });
});
