import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("permanent ExecutionAdmission quarantine", () => {
  it("is absent from every review-only production entrypoint", () => {
    for (const path of [
      "../src/app/review-application-service.ts",
      "../src/app/review-runtime-composition.ts",
      "../src/app/review-worker-runtime.ts",
      "../src/mcp/review-only-server.ts",
    ]) {
      expect(source(path)).not.toMatch(/ExecutionAdmission|CollaborationRuntime|CollaborationRunStore/);
    }
  });

  it("cannot be reached through the exact review-only MCP surface", () => {
    const server = source("../src/mcp/review-only-server.ts");
    expect(server).toContain("collab_request_review");
    expect(server).toContain("collab_run_status");
    expect(server).toContain("collab_status");
    expect(server).not.toMatch(/collab_delegate|prepareCandidate|startAdmittedWorkflow/);
  });
});
