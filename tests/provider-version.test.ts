import { describe, expect, it, vi } from "vitest";
import { discoverProviderVersion } from "../src/probes/provider-version.js";

describe("live provider version discovery", () => {
  it("uses the exact installed CLI version without a release fallback", () => {
    const probe = vi.fn(() => ({
      status: 0,
      stdout: "grok 9.8.7 (future) [stable]\n",
      stderr: "",
    }));
    expect(discoverProviderVersion("/opt/bin/grok", probe))
      .toBe("grok 9.8.7 (future) [stable]");
    expect(probe).toHaveBeenCalledWith("/opt/bin/grok", ["--version"]);
  });

  it("fails closed when the installed binary cannot identify itself", () => {
    expect(() => discoverProviderVersion("/opt/bin/codex", () => ({
      status: 1,
      stdout: "",
      stderr: "broken install",
    }))).toThrow("broken install");
  });
});
