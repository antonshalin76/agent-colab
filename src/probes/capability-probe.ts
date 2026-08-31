import { randomUUID } from "node:crypto";
import {
  evaluateStartupProbe,
  type StartupProbeObserved,
  type StartupProbeResult,
} from "../domain/outcomes.js";
import type {
  Effort,
  ProviderModel,
  ReviewProviderId,
} from "../domain/routing.js";
import { buildClaudeCommand, normalizeClaudeResult } from "../runners/claude.js";
import { buildCodexCommand, normalizeCodexResult } from "../runners/codex.js";
import { buildGrokCommand, normalizeGrokResult } from "../runners/grok.js";
import type { GrokEffort } from "../runners/grok.js";

export interface ProviderProbeConfig {
  enabled: boolean;
  binaryPath: string;
  expectedVersion: string;
  model: ProviderModel;
  effort: Effort;
  cwd: string;
}

export interface CapabilityProbeRequest {
  agent: ReviewProviderId;
  file: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  shell: false;
  killProcessGroup: true;
  promptFileArgIndex?: number;
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

const capabilityPayload = (effort: Effort): string => JSON.stringify({
  protocolVersion: PROTOCOL,
  reasoningEffort: effort,
  supportsNonInteractive: true,
  supportsResume: true,
});

const probeInput = (agent: ReviewProviderId, effort: Effort): string => {
  if (agent === "claude") {
    return `Capability probe. Do not use tools. Return a review-verdict/v1 envelope with verdict PASS ` +
      `and exactly one info finding whose message is exactly this JSON: ${capabilityPayload(effort)}`;
  }
  return `Capability probe. Do not use tools. Return only valid JSON with exactly these keys: ` +
    `{"protocolVersion":"${PROTOCOL}","reasoningEffort":"${effort}",` +
    `"visibleText":"{\\"protocolVersion\\":\\"${PROTOCOL}\\",\\"reasoningEffort\\":\\"${effort}\\",` +
    `\\"supportsNonInteractive\\":true,\\"supportsResume\\":true}"}.`;
};

const requestFor = (
  agent: ReviewProviderId,
  config: ProviderProbeConfig,
  timeoutMs: number,
  sessionId: string,
): CapabilityProbeRequest => {
  const prompt = probeInput(agent, config.effort);
  const command = agent === "grok"
    ? buildGrokCommand({
        binary: config.binaryPath,
        cwd: config.cwd,
        prompt,
        sessionId,
        approvalScope: "workspace-read",
        effort: config.effort as GrokEffort,
        timeoutMs,
      })
    : agent === "claude"
      ? buildClaudeCommand({
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
    ...(command.promptFileArgIndex !== undefined
      ? { promptFileArgIndex: command.promptFileArgIndex }
      : {}),
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

const claudeCapabilityText = (text: string): string | null => {
  try {
    const verdict = JSON.parse(text) as Record<string, unknown>;
    if (verdict.schemaVersion !== "review-verdict/v1" || verdict.verdict !== "PASS" ||
        !Array.isArray(verdict.findings) || verdict.findings.length !== 1) return null;
    const finding = verdict.findings[0] as Record<string, unknown> | undefined;
    return finding?.risk_level === "info" && typeof finding.message === "string"
      ? finding.message
      : null;
  } catch {
    return null;
  }
};

const parseObserved = (
  agent: ReviewProviderId,
  config: ProviderProbeConfig,
  result: CapabilityProcessResult,
  sessionId: string,
): StartupProbeObserved | null => {
  try {
    const normalized = agent === "grok"
      ? normalizeGrokResult(result.stdout, {
          expectedEffort: config.effort,
          expectedProtocolVersion: PROTOCOL,
        })
      : agent === "claude"
        ? normalizeClaudeResult(result.stdout, {
            expectedSessionId: sessionId,
            expectedEffort: config.effort,
          })
        : normalizeCodexResult(result.stdout, {
            includeUsage: true,
            expectedEffort: config.effort,
            expectedProtocolVersion: PROTOCOL,
            pinnedModel: "gpt-5.6-sol",
          });
    const capabilityText = agent === "claude"
      ? claudeCapabilityText(normalized.text)
      : normalized.text;
    if (capabilityText === null) return null;
    const parsed = parseCapabilityPayload(capabilityText, config.effort);
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
  agent: ReviewProviderId,
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
    const observed = parseObserved(agent, config, result, sessionId);
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
  providers: Record<ReviewProviderId, ProviderProbeConfig>;
  timeoutMs: number;
  runner: CapabilityProbeRunner;
  sessionIdFactory?: () => string;
}): Promise<{ results: Record<ReviewProviderId, StartupProbeResult> }> {
  const sessionIdFactory = input.sessionIdFactory ?? randomUUID;
  const [grok, claude, codex] = await Promise.all([
    probeOne("grok", input.providers.grok, input.timeoutMs, sessionIdFactory(), input.runner),
    probeOne("claude", input.providers.claude, input.timeoutMs, sessionIdFactory(), input.runner),
    probeOne("codex", input.providers.codex, input.timeoutMs, sessionIdFactory(), input.runner),
  ]);
  return { results: { grok, claude, codex } };
}
