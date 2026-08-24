import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import {
  ROUTING_POLICY_VERSION,
  STAGES,
  STAGE_POLICY,
  constrainEffortForAgent,
  increaseRequestedEffort,
  type ActiveAgentId,
  type ApprovalScope,
  type Effort,
  type Stage,
} from "../domain/routing.js";
import { redactSensitive } from "../security/redaction.js";
import { normalizeCodexResult } from "./codex.js";
import { grokWorkspaceWriteToolAllowlist, normalizeGrokResult } from "./grok.js";
import { buildProviderCommand, type CommandSpec } from "./provider-command.js";

const PROTOCOL = "agent-collab/v2";
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh"]);
const EFFORT_MODIFIERS = [
  "degraded_fallback",
  "retry",
  "external_scope",
  "large_artifact",
  "broad_change_set",
] as const;
const LIMIT_REASON = /^(provider_policy_limit:gpt-5\.6-sol:xhigh|model_capability_limit:grok-4\.6:xhigh)$/;

export interface SavedRunnerDecision {
  agent: ActiveAgentId;
  model: "grok-4.6" | "gpt-5.6-sol";
  effort: Effort;
  policyVersion: typeof ROUTING_POLICY_VERSION;
  reasons: readonly string[];
}

export interface ProcessTask {
  id: string;
  stage?: string;
  approvalScope?: string;
  payload?: Record<string, unknown>;
}

interface TaskPayload {
  project: string;
  prompt: string;
  approvalScope: ApprovalScope;
  approvalReference?: string;
  sessionId?: string;
  toolAllowlist?: readonly string[];
  decision: SavedRunnerDecision;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LaunchedProcess {
  pid?: number;
  result: Promise<ProcessResult>;
  terminate(signal: "SIGTERM" | "SIGKILL"): void | Promise<void>;
}

export interface ProcessLauncher {
  launch(command: CommandSpec): LaunchedProcess;
}

export interface AgentRunnerConfig {
  binaries: Readonly<Record<ActiveAgentId, string>>;
  timeoutMs: number;
  launcher?: ProcessLauncher;
}

async function terminateProcess(
  launched: LaunchedProcess,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  try { await launched.terminate(signal); } catch { /* process group already exited */ }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function approvalScope(value: unknown): ApprovalScope | null {
  return value === "workspace-read" || value === "workspace-write" || value === "external"
    ? value
    : null;
}

function validReasons(
  value: unknown,
  agent: ActiveAgentId,
  effort: Effort,
): value is string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((reason) => typeof reason !== "string" || !reason)) return false;
  const baseline = value[0]!.split(":");
  if (baseline.length !== 3 || baseline[0] !== "stage_baseline" ||
      !STAGES.includes(baseline[1] as (typeof STAGES)[number]) ||
      !EFFORTS.has(baseline[2] as Effort)) return false;
  const stage = baseline[1] as Stage;
  const baselineEffort = baseline[2] as Effort;
  if (STAGE_POLICY[stage].baselineEffort[agent] !== baselineEffort) return false;
  const last = value.at(-1)!;
  const actualLimit = LIMIT_REASON.test(last) ? last : null;
  const modifiers = actualLimit === null ? value.slice(1) : value.slice(1, -1);
  let previous = -1;
  for (const reason of modifiers) {
    const index = EFFORT_MODIFIERS.indexOf(reason as (typeof EFFORT_MODIFIERS)[number]);
    if (index <= previous) return false;
    previous = index;
  }
  const requested = increaseRequestedEffort(baselineEffort, modifiers.length);
  const constrained = constrainEffortForAgent(agent, requested);
  return constrained.effort === effort && constrained.reason === actualLimit;
}

function parseDecision(value: unknown): SavedRunnerDecision {
  const input = object(value);
  if (!input || (input.agent !== "grok" && input.agent !== "codex")) {
    throw new Error("run payload is missing a saved provider decision");
  }
  const expectedModel = input.agent === "grok" ? "grok-4.6" : "gpt-5.6-sol";
  if (input.model !== expectedModel) throw new Error("saved provider decision has a model mismatch");
  if (typeof input.effort !== "string" || !EFFORTS.has(input.effort as Effort)) {
    throw new Error("saved provider decision has an unsupported effort");
  }
  if (input.policyVersion !== ROUTING_POLICY_VERSION) {
    throw new Error("saved provider decision has an unknown policy version");
  }
  if (!validReasons(input.reasons, input.agent, input.effort as Effort)) {
    throw new Error("saved provider decision has invalid reasons");
  }
  return Object.freeze({
    agent: input.agent,
    model: expectedModel,
    effort: input.effort as Effort,
    policyVersion: ROUTING_POLICY_VERSION,
    reasons: Object.freeze([...input.reasons] as string[]),
  });
}

