import { buildCodexCommand, type CodexCommandInput } from "./codex.js";
import { buildGrokCommand, type GrokCommandInput } from "./grok.js";
import { buildClaudeCommand, type ClaudeCommandInput } from "./claude.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  stdin: string;
  shell: false;
  timeoutMs: number;
  killProcessGroup: true;
  promptFileArgIndex?: number;
}

export interface PreparedCommandInput {
  args: string[];
  input?: string;
  cleanup(): void;
}

export function prepareCommandInput(command: CommandSpec): PreparedCommandInput {
  if (command.promptFileArgIndex === undefined) {
    return { args: command.args, input: command.stdin, cleanup: () => undefined };
  }
  if (!Number.isSafeInteger(command.promptFileArgIndex) || command.promptFileArgIndex < 0 ||
      command.promptFileArgIndex >= command.args.length ||
      command.args[command.promptFileArgIndex] !== "/dev/stdin") {
    throw new Error("promptFileArgIndex must identify the /dev/stdin argument");
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-collab-prompt-"));
  const promptPath = join(directory, "prompt.txt");
  writeFileSync(promptPath, command.stdin, { encoding: "utf8", mode: 0o600 });
  const args = [...command.args];
  args[command.promptFileArgIndex] = promptPath;
  let cleaned = false;
  return {
    args,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type ProviderCommandRequest =
  | { agent: "grok"; command: GrokCommandInput }
  | { agent: "claude"; command: ClaudeCommandInput }
  | { agent: "codex"; command: CodexCommandInput };

export function buildProviderCommand(request: ProviderCommandRequest): CommandSpec {
  switch (request.agent) {
    case "grok":
      return buildGrokCommand(request.command);
    case "claude":
      return buildClaudeCommand(request.command);
    case "codex":
      return buildCodexCommand(request.command);
  }
}
