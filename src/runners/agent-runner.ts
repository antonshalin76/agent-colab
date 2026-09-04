import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import {
  ROUTING_POLICY_VERSION,
  PROVIDER_EFFORT_PROFILES,
  STAGES,
  STAGE_POLICY,
  constrainEffortForAgent,
  increaseRequestedEffort,
  type ActiveAgentId,
  type ApprovalScope,
  type Effort,
  type ProviderModel,
  type ReviewProviderId,
  type Stage,
} from "../domain/routing.js";
import { classifyProviderFailure, classifyProviderFailureDetail } from "../domain/outcomes.js";
import { redactSensitive } from "../security/redaction.js";
import { ApprovalLedger } from "../security/approval-ledger.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import {
  carryQuarantinedProviderTelemetry,
  mapProviderTelemetryOutcome,
  type ProviderSessionRef,
  type ProviderTelemetryOutcome,
  type ProviderTerminalTelemetry,
} from "../runtime/provider-telemetry.js";
import type { UsageTelemetry } from "../runtime/flow-telemetry.js";
import { normalizeCodexResult } from "./codex.js";
import { normalizeGrokResult } from "./grok.js";
import type { GrokEffort } from "./grok.js";
import { normalizeClaudeResult } from "./claude.js";
import { buildProviderCommand, prepareCommandInput, type CommandSpec } from "./provider-command.js";
import {
  assertCurrentControlMapLearningLaunchBinding,
  verifyCurrentMapProfile,
  type VerifiedMapProfile,
} from "../flow/map-admin.js";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { openStateDatabaseLease } from "../store/state-database-fence.js";
import { CollaborationRunStore } from "../store/collaboration-run-store.js";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import { ExecutionAdmission } from "../runtime/execution-admission.js";
import { ExecutionSnapshotBindingSchema } from "../flow/execution-snapshot.js";
import type { AttemptAssignment } from "../workflow/workflow.js";

const PROTOCOL = "agent-collab/v2";
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const EFFORT_MODIFIERS = [
  "degraded_fallback",
  "retry",
  "external_scope",
  "large_artifact",
  "broad_change_set",
] as const;
const LIMIT_REASON = /^(provider_policy_limit:gpt-5\.6-sol:xhigh|model_capability_limit:grok-4\.6:xhigh|model_capability_limit:glm-5\.3:max)$/;
const NOOP_LAUNCH_INFO = (_info: Record<string, unknown>): void => undefined;
const NOOP_NO_SPAWN = (): void => undefined;

export interface SavedRunnerDecision {
  agent: ReviewProviderId;
  model: ProviderModel;
  effort: Effort;
  policyVersion: typeof ROUTING_POLICY_VERSION;
  reasons: readonly string[];
}

export interface ProcessTask {
  id: string;
  stage?: string;
  artifactHash?: string;
  idempotencyKey?: string;
  approvalScope?: string;
  payload?: Record<string, unknown>;
}

