import { describe, expect, it } from "vitest";

import { createReviewedV4Bootstrap } from "../src/migration/reviewed-v4-bootstrap.js";

describe("retired child/worktree v4 bootstrap", () => {
  it("is permanently unavailable and cannot be reactivated by injected dependencies", () => {
    expect(() => createReviewedV4Bootstrap()).toThrow(/permanently disabled|in-process production transition/i);
    const invoke = createReviewedV4Bootstrap as unknown as (input: unknown) => never;
    expect(() => invoke({
      process: { run: async () => ({ status: 0, stdout: "{}", stderr: "" }) },
      quiescence: {},
      migrationAuthority: {},
    } as never)).toThrow(/permanently disabled|in-process production transition/i);
  });
});
