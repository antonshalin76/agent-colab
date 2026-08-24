export type ActiveAgentId = "grok" | "codex";
export type HistorySourceAgent = ActiveAgentId | "claude_legacy";
export type HistoryNamespace =
  | "grok_native"
  | "codex_native"
  | "collaboration_shared"
  | "claude_legacy";
export type HistoryKind = "memory" | "message" | "tool_summary";
export type HistoryRole = "assistant" | "memory" | "user";

export interface HistoryCandidate {
  visibility: "privileged_instruction" | "reasoning" | "tool_payload" | "visible";
  sourceAgent: HistorySourceAgent;
  namespace: HistoryNamespace;
  kind: HistoryKind;
  sessionId: string | null;
  role: HistoryRole;
  content: string;
  project: string;
  sourcePath: string;
  sourceLine: number;
  timestamp: string | null;
  recordKey: string;
}

export interface HistoryRow extends Omit<HistoryCandidate, "visibility"> {
  contentHash: string;
  trust: "untrusted";
}

export type HistorySearchRow = Omit<HistoryRow, "project">;

export interface PendingTool {
  sourceAgent: HistorySourceAgent;
  callId: string;
  name: string;
  sessionId: string | null;
  sourcePath: string;
  sourceLine: number;
  timestamp: string | null;
  recordKey: string;
}

export type AdapterEvent =
  | { type: "candidate"; candidate: HistoryCandidate }
  | { type: "session"; sessionId: string }
  | { type: "tool_call"; tool: PendingTool }
  | { type: "tool_result"; callId: string; status: "completed" | "failed" };
