import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("execution admission ownership", () => {
  it("keeps snapshot and admission decisions out of service, runtime and runner adapters", () => {
    const service = source("../src/app/service.ts");
    const runtime = source("../src/runtime/collaboration-runtime.ts");
    const runner = source("../src/runners/agent-runner.ts");

    expect(service).toContain("this.runtime.prepareCandidate");
    expect(service).toContain("this.runtime.reviewTarget");
    expect(service).not.toMatch(/createExecutionSnapshot|validateAndConsume|mapAdmissionTargetBytes/);
    expect(runtime).toContain("new ExecutionAdmission");
    expect(runtime).not.toMatch(/verifyCurrentMapProfile|delegatedAuthorityConsumerKey|mapAdmissionReviewExpectation/);
    expect(runner).toContain("new ExecutionAdmission");
    expect(runner).not.toMatch(/mapAdmissionGates|delegatedAuthorityConsumerKey|mapAdmissionTargetBytes/);
  });

  it("has no runtime cross-provider workflow fallback surface", () => {
    const production = [
      source("../src/workflow/workflow.ts"),
      source("../src/runtime/collaboration-runtime.ts"),
      source("../src/store/collaboration-run-store.ts"),
      source("../src/worker/durable-worker.ts"),
      source("../src/worktree/lease-store.ts"),
      source("../src/cli.ts"),
    ].join("\n");
    expect(production).not.toMatch(
      /HANDOFF_TRANSFER_CONFLICT|handoff_dispatched|cross-provider-replay|deferredReplay|transferImmediate/,
    );
  });
});