interface TaskPayload {
  project: string;
  prompt: string;
  sourceFingerprint: string;
  approvalScope: ApprovalScope;
  authorizationConsumerKey?: string;
  sessionId?: string;
  mapLearning: ReturnType<typeof assertCurrentControlMapLearningLaunchBinding>;
  decision: SavedRunnerDecision;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LaunchedProcess {
  pid: number;
  result: Promise<ProcessResult>;
  terminate(signal: "SIGTERM" | "SIGKILL"): void | Promise<void>;
}

export interface ProcessLauncher {
  launch(command: CommandSpec): LaunchedProcess;
}

export interface AgentRunnerConfig {
  binaries: Readonly<Record<ReviewProviderId, string>>;
  timeoutMs: number;
  authorizationDatabasePath?: string;
  launcher?: ProcessLauncher;
  mapProfileVerifier?: () => VerifiedMapProfile;
  /** @internal */
  preLaunchMapLearningCheckpoint?: (binding: TaskPayload["mapLearning"]) => void;
}

async function terminateProcess(
  launched: LaunchedProcess,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  try { await launched.terminate(signal); } catch { /* process group already exited */ }
}

function commandPinnedProviderSession(payload: TaskPayload): ProviderSessionRef | null {
  return payload.decision.agent === "codex" || payload.sessionId === undefined
    ? null
    : { value: payload.sessionId, provenance: "command_pinned" };
}

function runnerResultWithQuarantinedTelemetry(
  result: Record<string, unknown>,
  telemetryObservation: ProviderTerminalTelemetry,
): Record<string, unknown> {
  return carryQuarantinedProviderTelemetry(result, telemetryObservation);
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
  agent: ReviewProviderId,
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
  const expectedBaseline = agent === "claude"
    ? STAGE_POLICY[stage].baselineEffort.codex
    : STAGE_POLICY[stage].baselineEffort[agent];
  if (expectedBaseline !== baselineEffort) return false;
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
  if (!input || (input.agent !== "grok" && input.agent !== "claude" && input.agent !== "codex")) {
    throw new Error("run payload is missing a saved provider decision");
  }
  const expectedModel = PROVIDER_EFFORT_PROFILES[input.agent].model;
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

function taskPayload(
  run: ProcessTask,
  verifyMapProfile: () => VerifiedMapProfile,
  trustedDatabasePath?: string,
): TaskPayload {
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
  if (workflowRun && decision.agent !== "codex") {
    throw new Error("routing-v5 permits alternative providers only in isolated review lanes");
  }
  if (decision.agent !== "codex" && scope !== "workspace-read") {
    throw new Error("alternative-provider review lanes are read-only");
  }
  const mapLearning = assertCurrentControlMapLearningLaunchBinding(
    decision.agent,
    payload.mapLearning,
    payload.prompt,
  );
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
    if (typeof run.idempotencyKey !== "string" ||
        typeof payload.workflowDispatchId !== "string" ||
        run.idempotencyKey !== payload.workflowDispatchId) {
      throw new Error("workflow queue identity does not match its immutable dispatch id");
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
      payload.reviewAttemptOrdinal !== identity.attemptOrdinal ||
      typeof run.idempotencyKey !== "string" || payload.reviewDispatchId !== run.idempotencyKey
    ) {
      throw new Error("review attempt does not match immutable dispatch identity");
    }
  }
  const authorizationConsumerKey = typeof payload.authorizationConsumerKey === "string"
    ? payload.authorizationConsumerKey
    : undefined;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  if (payload.toolAllowlist !== undefined) {
    throw new Error("tool allowlist must be derived by the trusted runner");
  }
  if (typeof payload.sourceFingerprint !== "string" ||
      (payload.requester !== "grok" && payload.requester !== "codex")) {
    throw new Error("run source or requester identity is missing");
  }
  if (workflowRun) {
    if (typeof payload.workflowId !== "string" || typeof payload.workflowStageId !== "string" ||
        typeof run.artifactHash !== "string" || trustedDatabasePath === undefined) {
      throw new Error("workflow run lacks trusted durable execution identity");
    }
    const binding = ExecutionSnapshotBindingSchema.parse(payload.executionSnapshot);
    const lease = openStateDatabaseLease(trustedDatabasePath, "mutating_service");
    const db = lease.database;
    const workflows = new CollaborationRunStore(lease.borrow());
    const reviews = new RunGateUnitOfWork(lease.borrow());
    const approvals = new ApprovalLedger(lease.borrow());
    try {
      const identity = parseDispatchIdentity(payload.workflowDispatchIdentity);
      new ExecutionAdmission(db, workflows, reviews, approvals, verifyMapProfile)
        .assertQueued({ workflowId: payload.workflowId, stageId: payload.workflowStageId,
          dispatchId: run.idempotencyKey!, assignment: { ...identity.decision,
            sessionId: identity.sessionId, attemptId: identity.attemptId,
            attemptOrdinal: identity.attemptOrdinal, degraded: identity.degraded } as AttemptAssignment,
          agent: decision.agent as ActiveAgentId, artifactHash: run.artifactHash, project: payload.project,
          prompt: payload.prompt, requester: payload.requester,
          sourceFingerprint: payload.sourceFingerprint, approvalScope: scope,
          ...(authorizationConsumerKey ? { authorizationConsumerKey } : {}), binding });
    } finally {
      approvals.close(); reviews.close(); workflows.close(); lease.close();
    }
  } else {
    if (payload.executionSnapshot !== undefined || authorizationConsumerKey !== undefined) {
      throw new Error("read-only review lane cannot carry workflow snapshot or authority");
    }
    if (captureWorkspaceFingerprint(payload.project).fingerprint !== payload.sourceFingerprint) {
      throw new Error("review source fingerprint is stale before provider launch");
    }
  }
  return {
    project: payload.project,
    prompt: payload.prompt,
    sourceFingerprint: payload.sourceFingerprint,
    approvalScope: scope,
    ...(authorizationConsumerKey ? { authorizationConsumerKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    mapLearning,
    decision,
  };
}

class ExecaProcessLauncher implements ProcessLauncher {
  launch(command: CommandSpec): LaunchedProcess {
    const prepared = prepareCommandInput(command);
    let subprocess;
    try {
      subprocess = execa(command.file, prepared.args, {
      cwd: command.cwd,
      ...(prepared.input !== undefined ? { input: prepared.input } : {}),
      shell: false,
      detached: process.platform !== "win32",
      reject: false,
      all: false,
      cleanup: true,
      env: { AGENT_COLLAB_PROTOCOL: PROTOCOL, AGENT_COLLAB_RUN: "1" },
      });
    } catch (error) {
      prepared.cleanup();
      throw error;
    }
    if (subprocess.pid === undefined) {
      void subprocess.catch(() => undefined);
      prepared.cleanup();
      throw Object.assign(new Error(`agent process did not start: ${command.file}`), {
        code: "ENOENT",
      });
    }
    return {
      pid: subprocess.pid,
      result: subprocess.then((result) => ({
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
        })).finally(prepared.cleanup),
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

export const classifyRunnerFailure = classifyProviderFailure;

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
    if (payload.decision.agent === "grok") {
      return buildProviderCommand({
        agent: "grok",
        command: {
          binary: this.config.binaries.grok,
          cwd: payload.project,
          prompt,
          approvalScope: "workspace-read",
          sessionId: payload.sessionId ?? "",
          effort: payload.decision.effort as GrokEffort,
          timeoutMs: this.config.timeoutMs,
        },
      });
    }
    if (payload.decision.agent === "claude") {
      return buildProviderCommand({
        agent: "claude",
        command: {
          binary: this.config.binaries.claude,
          cwd: payload.project,
          prompt,
          approvalScope: "workspace-read",
          sessionId: payload.sessionId ?? "",
          effort: payload.decision.effort,
          timeoutMs: this.config.timeoutMs,
        },
      });
    }
    return buildProviderCommand({
      agent: "codex",
      command: {
        binary: this.config.binaries.codex,
        cwd: payload.project,
        prompt,
        approvalScope: payload.approvalScope,
        ...(payload.authorizationConsumerKey
          ? { authorizationConsumerKey: payload.authorizationConsumerKey }
          : {}),
        effort: payload.decision.effort,
        timeoutMs: this.config.timeoutMs,
      },
    });
  }

  async run(
    run: ProcessTask,
    onLaunch: (info: Record<string, unknown>) => void = NOOP_LAUNCH_INFO,
    onLaunchIntent: (info: Record<string, unknown>) => void = NOOP_LAUNCH_INFO,
    onProvenNoSpawn: () => void = NOOP_NO_SPAWN,
  ): Promise<Record<string, unknown>> {
    let payload: TaskPayload;
    let command: CommandSpec;
    try {
      payload = taskPayload(
        run,
        this.config.mapProfileVerifier ?? verifyCurrentMapProfile,
        this.config.authorizationDatabasePath,
      );
      command = this.command(payload);
    } catch (error) {
      return {
        kind: "invalid_request",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      this.config.preLaunchMapLearningCheckpoint?.(payload.mapLearning);
      const revalidated = taskPayload(
        run,
        this.config.mapProfileVerifier ?? verifyCurrentMapProfile,
        this.config.authorizationDatabasePath,
      );
      if (!isDeepStrictEqual(revalidated, payload)) {
        throw new Error("run admission payload changed before provider launch");
      }
    } catch (error) {
      return {
        kind: "invalid_request",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      onLaunchIntent({
        phase: "launching",
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

    try {
      const finalAdmission = taskPayload(
        run,
        this.config.mapProfileVerifier ?? verifyCurrentMapProfile,
        this.config.authorizationDatabasePath,
      );
      if (!isDeepStrictEqual(finalAdmission, payload)) {
        throw new Error("run admission payload changed after launch intent");
      }
    } catch (error) {
      try {
        onProvenNoSpawn();
      } catch (clearError) {
        return { kind: "task_failure", agent: payload.decision.agent,
          error: clearError instanceof Error ? clearError.message : String(clearError) };
      }
      return { kind: "invalid_request", agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error) };
    }

    let launched: LaunchedProcess;
    try {
      launched = this.launcher.launch(command);
    } catch (error) {
      try {
        onProvenNoSpawn();
      } catch (clearError) {
        return runnerResultWithQuarantinedTelemetry({
          kind: "task_failure",
          agent: payload.decision.agent,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        }, mapProviderTelemetryOutcome({
          provider: payload.decision.agent,
          providerSessionRef: null,
          outcome: "pre_session_failure",
          usageReport: null,
        }));
      }
      const kind = classifyRunnerFailure(error);
      return runnerResultWithQuarantinedTelemetry({
        kind,
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
      }, mapProviderTelemetryOutcome({
        provider: payload.decision.agent,
        providerSessionRef: null,
        outcome: "pre_session_failure",
        usageReport: null,
      }));
    }
    if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0) {
      void launched.result.catch(() => undefined);
      await terminateProcess(launched, "SIGTERM");
      return runnerResultWithQuarantinedTelemetry({
        kind: "cli_missing",
        agent: payload.decision.agent,
        error: "agent launcher returned without a started process id",
      }, mapProviderTelemetryOutcome({
        provider: payload.decision.agent,
        providerSessionRef: null,
        outcome: "pre_session_failure",
        usageReport: null,
      }));
    }
    try {
      onLaunch({
        phase: "started",
        pid: launched.pid,
        agent: payload.decision.agent,
        model: payload.decision.model,
        effort: payload.decision.effort,
        policyVersion: payload.decision.policyVersion,
        sessionId: payload.sessionId ?? null,
      });
    } catch (error) {
      await terminateProcess(launched, "SIGTERM");
      await terminateProcess(launched, "SIGKILL");
      return runnerResultWithQuarantinedTelemetry({
        kind: "task_failure",
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
      }, mapProviderTelemetryOutcome({
        provider: payload.decision.agent,
        providerSessionRef: commandPinnedProviderSession(payload),
        outcome: "provider_failure",
        usageReport: null,
      }));
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
    let terminalOutcome: Exclude<ProviderTelemetryOutcome, "succeeded" | "pre_session_failure"> =
      "provider_failure";
    try {
      const result = await Promise.race([launched.result, timeout]);
      if (timedOut) await timeout;
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`agent exited ${result.exitCode}`), { stderr: result.stderr });
      }
      terminalOutcome = "malformed_terminal";
      let text: string;
      let model: ProviderModel;
      let providerSessionRef: ProviderSessionRef;
      let usageReport: UsageTelemetry | null;
      if (payload.decision.agent === "grok") {
        const normalized = normalizeGrokResult(result.stdout, {
          expectedEffort: payload.decision.effort as GrokEffort,
          expectedProtocolVersion: PROTOCOL,
          expectedSessionId: payload.sessionId ?? "",
          includeUsage: true,
          allowPlainVisibleText: true,
        });
        text = normalized.text;
        model = normalized.model;
        providerSessionRef = normalized.providerSessionRef;
        usageReport = normalized.usage;
      } else if (payload.decision.agent === "claude") {
        const normalized = normalizeClaudeResult(result.stdout, {
          expectedSessionId: payload.sessionId ?? "",
          expectedEffort: payload.decision.effort,
        });
        text = normalized.text;
        model = normalized.model;
        providerSessionRef = normalized.providerSessionRef;
        usageReport = null;
      } else {
        const normalized = normalizeCodexResult(result.stdout, { includeUsage: true });
        text = normalized.text;
        model = normalized.model;
        providerSessionRef = normalized.providerSessionRef;
        usageReport = normalized.usage;
      }
      if (model !== payload.decision.model) {
        throw new Error(`model identity mismatch: ${model}`);
      }
      return runnerResultWithQuarantinedTelemetry({
        kind: "success",
        agent: payload.decision.agent,
        model: payload.decision.model,
        effort: payload.decision.effort,
        policyVersion: payload.decision.policyVersion,
        reasons: [...payload.decision.reasons],
        text,
      }, mapProviderTelemetryOutcome({
        provider: payload.decision.agent,
        providerSessionRef,
        outcome: "success",
        usageReport,
      }));
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? redactSensitive(String(error.stderr))
        : "";
      return runnerResultWithQuarantinedTelemetry({
        ...classifyProviderFailureDetail(error, stderr),
        agent: payload.decision.agent,
        error: error instanceof Error ? error.message : String(error),
        ...(stderr ? { logs: [stderr] } : {}),
      }, mapProviderTelemetryOutcome({
        provider: payload.decision.agent,
        providerSessionRef: commandPinnedProviderSession(payload),
        outcome: timedOut ? "timeout" : terminalOutcome,
        usageReport: null,
      }));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
