import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCodexResult } from "../src/runners/codex.js";
import { normalizeGrokResult } from "../src/runners/grok.js";
import type { CommandSpec } from "../src/runners/provider-command.js";
import { discoverProviderVersion } from "../src/probes/provider-version.js";
import {
  buildEvalProviderCommand,
  buildContainedEvalProviderCommand,
  buildEvalContainment,
  buildEvalProtocolPrompt,
  classifyEvalProviderFailure,
  NodeEvalProcessLauncher,
  runEvalProviderAttempt,
  verifyEvalProviderCommand,
  type EvalProcessLauncher,
} from "../src/eval/provider.js";

const protocolVersion = "agent-collab/v2";
const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !pidExists(pid);
}

const usage = (
  inputTokens: number | null,
  cachedInputTokens: number | null,
  outputTokens: number | null,
  reasoningTokens: number | null,
  totalTokens: number | null,
  costUsd: number | null,
  provenance: Partial<Record<
    "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens" | "costUsd",
    "provider_reported" | "derived" | "unavailable"
  >>,
) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningTokens,
  totalTokens,
  costUsd,
  provenance: {
    inputTokens: "unavailable",
    cachedInputTokens: "unavailable",
    outputTokens: "unavailable",
    reasoningTokens: "unavailable",
    totalTokens: "unavailable",
    costUsd: "unavailable",
    ...provenance,
  },
});

// Sanitized exact `codex exec --json` record shapes from Codex CLI 0.147.0.
function codex0147SanitizedExecStream(response = {
  protocolVersion,
  reasoningEffort: "high",
  visibleText: "visible current Codex answer",
}): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-eval-current" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "reasoning", text: "PRIVATE_CURRENT_REASONING_SENTINEL" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "read /private/CURRENT_TOOL_ARGUMENT_SENTINEL",
        aggregated_output: "CURRENT_TOOL_RESULT_SENTINEL",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify(response),
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 30,
        output_tokens: 18,
        total_tokens: 138,
      },
    }),
  ].join("\n") + "\n";
}

function legacyCodexStream(): string {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-eval-legacy", model: "gpt-5.6-sol" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ text: "PRIVATE_LEGACY_REASONING_SENTINEL" }],
        encrypted_content: "PRIVATE_LEGACY_ENCRYPTED_SENTINEL",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        arguments: { path: "/private/LEGACY_TOOL_ARGUMENT_SENTINEL" },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible legacy Codex answer" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", output: "LEGACY_TOOL_RESULT_SENTINEL" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 210,
            cached_input_tokens: 64,
            output_tokens: 27,
            reasoning_output_tokens: 9,
            total_tokens: 237,
          },
        },
      },
    }),
  ].join("\n") + "\n";
}

// Sanitized exact terminal envelope shape from Grok CLI 1.0.5.
function grok105SanitizedTerminalEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stopReason: "end_turn",
    sessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
    modelUsage: {
      "grok-4.6": {
        inputTokens: 150,
        cacheReadInputTokens: 40,
        outputTokens: 31,
        reasoningTokens: 11,
        totalTokens: 181,
        costUSD: 0.0042,
      },
    },
    text: JSON.stringify({
      protocolVersion,
      reasoningEffort: "high",
      visibleText: "visible Grok answer",
    }),
    thought: "PRIVATE_GROK_REASONING_SENTINEL",
    tool_arguments: { path: "/private/GROK_TOOL_ARGUMENT_SENTINEL" },
    tool_result: "GROK_TOOL_RESULT_SENTINEL",
    ...overrides,
  });
}

