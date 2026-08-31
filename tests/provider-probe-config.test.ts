import { describe, expect, it, vi } from "vitest";
import { buildCapabilityProbeProviders } from "../src/probes/provider-probe-config.js";

describe("per-provider recovery probe configuration", () => {
  it.each(["grok", "claude", "codex"] as const)(
    "discovers only the selected %s binary",
    (selected) => {
      const binaries = { grok: "/missing/grok", claude: "/valid/claude", codex: "/valid/codex" };
      const discoverVersion = vi.fn((binary: string) => {
        if (binary === "/missing/grok") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return `version:${binary}`;
      });
      if (selected === "grok") {
        expect(() => buildCapabilityProbeProviders({ enabledAgent: selected, binaries,
          cwd: "/repo", discoverVersion })).toThrow(/missing/);
      } else {
        const providers = buildCapabilityProbeProviders({ enabledAgent: selected, binaries,
          cwd: "/repo", discoverVersion });
        expect(providers[selected]).toMatchObject({ enabled: true,
          expectedVersion: `version:${binaries[selected]}` });
        expect(providers.grok.enabled).toBe(false);
        expect(providers.grok.expectedVersion).toBe("disabled");
      }
      expect(discoverVersion).toHaveBeenCalledTimes(1);
      expect(discoverVersion).toHaveBeenCalledWith(binaries[selected]);
    },
  );
});
