import { buildCodexCommand, type CodexCommandInput } from "./codex.js";
import { buildGrokCommand, type GrokCommandInput } from "./grok.js";
import { buildClaudeCommand, type ClaudeCommandInput } from "./claude.js";

export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  stdin: string;
  shell: false;
  timeoutMs: number;
  killProcessGroup: true;
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