const decisionsMatch = (
  left: SavedRunnerDecision,
  right: SavedRunnerDecision,
): boolean =>
  left.agent === right.agent &&
  left.model === right.model &&
  left.effort === right.effort &&
  left.policyVersion === right.policyVersion &&
  left.reasons.length === right.reasons.length &&
  left.reasons.every((reason, index) => reason === right.reasons[index]);

const parseDispatchIdentity = (value: unknown): {
  decision: SavedRunnerDecision;
  sessionId: string;
  attemptId: string;
  attemptOrdinal: number;
  degraded: boolean;
} => {
  const input = object(value);
  const decision = parseDecision(value);
  if (
    !input ||
    typeof input.sessionId !== "string" ||
    typeof input.attemptId !== "string" ||
    !Number.isSafeInteger(input.attemptOrdinal) ||
    typeof input.degraded !== "boolean"
  ) {
    throw new Error("immutable dispatch identity is incomplete");
  }
  return {
    decision,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    attemptOrdinal: input.attemptOrdinal as number,
    degraded: input.degraded,
  };
};

function taskPayload(run: ProcessTask): TaskPayload {
  const payload = run.payload ?? {};
  const scope = approvalScope(payload.approvalScope);
  if (typeof payload.project !== "string" || typeof payload.prompt !== "string" || !scope) {
    throw new Error("run payload is incomplete");
  }
  if (run.approvalScope !== undefined && run.approvalScope !== scope) {
    throw new Error("run payload approval scope mismatch");
  }
  const expectedStage = STAGES.includes(run.stage as Stage)
    ? run.stage as Stage
    : run.stage === "review:auditor"
      ? "code_audit"
      : run.stage === "review:critic"
        ? "code_critic"
        : null;
  if (expectedStage === null) {
    throw new Error("run requires a canonical workflow or review stage");
  }
  const decision = parseDecision(payload.decision);
  const baselineStage = decision.reasons[0]!.split(":")[1];
  if (expectedStage !== null && baselineStage !== expectedStage) {
    throw new Error("saved provider decision baseline does not match the queued stage");
  }
  const workflowRun = !run.stage!.startsWith("review:");
  if (workflowRun || payload.workflowDispatchIdentity !== undefined) {
    if (payload.workflowDispatchIdentity === undefined) {
      throw new Error("canonical workflow stage requires immutable dispatch identity");
    }
    const identity = parseDispatchIdentity(payload.workflowDispatchIdentity);
    if (!decisionsMatch(identity.decision, decision)) {
      throw new Error("saved provider decision does not match immutable workflow dispatch identity");
    }
    if (payload.sessionId !== identity.sessionId) {
      throw new Error("workflow session does not match immutable dispatch identity");
    }
  }
  if (run.stage === "review:auditor" || run.stage === "review:critic") {
    const identity = parseDispatchIdentity(payload.reviewDispatchIdentity);
    if (!decisionsMatch(identity.decision, decision)) {
      throw new Error("saved provider decision does not match immutable review dispatch identity");
    }
    if (
      payload.sessionId !== identity.sessionId ||
      payload.reviewAttemptId !== identity.attemptId ||
      payload.reviewAttemptOrdinal !== identity.attemptOrdinal
    ) {
      throw new Error("review attempt does not match immutable dispatch identity");
    }
  }
  const approvalReference =
    typeof payload.approvalReference === "string" ? payload.approvalReference : undefined;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  if (payload.toolAllowlist !== undefined) {
    throw new Error("tool allowlist must be derived by the trusted runner");
  }
  const stage = STAGES.includes(run.stage as Stage) ? run.stage as Stage : null;
  if (decision.agent === "grok" && scope === "workspace-write" && stage === null) {
    throw new Error("Grok workspace-write requires a canonical stage");
  }
  const toolAllowlist = decision.agent === "grok" && scope === "workspace-write"
    ? grokWorkspaceWriteToolAllowlist(stage!)
    : undefined;
  return {
    project: payload.project,
    prompt: payload.prompt,
    approvalScope: scope,
    ...(approvalReference ? { approvalReference } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(toolAllowlist ? { toolAllowlist } : {}),
    decision,
  };
}

class ExecaProcessLauncher implements ProcessLauncher {
  launch(command: CommandSpec): LaunchedProcess {
    const subprocess = execa(command.file, command.args, {
      cwd: command.cwd,
      input: command.stdin,
      shell: false,
      detached: process.platform !== "win32",
      reject: false,
      all: false,
      cleanup: true,
      env: { AGENT_COLLAB_PROTOCOL: PROTOCOL },
    });
    return {
      ...(subprocess.pid === undefined ? {} : { pid: subprocess.pid }),
      result: subprocess.then((result) => ({
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
      })),
      terminate: (signal) => {
        if (subprocess.pid !== undefined && process.platform !== "win32") {
          try { process.kill(-subprocess.pid, signal); } catch { /* process group already exited */ }
        } else {
          subprocess.kill(signal);
        }
      },
    };
  }
}

export const classifyRunnerFailure = (error: unknown, stderr = "") => {
  const message = `${error instanceof Error ? error.message : String(error)} ${stderr}`.toLowerCase();
  if (/enoent|not found/.test(message)) return "cli_missing" as const;
  if (/timed?\s*out|timeout/.test(message)) return "network_timeout" as const;
  if (/rate.?limit|429/.test(message)) return "rate_limit" as const;
  if (/quota|usage limit/.test(message)) return "quota" as const;
  if (/auth|login|not logged|credential/.test(message)) return "auth" as const;
  if (/overload|unavailable|capacity|model identity mismatch|protocol mismatch|reasoning effort mismatch|malformed .* (?:stream|parse)|incomplete .* (?:stream|result)|nonterminal/.test(message)) {
    return "model_unavailable" as const;
  }
  if (/permission|denied/.test(message)) return "permission_denial" as const;
  if (/invalid request|bad request/.test(message)) return "invalid_request" as const;
  return "task_failure" as const;
};

export class AgentRunner {
  private readonly launcher: ProcessLauncher;

  constructor(private readonly config: AgentRunnerConfig) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("runner timeout must be a positive integer");
    }
    this.launcher = config.launcher ?? new ExecaProcessLauncher();
  }

  private command(payload: TaskPayload): CommandSpec {
    const prompt = payload.decision.agent === "grok"
      ? `${payload.prompt}\n\nReturn the visible final answer only as valid JSON with exactly these keys: ` +
        `{"protocolVersion":"${PROTOCOL}","reasoningEffort":"${payload.decision.effort}","visibleText":"<your final answer>"}.`
      : payload.prompt;
    const common = {
      binary: this.config.binaries[payload.decision.agent],
      cwd: payload.project,
      prompt,
      approvalScope: payload.approvalScope,
      ...(payload.approvalReference ? { approvalReference: payload.approvalReference } : {}),
      effort: payload.decision.effort,
      timeoutMs: this.config.timeoutMs,
    };
    return payload.decision.agent === "grok"
      ? buildProviderCommand({
          agent: "grok",
          command: {
            ...common,
            sessionId: payload.sessionId ?? "",
            ...(payload.toolAllowlist ? { toolAllowlist: payload.toolAllowlist } : {}),
          },
        })
      : buildProviderCommand({ agent: "codex", command: common });
  }

  async run(
    run: ProcessTask,
    onLaunch: (info: Record<string, unknown>) => void = () => undefined,
  ): Promise<Record<string, unknown>> {
    let payload: TaskPayload;
    let command: CommandSpec;
    try {
      payload = taskPayload(run);
      command = this.command(payload);
    } catch (error) {
      return {
        kind: "invalid_request",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      onLaunch({
        phase: "intent",
        pid: null,
        agent: payload.decision.agent,
        model: payload.decision.model,
        effort: payload.decision.effort,
        policyVersion: payload.decision.policyVersion,
        sessionId: payload.sessionId ?? null,
      });
    } catch (error) {
      return {
        kind: "task_failure",
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let launched: LaunchedProcess;
    try {
      launched = this.launcher.launch(command);
    } catch (error) {
      const kind = classifyRunnerFailure(error);
      return {
        kind,
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      onLaunch({
        phase: "started",
        pid: launched.pid ?? null,
        agent: payload.decision.agent,
        model: payload.decision.model,
        effort: payload.decision.effort,
        policyVersion: payload.decision.policyVersion,
        sessionId: payload.sessionId ?? null,
      });
    } catch (error) {
      await terminateProcess(launched, "SIGTERM");
      await terminateProcess(launched, "SIGKILL");
      return {
        kind: "task_failure",
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(async () => {
        timedOut = true;
        await terminateProcess(launched, "SIGTERM");
        await delay(2_000);
        await terminateProcess(launched, "SIGKILL");
        reject(new Error("agent process group timeout"));
      }, command.timeoutMs);
      timer.unref();
    });
    try {
      const result = await Promise.race([launched.result, timeout]);
      if (timedOut) await timeout;
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`agent exited ${result.exitCode}`), { stderr: result.stderr });
      }
      const normalized =
        payload.decision.agent === "grok"
          ? normalizeGrokResult(result.stdout, {
              expectedEffort: payload.decision.effort,
              expectedProtocolVersion: PROTOCOL,
            })
          : normalizeCodexResult(result.stdout);
      if (normalized.model !== payload.decision.model) {
        throw new Error(`model identity mismatch: ${normalized.model}`);
      }
      return {
        kind: "success",
        agent: payload.decision.agent,
        model: payload.decision.model,
        effort: payload.decision.effort,
        policyVersion: payload.decision.policyVersion,
        reasons: [...payload.decision.reasons],
        text: normalized.text,
      };
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? redactSensitive(String(error.stderr))
        : "";
      return {
        kind: classifyRunnerFailure(error, stderr),
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
        ...(stderr ? { logs: [stderr] } : {}),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
