import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("review-only execution ownership", () => {
  it("keeps review admission, review persistence and provider recovery in their dedicated owners", () => {
    const composition = source("../src/app/review-runtime-composition.ts");
    const application = source("../src/app/review-application-service.ts");
    const worker = source("../src/app/review-worker-runtime.ts");

    expect(composition).toContain("ReviewApplicationService");
    expect(composition).toContain("RunGateUnitOfWork");
    expect(application).toContain("captureAdmission");
    expect(worker).toContain("runAutomaticProviderRecovery");
    expect(`${composition}\n${application}\n${worker}`)
      .not.toMatch(/ExecutionAdmission|CollaborationRuntime|CollaborationRunStore/);
  });

  it("publishes no cross-provider workflow fallback from the review worker", () => {
    const worker = source("../src/app/review-worker-runtime.ts");
    expect(worker).not.toMatch(
      /HANDOFF_TRANSFER_CONFLICT|handoff_dispatched|cross-provider-replay|transferImmediate|allowFallback/,
    );
  });
});
