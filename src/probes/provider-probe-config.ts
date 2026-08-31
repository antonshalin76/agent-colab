import type { ReviewProviderId } from "../domain/routing.js";
import type { ProviderProbeConfig } from "./capability-probe.js";

export function buildCapabilityProbeProviders(input: {
  enabledAgent?: ReviewProviderId;
  binaries: Readonly<Record<ReviewProviderId, string>>;
  cwd: string;
  discoverVersion: (binary: string) => string;
}): Record<ReviewProviderId, ProviderProbeConfig> {
  const enabled = (agent: ReviewProviderId): boolean =>
    input.enabledAgent === undefined || input.enabledAgent === agent;
  const config = (agent: ReviewProviderId, model: ProviderProbeConfig["model"],
    effort: ProviderProbeConfig["effort"]): ProviderProbeConfig => ({
    enabled: enabled(agent),
    binaryPath: input.binaries[agent],
    expectedVersion: enabled(agent) ? input.discoverVersion(input.binaries[agent]) : "disabled",
    model,
    effort,
    cwd: input.cwd,
  });
  return {
    grok: config("grok", "grok-4.6", "high"),
    claude: config("claude", "glm-5.3", "max"),
    codex: config("codex", "gpt-5.6-sol", "high"),
  };
}
