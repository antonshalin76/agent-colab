import { describe, expect, it } from "vitest";

import { denyLegacyLinearDelegation, LEGACY_LINEAR_DELEGATION_STATE } from "../src/runtime/legacy-linear-quarantine.js";

describe("legacy linear application quarantine", () => {
  it("is permanently disabled at the application authority boundary", () => {
    expect(LEGACY_LINEAR_DELEGATION_STATE).toBe("permanently_disabled");
    expect(() => denyLegacyLinearDelegation()).toThrow(/permanently disabled|graph collaboration runtime/i);
  });
});
