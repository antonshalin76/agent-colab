import { randomUUID } from "node:crypto";
import {
  evaluateStartupProbe,
  type StartupProbeObserved,
  type StartupProbeResult,
} from "../domain/outcomes.js";
import type { ActiveAgentId, Effort } from "../domain/routing.js";
import { buildCodexCommand, normalizeCodexResult } from "../runners/codex.js";
import { buildGrokCommand, normalizeGrokResult } from "../runners/grok.js";

interface ProviderProbeConfig {
  enabled: boolean;
  binaryPath: string;
  expectedVersion: string;
  model: "grok-4.6" | "gpt-5.6-sol";
  effort: Effort;
  cwd: string;
}

export interface CapabilityProbeRequest {
  agent: ActiveAgentId;
  file: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  shell: false;
  killProcessGroup: true;
}

interface CapabilityProcessResult {
  exitCode: number;
  version: string;
  stdout: string;
  stderr: string;
}

export interface CapabilityProbeRunner {
  execute(request: CapabilityProbeRequest): Promise<CapabilityProcessResult>;
}

const PROTOCOL = "agent-collab/v2";

const probeInput = (effort: Effort): string =>
  `Capability probe. Do not use tools. Return only valid JSON with exactly these keys: ` +
  `{"protocolVersion":"${PROTOCOL}","reasoningEffort":"${effort}",` +
  `"visibleText":"{\\"protocolVersion\\":\\"${PROTOCOL}\\",\\"reasoningEffort\\":\\"${effort}\\",` +
  `\\"supportsNonInteractive\\":true,\\"supportsResume\\":true}"}.`;

const requestFor = (
  agent: ActiveAgentId,
  config: ProviderProbeConfig,
  timeoutMs: number,
  sessionId: string,
): CapabilityProbeRequest => {
  const prompt = probeInput(config.effort);
  const command = agent === "grok"
    ? buildGrokCommand({
        binary: config.binaryPath,
        cwd: config.cwd,
        prompt,
        sessionId,
        approvalScope: "workspace-read",
        effort: config.effort,
        timeoutMs,
      })
    : buildCodexCommand({
        binary: config.binaryPath,
        cwd: config.cwd,
        prompt,
        approvalScope: "workspace-read",
        effort: config.effort,
        timeoutMs,
      });
  return {
    agent,
    file: command.file,
    args: command.args,
    cwd: command.cwd,
    stdin: command.stdin,
    timeoutMs: command.timeoutMs,
    shell: false,
    killProcessGroup: true,
  };
};

class ProbeTimeoutError extends Error {
  readonly code = "PROBE_TIMEOUT";
}

const bounded = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError("Capability probe timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const unavailable = (failure: string): StartupProbeResult => ({
  health: "unavailable",
  ready: false,
  failures: [failure],
});

const parseCapabilityPayload = (text: string, expectedEffort: Effort) => {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof payload !== "object" ||
      payload === null ||
      payload.protocolVersion !== PROTOCOL ||
      payload.reasoningEffort !== expectedEffort ||
      typeof payload.supportsNonInteractive !== "boolean" ||
      typeof payload.supportsResume !== "boolean"
    ) {
      return null;
    }
    return {
      protocolVersion: PROTOCOL,
      supportsNonInteractive: payload.supportsNonInteractive,
      supportsResume: payload.supportsResume,
    };
  } catch {
    return null;
  }
};

const parseObserved = (
  agent: ActiveAgentId,
  config: ProviderProbeConfig,
  result: CapabilityProcessResult,
): StartupProbeObserved | null => {
  try {
    const normalized = agent === "grok"
      ? normalizeGrokResult(result.stdout, {
          expectedEffort: config.effort,
          expectedProtocolVersion: PROTOCOL,
        })
      : normalizeCodexResult(result.stdout);
    const parsed = parseCapabilityPayload(normalized.text, config.effort);
    if (parsed === null) return null;
    return {
      binaryPath: config.binaryPath,
      version: result.version,
      authenticated: true,
      model: normalized.model,
      parsed,
    };
  } catch {
    return null;
  }
};

const probeOne = async (
  agent: ActiveAgentId,
  config: ProviderProbeConfig,
  timeoutMs: number,
  sessionId: string,
  runner: CapabilityProbeRunner,
): Promise<StartupProbeResult> => {
  if (!config.enabled) {
    return { health: "disabled", ready: false, failures: ["provider_disabled"] };
  }
  try {
    const result = await bounded(
      runner.execute(requestFor(agent, config, timeoutMs, sessionId)),
      timeoutMs,
    );
    if (result.exitCode !== 0) return unavailable("cli_failure");
    const observed = parseObserved(agent, config, result);
    if (observed === null) return unavailable("response_parse_failed");
    return evaluateStartupProbe({
      agent,
      enabled: true,
      expected: {
        binaryPath: config.binaryPath,
        version: config.expectedVersion,
        model: config.model,
        protocolVersion: PROTOCOL,
      },
      observed,
    });
  } catch (error) {
    if (error instanceof ProbeTimeoutError) return unavailable("probe_timeout");
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "ENOENT"
    ) {
      return unavailable("cli_missing");
    }
    return unavailable("cli_failure");
  }
};

export async function runCapabilityProbes(input: {
  providers: Record<ActiveAgentId, ProviderProbeConfig>;
  timeoutMs: number;
  runner: CapabilityProbeRunner;
  sessionIdFactory?: () => string;
}): Promise<{ results: Record<ActiveAgentId, StartupProbeResult> }> {
  const sessionIdFactory = input.sessionIdFactory ?? randomUUID;
  const [grok, codex] = await Promise.all([
    probeOne("grok", input.providers.grok, input.timeoutMs, sessionIdFactory(), input.runner),
    probeOne("codex", input.providers.codex, input.timeoutMs, sessionIdFactory(), input.runner),
  ]);
  return { results: { grok, codex } };
}
