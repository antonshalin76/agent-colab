import type {
  AdapterEvent,
  HistoryCandidate,
  HistoryRole,
  HistorySourceAgent,
  PendingTool,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function role(value: unknown, fallback: HistoryRole): HistoryRole {
  return value === "user" || value === "assistant" ? value : fallback;
}

function candidate(
  input: Omit<HistoryCandidate, "sourceAgent" | "namespace"> & { sourceAgent: HistorySourceAgent },
): AdapterEvent {
  const namespace = input.sourceAgent === "grok"
    ? "grok_native" as const
    : input.sourceAgent === "codex"
      ? "codex_native" as const
      : "claude_legacy" as const;
  return { type: "candidate", candidate: { ...input, namespace } };
}

export interface AdapterContext {
  project: string;
  sourcePath: string;
  sourceLine: number;
  sessionId: string | null;
}

export function adaptClaudeRecord(record: unknown, context: AdapterContext): AdapterEvent[] {
  const root = object(record);
  const message = object(root?.message);
  if (!root || !message) return [];
  const sessionId = string(root.sessionId) ?? context.sessionId;
  const timestamp = string(root.timestamp);
  const recordId = string(root.uuid) ?? `line:${context.sourceLine}`;
  const nativeRole = string(message.role) ?? string(root.type);
  const messageVisibility =
    nativeRole === "system" || nativeRole === "developer" ? "privileged_instruction" : "visible";
  const messageRole = role(message.role, root.type === "assistant" ? "assistant" : "user");
  const content = message.content;
  if (typeof content === "string") {
    return [
      candidate({
        visibility: messageVisibility,
        sourceAgent: "claude_legacy",
        kind: "message",
        sessionId,
        role: messageRole,
        content,
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `message:${recordId}`,
      }),
    ];
  }
  if (!Array.isArray(content)) return [];
  const events: AdapterEvent[] = [];
  for (const [index, rawBlock] of content.entries()) {
    const block = object(rawBlock);
    if (!block) continue;
    if (block.type === "text") {
      const text = string(block.text);
      if (text !== null) {
        events.push(
          candidate({
            visibility: messageVisibility,
            sourceAgent: "claude_legacy",
            kind: "message",
            sessionId,
            role: messageRole,
            content: text,
            project: context.project,
            sourcePath: context.sourcePath,
            sourceLine: context.sourceLine,
            timestamp,
            recordKey: `message:${recordId}:text:${index}`,
          }),
        );
      }
    } else if (block.type === "thinking") {
      events.push(
        candidate({
          visibility: "reasoning",
          sourceAgent: "claude_legacy",
          kind: "message",
          sessionId,
          role: "assistant",
          content: string(block.thinking) ?? "",
          project: context.project,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `reasoning:${recordId}:${index}`,
        }),
      );
    } else if (block.type === "tool_use") {
      events.push(
        candidate({
          visibility: "tool_payload",
          sourceAgent: "claude_legacy",
          kind: "message",
          sessionId,
          role: "assistant",
          content: serialized(block.input),
          project: context.project,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `tool-payload:${recordId}:${index}`,
        }),
      );
      const callId = string(block.id);
      const name = string(block.name);
      if (callId && name) {
        const tool: PendingTool = {
          sourceAgent: "claude_legacy",
          callId,
          name,
          sessionId,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `tool:${callId}`,
        };
        events.push({ type: "tool_call", tool });
      }
    } else if (block.type === "tool_result") {
      events.push(
        candidate({
          visibility: "tool_payload",
          sourceAgent: "claude_legacy",
          kind: "message",
          sessionId,
          role: "user",
          content: serialized(block.content),
          project: context.project,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `tool-result-payload:${recordId}:${index}`,
        }),
      );
      const callId = string(block.tool_use_id);
      if (callId) {
        events.push({ type: "tool_result", callId, status: block.is_error === true ? "failed" : "completed" });
      }
    }
  }
  return events;
}

export function adaptCodexRecord(record: unknown, context: AdapterContext): AdapterEvent[] {
  const root = object(record);
  const payload = object(root?.payload);
  if (!root || !payload) return [];
  const timestamp = string(root.timestamp);
  if (root.type === "session_meta") {
    const sessionId = string(payload.id);
    return sessionId ? [{ type: "session", sessionId }] : [];
  }
  if (root.type !== "response_item") return [];
  const payloadType = string(payload.type);
  const recordId = string(payload.id) ?? `line:${context.sourceLine}`;
  if (payloadType === "message") {
    const nativeRole = string(payload.role);
    const messageVisibility =
      nativeRole === "system" || nativeRole === "developer" ? "privileged_instruction" : "visible";
    const messageRole = role(payload.role, "assistant");
    if (!Array.isArray(payload.content)) return [];
    return payload.content.flatMap((rawBlock, index): AdapterEvent[] => {
      const block = object(rawBlock);
      const text = block ? string(block.text) : null;
      if (!block || text === null || (block.type !== "input_text" && block.type !== "output_text")) return [];
      return [
        candidate({
          visibility: messageVisibility,
          sourceAgent: "codex",
          kind: "message",
          sessionId: context.sessionId,
          role: messageRole,
          content: text,
          project: context.project,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `message:${recordId}:text:${index}`,
        }),
      ];
    });
  }
  if (payloadType === "reasoning") {
    return [
      candidate({
        visibility: "reasoning",
        sourceAgent: "codex",
        kind: "message",
        sessionId: context.sessionId,
        role: "assistant",
        content: serialized(payload),
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `reasoning:${recordId}`,
      }),
    ];
  }
  if (payloadType === "function_call") {
    const callId = string(payload.call_id);
    const name = string(payload.name);
    if (!callId || !name) return [];
    return [
      candidate({
        visibility: "tool_payload",
        sourceAgent: "codex",
        kind: "message",
        sessionId: context.sessionId,
        role: "assistant",
        content: serialized(payload.arguments),
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `tool-payload:${recordId}`,
      }),
      {
        type: "tool_call",
        tool: {
          sourceAgent: "codex",
          callId,
          name,
          sessionId: context.sessionId,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `tool:${callId}`,
        },
      },
    ];
  }
  if (payloadType === "function_call_output") {
    const callId = string(payload.call_id);
    if (!callId) return [];
    return [
      candidate({
        visibility: "tool_payload",
        sourceAgent: "codex",
        kind: "message",
        sessionId: context.sessionId,
        role: "assistant",
        content: serialized(payload.output),
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `tool-result-payload:${recordId}`,
      }),
      { type: "tool_result", callId, status: payload.status === "failed" ? "failed" : "completed" },
    ];
  }
  return [];
}

export function adaptGrokRecord(record: unknown, context: AdapterContext): AdapterEvent[] {
  const root = object(record);
  if (!root) return [];
  const payload = object(root.payload);
  if (root.type === "session_meta") {
    const sessionId = string(payload?.id);
    return sessionId ? [{ type: "session", sessionId }] : [];
  }

  const timestamp = string(root.timestamp);
  const recordId = string(root.id) ?? `line:${context.sourceLine}`;
  if (root.type === "user" || root.type === "assistant" || root.type === "system") {
    const nativeRole = string(root.type)!;
    const messageRole = role(nativeRole, "assistant");
    const messageVisibility = root.type === "system" || typeof root.synthetic_reason === "string"
      ? "privileged_instruction" as const : "visible" as const;
    const events: AdapterEvent[] = [];
    if (typeof root.content === "string") {
      events.push(candidate({ visibility: messageVisibility, sourceAgent: "grok", kind: "message",
        sessionId: context.sessionId, role: messageRole, content: root.content,
        project: context.project, sourcePath: context.sourcePath, sourceLine: context.sourceLine,
        timestamp, recordKey: `message:${recordId}:text:0` }));
    } else if (Array.isArray(root.content)) {
      for (const [index, rawBlock] of root.content.entries()) {
        const block = object(rawBlock);
        const text = block?.type === "text" ? string(block.text) : null;
        if (text !== null) events.push(candidate({ visibility: messageVisibility, sourceAgent: "grok",
          kind: "message", sessionId: context.sessionId, role: messageRole, content: text,
          project: context.project, sourcePath: context.sourcePath, sourceLine: context.sourceLine,
          timestamp, recordKey: `message:${recordId}:text:${index}` }));
      }
    }
    if (root.type === "assistant" && Array.isArray(root.tool_calls)) {
      for (const [index, rawCall] of root.tool_calls.entries()) {
        const call = object(rawCall);
        const callId = string(call?.id); const name = string(call?.name);
        if (!call || !callId || !name) continue;
        events.push(candidate({ visibility: "tool_payload", sourceAgent: "grok", kind: "message",
          sessionId: context.sessionId, role: "assistant", content: serialized(call.arguments),
          project: context.project, sourcePath: context.sourcePath, sourceLine: context.sourceLine,
          timestamp, recordKey: `tool-payload:${recordId}:${index}` }));
        events.push({ type: "tool_call", tool: { sourceAgent: "grok", callId, name,
          sessionId: context.sessionId, sourcePath: context.sourcePath,
          sourceLine: context.sourceLine, timestamp, recordKey: `tool:${callId}` } });
      }
    }
    return events;
  }
  if (root.type === "message") {
    const nativeRole = string(root.role);
    const messageVisibility =
      nativeRole === "system" || nativeRole === "developer" ? "privileged_instruction" : "visible";
    const messageRole = role(root.role, "assistant");
    if (!Array.isArray(root.content)) return [];
    return root.content.flatMap((rawBlock, index): AdapterEvent[] => {
      const block = object(rawBlock);
      if (!block) return [];
      if (block.type === "text") {
        const text = string(block.text);
        return text === null
          ? []
          : [
              candidate({
                visibility: messageVisibility,
                sourceAgent: "grok",
                kind: "message",
                sessionId: context.sessionId,
                role: messageRole,
                content: text,
                project: context.project,
                sourcePath: context.sourcePath,
                sourceLine: context.sourceLine,
                timestamp,
                recordKey: `message:${recordId}:text:${index}`,
              }),
            ];
      }
      const visibility =
        block.type === "tool_arguments" || block.type === "tool_result"
          ? "tool_payload"
          : block.type === "thought" ||
              block.type === "reasoning" ||
              block.type === "encrypted_content"
            ? "reasoning"
            : null;
      if (visibility === null) return [];
      return [
        candidate({
          visibility,
          sourceAgent: "grok",
          kind: "message",
          sessionId: context.sessionId,
          role: messageRole,
          content: serialized(block),
          project: context.project,
          sourcePath: context.sourcePath,
          sourceLine: context.sourceLine,
          timestamp,
          recordKey: `${visibility}:${recordId}:${index}`,
        }),
      ];
    });
  }

  if (root.type === "tool_result") {
    const callId = string(root.tool_call_id) ?? string(root.call_id);
    const events: AdapterEvent[] = [
      candidate({
        visibility: "tool_payload",
        sourceAgent: "grok",
        kind: "message",
        sessionId: context.sessionId,
        role: "assistant",
        content: serialized(root),
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `tool-payload:${recordId}`,
      }),
    ];
    if (callId) events.push({ type: "tool_result", callId,
      status: root.status === "failed" ? "failed" : "completed" });
    return events;
  }
  if (root.type === "tool_call") {
    const callId = string(root.id); const name = string(root.name);
    const events: AdapterEvent[] = [candidate({ visibility: "tool_payload", sourceAgent: "grok",
      kind: "message", sessionId: context.sessionId, role: "assistant", content: serialized(root),
      project: context.project, sourcePath: context.sourcePath, sourceLine: context.sourceLine,
      timestamp, recordKey: `tool-payload:${recordId}` })];
    if (callId && name) events.push({ type: "tool_call", tool: { sourceAgent: "grok", callId, name,
      sessionId: context.sessionId, sourcePath: context.sourcePath, sourceLine: context.sourceLine,
      timestamp, recordKey: `tool:${callId}` } });
    return events;
  }
  if (root.type === "thought" || root.type === "reasoning" || root.type === "encrypted_content") {
    return [
      candidate({
        visibility: "reasoning",
        sourceAgent: "grok",
        kind: "message",
        sessionId: context.sessionId,
        role: "assistant",
        content: serialized(root),
        project: context.project,
        sourcePath: context.sourcePath,
        sourceLine: context.sourceLine,
        timestamp,
        recordKey: `reasoning:${recordId}`,
      }),
    ];
  }
  return [];
}
