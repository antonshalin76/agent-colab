import { describe, expect, it, vi } from "vitest";
import { discoverProviderVersion, normalizeProviderVersion } from "../src/probes/provider-version.js";

describe("live provider version discovery", () => {
  it("normalizes Grok's HOME-dependent stable channel suffix", () => {
    const probe = vi.fn(() => ({
      status: 0,
      stdout: "grok 9.8.7 (future) [stable]\n",
      stderr: "",
    }));
    expect(discoverProviderVersion("/opt/bin/grok", probe))
      .toBe("grok 9.8.7 (future)");
    expect(probe).toHaveBeenCalledWith("/opt/bin/grok", ["--version"]);
  });

  it("uses the same normalization for an observed capability-probe version", () => {
    expect(normalizeProviderVersion("grok 9.8.7 (future) [stable]\n"))
      .toBe("grok 9.8.7 (future)");
  });

  it("fails closed when the installed binary cannot identify itself", () => {
    expect(() => discoverProviderVersion("/opt/bin/codex", () => ({
      status: 1,
      stdout: "",
      stderr: "broken install",
    }))).toThrow("broken install");
  });
});