describe("paired benchmark provider output normalization", () => {
  it("normalizes the sanitized exact Codex CLI 0.147.0 exec JSONL without persisting private records", () => {
    const normalized = normalizeCodexResult(codex0147SanitizedExecStream(), {
      includeUsage: true,
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      pinnedModel: "gpt-5.6-sol",
    });

    expect(normalized).toEqual({
      text: "visible current Codex answer",
      model: "gpt-5.6-sol",
      modelProvenance: "command_pinned",
      effort: "high",
      protocolVersion,
      usage: usage(120, 30, 18, null, 138, null, {
        inputTokens: "provider_reported",
        cachedInputTokens: "provider_reported",
        outputTokens: "provider_reported",
        totalTokens: "provider_reported",
      }),
    });
    expect(JSON.stringify(normalized)).not.toMatch(/PRIVATE_CURRENT|CURRENT_TOOL|\/private/);
  });

  it("uses the last schema-valid Codex agent message after tool progress", () => {
    const stream = codex0147SanitizedExecStream().replace(
      /\{"type":"item\.completed","item":\{"type":"agent_message"/,
      `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            protocolVersion,
            reasoningEffort: "high",
            visibleText: "progress",
          }),
        },
      })}\n{"type":"item.completed","item":{"type":"agent_message"`,
    );
    const normalized = normalizeCodexResult(stream, {
      includeUsage: true,
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      pinnedModel: "gpt-5.6-sol",
    });
    expect(normalized.text).toBe("visible current Codex answer");
  });

  it("normalizes legacy Codex rollout JSONL and selects last-turn rather than cumulative usage", () => {
    const normalized = normalizeCodexResult(legacyCodexStream(), { includeUsage: true });

    expect(normalized).toEqual({
      text: "visible legacy Codex answer",
      model: "gpt-5.6-sol",
      usage: usage(210, 64, 27, 9, 237, null, {
        inputTokens: "provider_reported",
        cachedInputTokens: "provider_reported",
        outputTokens: "provider_reported",
        reasoningTokens: "provider_reported",
        totalTokens: "provider_reported",
      }),
    });
    expect(JSON.stringify(normalized)).not.toMatch(/PRIVATE_LEGACY|LEGACY_TOOL|\/private/);
  });

  it("normalizes the sanitized exact Grok CLI 1.0.5 terminal envelope with reported usage and cost", () => {
    const normalized = normalizeGrokResult(grok105SanitizedTerminalEnvelope(), {
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      includeUsage: true,
    });

    expect(normalized).toEqual({
      text: "visible Grok answer",
      model: "grok-4.6",
      providerReportedModel: "grok-4.6",
      modelProvenance: "provider_reported_alias",
      effort: "high",
      protocolVersion,
      visibleTextProvenance: "provider_structured",
      usage: usage(150, 40, 31, 11, 181, 0.0042, {
        inputTokens: "provider_reported",
        cachedInputTokens: "provider_reported",
        outputTokens: "provider_reported",
        reasoningTokens: "provider_reported",
        totalTokens: "provider_reported",
        costUsd: "provider_reported",
      }),
    });
    expect(JSON.stringify(normalized)).not.toMatch(/PRIVATE_GROK|GROK_TOOL|\/private/);
  });

  it("accepts Grok 1.0.5 plain terminal text only when the exact command-pinned eval contract allows it", () => {
    const envelope = grok105SanitizedTerminalEnvelope({
      text: "completed after tool execution",
      structuredOutput: undefined,
    });
    expect(() => normalizeGrokResult(envelope, {
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      includeUsage: true,
    })).toThrow(/visible result parse/i);

    expect(normalizeGrokResult(envelope, {
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      includeUsage: true,
      allowPlainVisibleText: true,
    })).toMatchObject({
      text: "completed after tool execution",
      model: "grok-4.6",
      effort: "high",
      protocolVersion,
      visibleTextProvenance: "command_pinned_plain_text",
    });
  });

  it("records the provider-reported grok-4.6-build id behind the exact grok-4.6 CLI alias", () => {
    const normalized = normalizeGrokResult(grok105SanitizedTerminalEnvelope({
      usage: { reasoning_tokens: 11, total_tokens: 181 },
      modelUsage: {
        "grok-4.6-build": {
          inputTokens: 150,
          cacheReadInputTokens: 40,
          outputTokens: 31,
          costUSD: 0.0042,
        },
      },
    }), {
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      includeUsage: true,
    });

    expect(normalized).toMatchObject({
      model: "grok-4.6",
      providerReportedModel: "grok-4.6-build",
      modelProvenance: "provider_reported_alias",
      usage: { reasoningTokens: 11, totalTokens: 181 },
    });
  });

  it("keeps unavailable telemetry null with explicit provenance instead of inventing zero", () => {
    expect(() => normalizeCodexResult(codex0147SanitizedExecStream().replace(
      /\{"type":"turn.completed".*\}\n$/,
      "",
    ), {
      includeUsage: true,
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      pinnedModel: "gpt-5.6-sol",
    })).toThrow(/missing terminal/i);
    const grok = normalizeGrokResult(grok105SanitizedTerminalEnvelope({
      modelUsage: { "grok-4.6": { inputTokens: 8, outputTokens: 2 } },
    }), {
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      includeUsage: true,
    });

    expect(grok.usage).toEqual(usage(8, null, 2, null, null, null, {
      inputTokens: "provider_reported",
      outputTokens: "provider_reported",
    }));
  });

  it.each([
    ["protocol", { protocolVersion: "agent-collab/v1", reasoningEffort: "high", visibleText: "x" }, /protocol/i],
    ["effort", { protocolVersion, reasoningEffort: "low", visibleText: "x" }, /effort/i],
  ] as const)("rejects a current Codex response with nested %s drift", (_name, payload, error) => {
    expect(() => normalizeCodexResult(codex0147SanitizedExecStream(payload), {
      includeUsage: true,
      expectedEffort: "high",
      expectedProtocolVersion: protocolVersion,
      pinnedModel: "gpt-5.6-sol",
    })).toThrow(error);
  });
});

describe("paired benchmark provider containment", () => {
  const candidateStateRoot = "/run/agent-collab/state";

  it("default-denies every host path outside the attempt and mounts state outside its workspace", () => {
    const root = makeRoot("agent-collab-eval-containment-");
    const attemptRoot = join(root, "attempt");
    const stateRoot = join(root, "private-state");
    const sourceCheckout = join(root, "source-checkout");
    const sharedMemory = join(root, "shared-memory");
    const priorTranscript = join(root, "prior-transcript");
    const ordinaryHome = join(root, "ordinary-home");
    const ordinaryXdg = join(root, "ordinary-xdg");
    const ordinaryCodex = join(root, "ordinary-codex");
    const ordinaryGrok = join(root, "ordinary-grok");
    for (const path of [
      attemptRoot,
      sourceCheckout,
      sharedMemory,
      priorTranscript,
      ordinaryHome,
      ordinaryXdg,
      ordinaryCodex,
      ordinaryGrok,
    ]) mkdirSync(path, { recursive: true });
    mkdirSync(join(root, "shared-skills"), { recursive: true });
    writeFileSync(join(root, "codex-auth.json"), "{}\n");

    const original: CommandSpec = {
      file: "/fake/codex",
      args: ["exec", "--json", "-"],
      cwd: attemptRoot,
      stdin: "frozen task",
      shell: false,
      timeoutMs: 100,
      killProcessGroup: true,
    };
    const contained = buildEvalContainment({
      agent: "codex",
      command: original,
      attemptRoot,
      stateRoot,
      authFile: join(root, "codex-auth.json"),
      skillRoot: join(root, "shared-skills"),
    });

    expect(stateRoot.startsWith(`${attemptRoot}/`)).toBe(false);
    expect(contained.env).toMatchObject({
      HOME: join(candidateStateRoot, "home"),
      XDG_CONFIG_HOME: join(candidateStateRoot, "xdg", "config"),
      XDG_DATA_HOME: join(candidateStateRoot, "xdg", "data"),
      XDG_CACHE_HOME: join(candidateStateRoot, "xdg", "cache"),
      XDG_STATE_HOME: join(candidateStateRoot, "xdg", "state"),
      CODEX_HOME: join(candidateStateRoot, "codex"),
      GROK_HOME: join(candidateStateRoot, "grok"),
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTEST_ADDOPTS: "-p no:cacheprovider",
    });
    expect(Object.entries(contained.env as Record<string, string>)
      .filter(([name]) => ![
        "TMPDIR", "LANG", "LC_ALL", "TZ", "PYTHONDONTWRITEBYTECODE", "PYTEST_ADDOPTS",
      ].includes(name))
      .map(([, path]) => path)
      .every((path) => path.startsWith(`${candidateStateRoot}/`))).toBe(true);
    expect(contained).toMatchObject({
      defaultDenyOutsideAttempt: true,
      state: { hostRoot: stateRoot, candidateRoot: candidateStateRoot },
    });
    expect(contained.command.file).toMatch(/(?:^|\/)bwrap$/);
    expect(contained.command.args).toEqual(expect.arrayContaining([
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--clearenv",
    ]));
    expect(contained.command.args).not.toContain("--share-net");
    expect(contained.command.args.some((arg, index, args) =>
      arg === "--tmpfs" && args[index + 1] === "/")).toBe(true);
    expect(contained.command.args.some((arg, index, args) =>
      arg === "--bind" && args[index + 1] === attemptRoot && args[index + 2] === attemptRoot)).toBe(true);
    expect(contained.command.args.some((arg, index, args) =>
      arg === "--bind" && args[index + 1] === stateRoot && args[index + 2] === candidateStateRoot)).toBe(true);
    expect(contained.command.args).toEqual(expect.arrayContaining([
      "--ro-bind", join(root, "codex-auth.json"), join(candidateStateRoot, "codex", "auth.json"),
      "--ro-bind", realpathSync(join(root, "shared-skills")), join(candidateStateRoot, "codex", "skills"),
    ]));
    expect(contained.command.args.join(" ")).not.toMatch(/history|transcript|session_index|memories/i);
    expect(contained.command.args.some((arg, index, args) =>
      arg === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/")).toBe(false);
    for (const hiddenHostPath of [sourceCheckout, sharedMemory, priorTranscript]) {
      expect(contained.command.args).not.toContain(hiddenHostPath);
    }
    expect(contained.command.args.some((arg, index, args) =>
      (arg === "--bind" || arg === "--ro-bind") &&
      args[index + 1] === root && args[index + 2] === root)).toBe(false);
    const separator = contained.command.args.lastIndexOf("--");
    expect(contained.command.args.slice(separator + 1)).toEqual([original.file, ...original.args]);

    for (const ordinaryRoot of [ordinaryHome, ordinaryXdg, ordinaryCodex, ordinaryGrok]) {
      expect(readdirSync(ordinaryRoot)).toEqual([]);
    }
  });

  it("enables provider network only through an explicit containment opt-in", () => {
    const root = makeRoot("agent-collab-eval-network-");
    const attemptRoot = join(root, "attempt");
    const stateRoot = join(root, "state");
    const authFile = join(root, "grok-auth.json");
    const skillRoot = join(root, "skills");
    mkdirSync(attemptRoot, { recursive: true });
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(authFile, "{}\n");
    const command: CommandSpec = {
      file: "/fake/grok", args: [], cwd: attemptRoot, stdin: "", shell: false,
      timeoutMs: 100, killProcessGroup: true,
    };
    const offline = buildEvalContainment({
      agent: "grok", command, attemptRoot, stateRoot, authFile, skillRoot,
    });
    const online = buildEvalContainment({
      agent: "grok", command, attemptRoot, stateRoot: join(root, "online-state"),
      authFile, skillRoot, allowProviderNetwork: true,
    });
    expect(offline.command.args).not.toContain("--share-net");
    expect(online.command.args).toContain("--share-net");
  });

  it("resolves live-like Grok ELF and the complete Codex package into executable contained commands", () => {
    const root = makeRoot("agent-collab-eval-packages-");
    const attemptRoot = join(root, "attempt");
    const stateRoot = join(root, "state");
    const skillRoot = join(root, "skills");
    const codexPackage = join(root, "node_modules", "@openai", "codex");
    const codexWrapper = join(codexPackage, "bin", "codex.js");
    const codexNative = join(
      codexPackage, "node_modules", "@openai", "codex-linux-x64", "vendor",
      "x86_64-unknown-linux-musl", "bin", "codex",
    );
    const grokDownload = join(root, "downloads", "grok-linux-x86_64");
    const grokLink = join(root, "bin", "grok");
    for (const path of [attemptRoot, skillRoot, join(codexPackage, "bin"),
      join(codexNative, ".."), join(root, "downloads"), join(root, "bin")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(codexWrapper, "#!/usr/bin/env node\n");
    writeFileSync(codexNative, "#!/bin/sh\nprintf CODEX_PACKAGE_OK\n");
    writeFileSync(grokDownload, "#!/bin/sh\nprintf GROK_ELF_OK\n");
    chmodSync(codexNative, 0o755);
    chmodSync(grokDownload, 0o755);
    symlinkSync("../downloads/grok-linux-x86_64", grokLink);
    const codexAuth = join(root, "codex-auth.json");
    const grokAuth = join(root, "grok-auth.json");
    writeFileSync(codexAuth, "{}\n");
    writeFileSync(grokAuth, "{}\n");

    const common = {
      cwd: attemptRoot, task: "same frozen task", effort: "high" as const,
      timeoutMs: 100, skillRoot, allowProviderNetwork: true,
    };
    const codex = buildContainedEvalProviderCommand({
      ...common, agent: "codex", binary: codexWrapper, authFile: codexAuth,
      stateRoot: join(stateRoot, "codex"),
    });
    const grok = buildContainedEvalProviderCommand({
      ...common, agent: "grok", binary: grokLink, authFile: grokAuth,
      stateRoot: join(stateRoot, "grok"), sessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
    });

    expect(codex.innerCommand.file).toBe(realpathSync(codexNative));
    expect(codex.command.args).toEqual(expect.arrayContaining([
      "--ro-bind", realpathSync(codexPackage), "/opt/agent-collab/codex",
    ]));
    expect(codex.command.args.slice(codex.command.args.lastIndexOf("--") + 1)[0])
      .toContain("/opt/agent-collab/codex/");
    expect(grok.innerCommand.file).toBe(realpathSync(grokDownload));
    expect(grok.command.args).toEqual(expect.arrayContaining([
      "--ro-bind", realpathSync(grokDownload), "/opt/agent-collab/bin/grok",
    ]));
    expect(codex.innerCommand.stdin).toBe(grok.innerCommand.stdin);
    expect(codex.innerCommand.stdin).toBe(buildEvalProtocolPrompt("same frozen task", "high"));
    if (process.platform === "linux" && existsSync("/usr/bin/bwrap")) {
      for (const [launch, output] of [[codex, "CODEX_PACKAGE_OK"], [grok, "GROK_ELF_OK"]] as const) {
        const result = spawnSync(launch.command.file, launch.command.args, {
          cwd: launch.command.cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...launch.env },
          encoding: "utf8",
          input: launch.command.stdin,
          timeout: 1_500,
          shell: false,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(output);
      }
    }
  });

  const localHome = process.env.HOME ?? "";
  const installedCodex = join(localHome, ".local", "bin", "codex");
  const installedGrok = join(localHome, ".grok", "bin", "grok");
  const installedSkills = join(localHome, ".agents", "skills");
  const installedCodexAuth = join(localHome, ".codex", "auth.json");
  const installedGrokAuth = join(localHome, ".grok", "auth.json");
  it.skipIf(process.platform !== "linux" || ![
    installedCodex, installedGrok, installedSkills, installedCodexAuth, installedGrokAuth,
  ].every(existsSync))(
    "resolves the installed provider executable layouts without reading provider history",
    () => {
      const root = makeRoot("agent-collab-eval-installed-layout-");
      const attemptRoot = join(root, "attempt");
      mkdirSync(attemptRoot, { recursive: true });
      const common = {
        cwd: attemptRoot,
        task: "layout-only frozen task",
        effort: "medium" as const,
        timeoutMs: 100,
        skillRoot: installedSkills,
        allowProviderNetwork: true,
      };
      const codex = buildContainedEvalProviderCommand({
        ...common,
        agent: "codex",
        binary: installedCodex,
        authFile: installedCodexAuth,
        stateRoot: join(root, "codex-state"),
      });
      const grok = buildContainedEvalProviderCommand({
        ...common,
        agent: "grok",
        binary: installedGrok,
        authFile: installedGrokAuth,
        stateRoot: join(root, "grok-state"),
        sessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
      });
      expect(codex.innerCommand.file).toMatch(/codex-linux-x64.*\/bin\/codex$/);
      expect(grok.innerCommand.file).toBe(realpathSync(installedGrok));
      for (const launch of [codex, grok]) {
        expect(launch.command.args).toContain("--clearenv");
        expect(launch.command.args).toContain("--share-net");
        expect(launch.command.args.join(" ")).not.toMatch(/history|sessions|transcript|memories/i);
      }
      for (const [launch, version] of [
        [codex, discoverProviderVersion(installedCodex)],
        [grok, discoverProviderVersion(installedGrok)],
      ] as const) {
        const separator = launch.command.args.lastIndexOf("--");
        const args = [...launch.command.args.slice(0, separator + 1), launch.containerExecutable, "--version"];
        const result = spawnSync(launch.command.file, args, {
          cwd: launch.command.cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...launch.env },
          encoding: "utf8",
          input: "",
          timeout: 1_500,
          shell: false,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(version);
      }
    },
  );

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
    "executes the wrapper without reading leakage roots or writing ordinary agent state",
    () => {
      const root = makeRoot("agent-collab-eval-containment-os-");
      const attemptRoot = join(root, "attempt");
      const stateRoot = join(root, "private-state");
      const outsideRoots = [
        join(root, "source-checkout"),
        join(root, "shared-memory"),
        join(root, "prior-transcript"),
        join(root, "arbitrary-unlisted-sibling"),
      ];
      const ordinaryRoots = [
        join(root, "ordinary-home"),
        join(root, "ordinary-xdg"),
        join(root, "ordinary-codex"),
        join(root, "ordinary-grok"),
      ];
      for (const path of [attemptRoot, stateRoot, ...outsideRoots, ...ordinaryRoots]) {
        mkdirSync(path, { recursive: true });
      }
      for (const path of outsideRoots) writeFileSync(join(path, "secret.txt"), "DO_NOT_READ\n");
      const authFile = join(root, "auth.json");
      const skillRoot = join(root, "skills");
      writeFileSync(authFile, "AUTH_MOUNT_SENTINEL\n");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, "SKILL.md"), "SKILL_MOUNT_SENTINEL\n");

      const script = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const outside = process.argv.slice(1, 5);",
        "const hostStateRoot = process.argv[5];",
        "const readable = outside.map((root) => fs.existsSync(path.join(root, \"secret.txt\")));",
        "const hostStateVisible = fs.existsSync(path.join(hostStateRoot, \"host-only-secret.txt\"));",
        "const auth = fs.readFileSync(path.join(process.env.CODEX_HOME, \"auth.json\"), \"utf8\").trim();",
        "const skill = fs.readFileSync(path.join(process.env.CODEX_HOME, \"skills\", \"SKILL.md\"), \"utf8\").trim();",
        "let authReadOnly = false;",
        "try { fs.writeFileSync(path.join(process.env.CODEX_HOME, \"auth.json\"), \"overwrite\"); } catch { authReadOnly = true; }",
        "const inheritedSecret = process.env.EVAL_HOST_SECRET ?? null;",
        'for (const key of ["HOME", "CODEX_HOME", "GROK_HOME"]) {',
        "  fs.mkdirSync(process.env[key], { recursive: true });",
        "  fs.writeFileSync(path.join(process.env[key], \"artifact.txt\"), key);",
        "}",
        "process.stdout.write(JSON.stringify({ readable, hostStateVisible, auth, skill, authReadOnly, inheritedSecret }));",
      ].join("\n");
      const contained = buildEvalContainment({
        agent: "codex",
        command: {
          file: process.execPath,
          args: ["-e", script, ...outsideRoots, stateRoot],
          cwd: attemptRoot,
          stdin: "",
          shell: false,
          timeoutMs: 1_000,
          killProcessGroup: true,
        },
        attemptRoot,
        stateRoot,
        authFile,
        skillRoot,
      });
      const result = spawnSync(contained.command.file, contained.command.args, {
        cwd: contained.command.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          EVAL_HOST_SECRET: "MUST_BE_CLEARED",
          ...contained.env,
        },
        encoding: "utf8",
        input: contained.command.stdin,
        timeout: 1_500,
        shell: false,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        readable: [false, false, false, false],
        hostStateVisible: false,
        auth: "AUTH_MOUNT_SENTINEL",
        skill: "SKILL_MOUNT_SENTINEL",
        authReadOnly: true,
        inheritedSecret: null,
      });
      for (const [key, relativeStatePath] of [
        ["HOME", "home"],
        ["CODEX_HOME", "codex"],
        ["GROK_HOME", "grok"],
      ] as const) {
        expect(readFileSync(join(stateRoot, relativeStatePath, "artifact.txt"), "utf8")).toBe(key);
      }
      expect(readdirSync(attemptRoot)).toEqual([]);
      for (const ordinaryRoot of ordinaryRoots) expect(readdirSync(ordinaryRoot)).toEqual([]);
    },
    2_000,
  );
});

describe("paired benchmark provider identity and failure taxonomy", () => {
  const grokSessionId = "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1";
  const grokSemanticTools = "read_file,grep,list_dir,run_terminal_cmd,search_replace";
  const prompt = buildEvalProtocolPrompt("frozen task", "high");
  const codexCommand: CommandSpec = {
    file: "/fake/codex",
    args: [
      "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "-m", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="high"', "-C", "/sealed/attempt",
      "-s", "workspace-write", "--output-schema",
      "/run/agent-collab/state/codex/eval-response-schema.json", "--json", "-",
    ],
    cwd: "/sealed/attempt",
    stdin: prompt,
    shell: false,
    timeoutMs: 100,
    killProcessGroup: true,
  };

  const grokCommand: CommandSpec = {
    file: "/fake/grok",
    args: [
      "--cwd", "/sealed/attempt", "--model", "grok-4.6",
      "--reasoning-effort", "high", "--single", prompt,
      "--verbatim", "--output-format", "json", "--session-id", grokSessionId,
      "--max-turns", "20",
      "--no-plan", "--no-subagents", "--disable-web-search", "--deny", "mcp__*",
      "--sandbox", "strict", "--always-approve", "--tools", grokSemanticTools,
    ],
    cwd: "/sealed/attempt",
    stdin: prompt,
    shell: false,
    timeoutMs: 100,
    killProcessGroup: true,
  };

  it("builds fresh exact-model commands that can run in Git-free sealed copies", () => {
    expect(JSON.parse(buildEvalProtocolPrompt("frozen task", "high"))).toEqual({
      protocolVersion,
      executionDirective: "Execute the task completely in the workspace using the allowed tools before returning the final response. Do not only describe the work.",
      task: "frozen task",
      reasoningEffort: "high",
      responseContract: {
        format: "json",
        exactKeys: ["protocolVersion", "reasoningEffort", "visibleText"],
        protocolVersion,
        reasoningEffort: "high",
        visibleText: "non-empty string",
      },
    });
    const codex = buildEvalProviderCommand({
      agent: "codex",
      binary: "/fake/codex",
      cwd: "/sealed/attempt",
      prompt: buildEvalProtocolPrompt("frozen task", "high"),
      effort: "high",
      timeoutMs: 100,
    });
    expect(codex.args).toEqual(expect.arrayContaining([
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]));
    expect(codex).toMatchObject({
      cwd: "/sealed/attempt",
      stdin: buildEvalProtocolPrompt("frozen task", "high"),
    });
    expect(verifyEvalProviderCommand({
      agent: "codex",
      command: codex,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
    })).toEqual({ model: "gpt-5.6-sol", effort: "high" });

    const grok = buildEvalProviderCommand({
      agent: "grok",
      binary: "/fake/grok",
      cwd: "/sealed/attempt",
      prompt: buildEvalProtocolPrompt("frozen task", "high"),
      effort: "high",
      timeoutMs: 100,
      sessionId: grokSessionId,
    });
    expect(grok.args).toEqual(expect.arrayContaining([
      "--session-id",
      grokSessionId,
      "--max-turns",
      "20",
      "--no-plan",
      "--no-subagents",
      "--disable-web-search",
      "--deny",
      "mcp__*",
    ]));
    expect(verifyEvalProviderCommand({
      agent: "grok",
      command: grok,
      expectedModel: "grok-4.6",
      expectedEffort: "high",
      expectedSessionId: grokSessionId,
    })).toEqual({ model: "grok-4.6", effort: "high" });
  });

  it("verifies exact model and effort from immutable launch commands", () => {
    expect(verifyEvalProviderCommand({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      expectedExecutable: "/fake/codex",
    })).toEqual({ model: "gpt-5.6-sol", effort: "high" });
    expect(verifyEvalProviderCommand({
      agent: "grok",
      command: grokCommand,
      expectedModel: "grok-4.6",
      expectedEffort: "high",
      expectedSessionId: grokSessionId,
      expectedExecutable: "/fake/grok",
    })).toEqual({ model: "grok-4.6", effort: "high" });

    expect(() => verifyEvalProviderCommand({
      agent: "codex",
      command: { ...codexCommand, args: codexCommand.args.map((arg) => arg === "gpt-5.6-sol" ? "gpt-5.7" : arg) },
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
    })).toThrow(/model.*mismatch/i);
    expect(() => verifyEvalProviderCommand({
      agent: "grok",
      command: { ...grokCommand, args: grokCommand.args.map((arg) => arg === "high" ? "low" : arg) },
      expectedModel: "grok-4.6",
      expectedEffort: "high",
      expectedSessionId: grokSessionId,
    })).toThrow(/effort.*mismatch/i);
    expect(() => verifyEvalProviderCommand({
      agent: "codex",
      command: { ...codexCommand, file: "/fake/other-codex" },
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      expectedExecutable: "/fake/codex",
    })).toThrow(/executable|identity/i);
    expect(() => verifyEvalProviderCommand({
      agent: "codex",
      command: {
        ...codexCommand,
        args: [...codexCommand.args.slice(0, -1), "--dangerously-bypass-approvals-and-sandbox", "-"],
      },
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
    })).toThrow(/unexpected arguments/i);
  });

  const withoutFlag = (command: CommandSpec, flag: string, takesValue = false): CommandSpec => {
    const index = command.args.indexOf(flag);
    if (index < 0) throw new Error(`fixture is missing ${flag}`);
    const args = [...command.args];
    args.splice(index, takesValue ? 2 : 1);
    return { ...command, args };
  };

  it.each([
    ["Codex ephemeral isolation", "codex", withoutFlag(codexCommand, "--ephemeral"), /ephemeral/i],
    ["Codex ignored user config", "codex", withoutFlag(codexCommand, "--ignore-user-config"), /config/i],
    ["Codex Git-free copy", "codex", withoutFlag(codexCommand, "--skip-git-repo-check"), /git/i],
    ["Codex exact model", "codex", withoutFlag(codexCommand, "-m", true), /model/i],
    ["Codex exact effort", "codex", withoutFlag(codexCommand, "-c", true), /effort/i],
    ["Codex workspace-write sandbox", "codex", withoutFlag(codexCommand, "-s", true), /workspace|sandbox/i],
    ["Codex response schema", "codex", withoutFlag(codexCommand, "--output-schema", true), /schema/i],
    ["Codex JSON output", "codex", withoutFlag(codexCommand, "--json"), /json/i],
    ["Grok fresh session", "grok", withoutFlag(grokCommand, "--session-id", true), /session/i],
    ["Grok exact cwd", "grok", withoutFlag(grokCommand, "--cwd", true), /cwd|workspace/i],
    ["Grok one-shot prompt", "grok", withoutFlag(grokCommand, "--single", true), /single|one.?shot|prompt/i],
    ["Grok turn limit", "grok", withoutFlag(grokCommand, "--max-turns", true), /turn/i],
    ["Grok execution mode", "grok", withoutFlag(grokCommand, "--no-plan"), /execution|plan/i],
    ["Grok no-subagents", "grok", withoutFlag(grokCommand, "--no-subagents"), /subagent/i],
    ["Grok disabled web search", "grok", withoutFlag(grokCommand, "--disable-web-search"), /web/i],
    ["Grok denied MCP", "grok", withoutFlag(grokCommand, "--deny", true), /mcp/i],
    ["Grok strict sandbox", "grok", withoutFlag(grokCommand, "--sandbox", true), /sandbox/i],
    ["Grok approved execution", "grok", withoutFlag(grokCommand, "--always-approve"), /approve/i],
    ["Grok semantic tool allowlist", "grok", withoutFlag(grokCommand, "--tools", true), /tool/i],
  ] as const)("rejects a launch command missing %s", (_name, agent, command, error) => {
    expect(() => verifyEvalProviderCommand({
      agent,
      command,
      expectedModel: agent === "codex" ? "gpt-5.6-sol" : "grok-4.6",
      expectedEffort: "high",
      ...(agent === "grok" ? { expectedSessionId: grokSessionId } : {}),
    })).toThrow(error);
  });

  it("separates prelaunch auth and quota failures from counted task timeouts", () => {
    expect(classifyEvalProviderFailure({
      phase: "prelaunch",
      error: new Error("authentication required: not logged in"),
    })).toEqual({
      kind: "provider_unavailable",
      reason: "auth",
      countsTowardReliability: false,
    });
    expect(classifyEvalProviderFailure({
      phase: "prelaunch",
      error: new Error("free usage quota exhausted"),
    })).toEqual({
      kind: "provider_unavailable",
      reason: "quota",
      countsTowardReliability: false,
    });
    expect(classifyEvalProviderFailure({
      phase: "execution",
      error: new Error("wall budget exceeded"),
      timedOut: true,
    })).toEqual({
      kind: "execution_outcome",
      reason: "task_timeout",
      countsTowardReliability: true,
    });
  });

  it("rejects an auth-looking task error after launch instead of excluding model evidence", () => {
    expect(classifyEvalProviderFailure({
      phase: "execution",
      error: new Error("task wrote: auth token handling is broken"),
    })).toEqual({
      kind: "execution_outcome",
      reason: "task_failure",
      countsTowardReliability: true,
    });
  });

  it.each([
    ["quota", "Free usage quota exhausted"],
    ["auth", "Authentication required: not logged in"],
  ] as const)(
    "classifies a %s CLI exit before candidate mutation as provider unavailable",
    async (reason, stderr) => {
      const launcher: EvalProcessLauncher = {
        launch: vi.fn(() => ({
          pid: 43001,
          result: Promise.resolve({ exitCode: 1, stdout: "", stderr }),
          terminateGroup: vi.fn(),
          isProcessGroupAlive: vi.fn(async () => false),
        })),
      };
      await expect(runEvalProviderAttempt({
        agent: "codex",
        command: codexCommand,
        expectedModel: "gpt-5.6-sol",
        expectedEffort: "high",
        launcher,
        terminationGraceMs: 25,
        maxOutputBytes: 1024,
        observeAttemptActivity: vi.fn(async () => ({
          candidateMutation: false,
          toolActivity: false,
        })),
      })).resolves.toMatchObject({
        status: "failed",
        failure: { kind: "provider_unavailable", reason, countsTowardReliability: false },
        oracleAllowed: false,
      });
    },
  );

  it("counts an auth-looking CLI exit after tool activity as an execution failure", async () => {
    const launcher: EvalProcessLauncher = {
      launch: vi.fn(() => ({
        pid: 43003,
        result: Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Authentication required: not logged in",
        }),
        terminateGroup: vi.fn(),
        isProcessGroupAlive: vi.fn(async () => false),
      })),
    };
    await expect(runEvalProviderAttempt({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
      observeAttemptActivity: vi.fn(async () => ({
        candidateMutation: false,
        toolActivity: true,
      })),
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "execution_outcome",
        reason: "task_failure",
        countsTowardReliability: true,
      },
    });
  });

  it("separates prelaunch command mismatch from a post-launch invalid result protocol", async () => {
    const commandMismatch = await runEvalProviderAttempt({
      agent: "codex",
      command: withoutFlag(codexCommand, "--skip-git-repo-check"),
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher: { launch: vi.fn(() => { throw new Error("must not launch"); }) },
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
    });
    expect(commandMismatch).toMatchObject({
      status: "failed",
      failure: { kind: "harness_confounded", countsTowardReliability: false },
    });

    const parserMismatch = await runEvalProviderAttempt({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher: {
        launch: vi.fn(() => ({
          pid: 43002,
          result: Promise.resolve({ exitCode: 0, stdout: "not-jsonl", stderr: "" }),
          terminateGroup: vi.fn(),
          isProcessGroupAlive: vi.fn(async () => false),
        })),
      },
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
    });
    expect(parserMismatch).toMatchObject({
      status: "failed",
      failure: {
        kind: "execution_outcome",
        reason: expect.stringContaining("invalid_result_protocol"),
        countsTowardReliability: true,
      },
    });
  });

  it("verifies the frozen inner command identity before launching its outer containment", async () => {
    const containerExecutable = "/opt/agent-collab/codex/bin/codex";
    const outer: CommandSpec = {
      file: "/usr/bin/bwrap",
      args: ["--unshare-all", "--clearenv", "--", containerExecutable, ...codexCommand.args],
      cwd: codexCommand.cwd,
      stdin: codexCommand.stdin,
      shell: false,
      timeoutMs: codexCommand.timeoutMs,
      killProcessGroup: true,
    };
    const launcher: EvalProcessLauncher = {
      launch: vi.fn(() => ({
        pid: 43004,
        result: Promise.resolve({
          exitCode: 0,
          stdout: codex0147SanitizedExecStream(),
          stderr: "",
        }),
        terminateGroup: vi.fn(),
        isProcessGroupAlive: vi.fn(async () => false),
      })),
    };
    await expect(runEvalProviderAttempt({
      agent: "codex",
      command: outer,
      providerCommand: codexCommand,
      containerExecutable,
      expectedExecutable: "/fake/codex",
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 1024 * 1024,
    })).resolves.toMatchObject({
      status: "completed",
      result: { model: "gpt-5.6-sol", modelProvenance: "command_pinned" },
      oracleAllowed: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(outer, expect.any(Object));

    const forged = { ...outer, args: outer.args.map((arg) => arg === "workspace-write" ? "danger-full-access" : arg) };
    await expect(runEvalProviderAttempt({
      agent: "codex",
      command: forged,
      providerCommand: codexCommand,
      containerExecutable,
      expectedExecutable: "/fake/codex",
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "harness_confounded", countsTowardReliability: false },
    });
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["diff bytes", { diffBytes: 101, fileCount: 1, peakProcessCount: 1 }, "diff_budget_exceeded"],
    ["file count", { diffBytes: 1, fileCount: 4, peakProcessCount: 1 }, "file_budget_exceeded"],
    ["process count", { diffBytes: 1, fileCount: 1, peakProcessCount: 3 }, "process_budget_exceeded"],
  ] as const)(
    "turns a success-shaped provider result into a terminal failure when %s exceeds its budget",
    async (_name, observed, reason) => {
      const isProcessGroupAlive = vi.fn(async () => false);
      const launcher: EvalProcessLauncher = {
        launch: vi.fn(() => ({
          pid: 43100,
          result: Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: codex0147SanitizedExecStream(),
          }),
          terminateGroup: vi.fn(),
          isProcessGroupAlive,
        })),
      };

      const result = await runEvalProviderAttempt({
        agent: "codex",
        command: codexCommand,
        expectedModel: "gpt-5.6-sol",
        expectedEffort: "high",
        launcher,
        terminationGraceMs: 25,
        maxOutputBytes: 1024 * 1024,
        budgetLimits: { maxDiffBytes: 100, maxFiles: 3, maxProcesses: 2 },
        observeBudgets: vi.fn(async () => observed),
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          kind: "execution_outcome",
          reason,
          countsTowardReliability: true,
        },
        cleanup: { processGroupTerminated: true },
        oracleAllowed: false,
      });
      expect(result).not.toMatchObject({ status: "completed" });
      expect(result).not.toMatchObject({ status: "success" });
      expect(isProcessGroupAlive).toHaveBeenCalled();
    },
  );

  it("bounds process-group cleanup on task timeout without launching a real provider", async () => {
    vi.useFakeTimers();
    let alive = true;
    const terminateGroup = vi.fn(async (signal: "SIGTERM" | "SIGKILL") => {
      if (signal === "SIGKILL") alive = false;
    });
    const launcher: EvalProcessLauncher = {
      launch: vi.fn(() => ({
        pid: 43210,
        result: new Promise<never>(() => undefined),
        terminateGroup,
        isProcessGroupAlive: vi.fn(async () => alive),
      })),
    };

    const pending = runEvalProviderAttempt({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
    });
    await vi.advanceTimersByTimeAsync(125);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "execution_outcome",
        reason: "task_timeout",
        countsTowardReliability: true,
      },
      cleanup: { processGroupTerminated: true },
    });
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(terminateGroup.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it.skipIf(process.platform === "win32")(
    "uses the real launcher to kill a bounded parent-child process group with no child PID left",
    async () => {
      const root = makeRoot("agent-collab-eval-process-group-");
      const attemptRoot = join(root, "attempt");
      const binary = join(root, "fake-codex.mjs");
      const pidReceipt = join(root, "pids.json");
      mkdirSync(attemptRoot, { recursive: true });
      writeFileSync(binary, [
        "#!/usr/bin/env node",
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.env.EVAL_PID_RECEIPT, JSON.stringify({ parent: process.pid, child: child.pid }));",
        "let stopping = false;",
        "process.on(\"SIGTERM\", () => {",
        "  if (stopping) return; stopping = true;",
        "  child.once(\"exit\", () => process.exit(0));",
        "  try { child.kill(\"SIGTERM\"); } catch {}",
        "  setTimeout(() => { try { child.kill(\"SIGKILL\"); } catch {} process.exit(0); }, 75);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      chmodSync(binary, 0o755);
      const command: CommandSpec = {
        ...codexCommand,
        file: binary,
        cwd: attemptRoot,
        timeoutMs: 300,
        args: codexCommand.args.map((arg) => arg === "/sealed/attempt" ? attemptRoot : arg),
      };
      let pids: { parent: number; child: number } | undefined;

      try {
        const pending = runEvalProviderAttempt({
          agent: "codex",
          command,
          expectedModel: "gpt-5.6-sol",
          expectedEffort: "high",
          launcher: new NodeEvalProcessLauncher(),
          terminationGraceMs: 100,
          maxOutputBytes: 1024,
          env: { ...process.env, EVAL_PID_RECEIPT: pidReceipt },
        });
        const deadline = Date.now() + 500;
        while (!existsSync(pidReceipt) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(pidReceipt)).toBe(true);
        pids = JSON.parse(readFileSync(pidReceipt, "utf8")) as { parent: number; child: number };

        await expect(pending).resolves.toMatchObject({
          status: "failed",
          failure: { reason: "task_timeout" },
          cleanup: { processGroupTerminated: true },
        });
        expect(await waitForPidExit(pids.child, 500)).toBe(true);
      } finally {
        if (pids !== undefined) {
          try { process.kill(-pids.parent, "SIGKILL"); } catch { /* already reaped */ }
          if (pidExists(pids.child)) {
            try { process.kill(pids.child, "SIGKILL"); } catch { /* already reaped */ }
          }
        }
      }
    },
    2_000,
  );

  it("reports cleanup as a harness failure when a stubborn process group survives SIGKILL", async () => {
    vi.useFakeTimers();
    const terminateGroup = vi.fn(async () => undefined);
    const launcher: EvalProcessLauncher = {
      launch: vi.fn(() => ({
        pid: 43211,
        result: new Promise<never>(() => undefined),
        terminateGroup,
        isProcessGroupAlive: vi.fn(async () => true),
      })),
    };

    const pending = runEvalProviderAttempt({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 1024,
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "harness_failure",
        reason: "process_group_cleanup_failed",
        countsTowardReliability: false,
      },
      cleanup: { processGroupTerminated: false },
    });
    expect(terminateGroup.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("records an output-budget execution outcome and cannot report success", async () => {
    const isProcessGroupAlive = vi.fn(async () => false);
    const launcher: EvalProcessLauncher = {
      launch: vi.fn(() => ({
        pid: 43212,
        result: Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: codex0147SanitizedExecStream() + "X".repeat(256),
        }),
        terminateGroup: vi.fn(),
        isProcessGroupAlive,
      })),
    };

    await expect(runEvalProviderAttempt({
      agent: "codex",
      command: codexCommand,
      expectedModel: "gpt-5.6-sol",
      expectedEffort: "high",
      launcher,
      terminationGraceMs: 25,
      maxOutputBytes: 128,
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "execution_outcome",
        reason: "output_budget_exceeded",
        countsTowardReliability: true,
      },
      cleanup: { processGroupTerminated: true },
      oracleAllowed: false,
    });
    expect(isProcessGroupAlive).toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
