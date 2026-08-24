import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { STAGES, type ActiveAgentId, type Stage } from "../domain/routing.js";
import { sanitizeResult } from "../security/redaction.js";

type ApprovalScope = "workspace-read" | "workspace-write" | "external";
export interface SearchInput { requester: ActiveAgentId; kind: "thread" | "memory"; query?: string | undefined; project?: string | undefined }
export interface DelegateInput {
  requester: ActiveAgentId; taskId?: string | undefined; stage: Stage; preferredAgent?: ActiveAgentId | undefined; project: string; prompt: string;
  artifactHash: string; artifactContent: string; approvalScope: ApprovalScope; approvalReference?: string | undefined; idempotencyKey: string;
}
export interface ReviewInput {
  requester: ActiveAgentId; project: string; stageId?: string | undefined; artifactHash: string; artifactContent: string; prompt: string;
  approvalScope: ApprovalScope; approvalReference?: string | undefined; idempotencyKey: string;
}
export interface CollabService {
  status(): Promise<unknown>;
  search(input: SearchInput): Promise<unknown>;
  delegate(input: DelegateInput): Promise<unknown>;
  requestReview(input: ReviewInput): Promise<unknown>;
  runStatus(input: { runId: string }): Promise<unknown>;
  indexNow(input?: { project?: string | undefined }): Promise<unknown>;
}

const agent = z.enum(["grok", "codex"]);
const approvalScope = z.enum(["workspace-read", "workspace-write", "external"]);
const stage = z.enum(STAGES);
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(sanitizeResult(value)) }],
});
const errorResult = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: sanitizeResult(error instanceof Error ? error.message : String(error)) }) }],
});
const guarded = <T>(handler: (input: T) => Promise<unknown>) => async (input: T) => {
  try { return textResult(await handler(input)); } catch (error) { return errorResult(error); }
};

export function createCollabMcpServer(service: CollabService): McpServer {
  const server = new McpServer({ name: "agent-collab", version: "0.1.0" });
  server.registerTool("collab_status", { description: "Return collaboration provider and queue status" },
    guarded(async () => service.status()));
  const boundedPath = z.string().min(1).max(4_096);
  const boundedId = z.string().min(1).max(512);
  const boundedRunId = z.string().min(1).max(1_024);
  const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
  const searchSchema = z.object({ requester: agent, query: z.string().max(2_000).optional(), project: boundedPath }).strict();
  server.registerTool("collab_search_history", { description: "Search visible cross-agent thread history", inputSchema: searchSchema },
    guarded(async (input) => service.search({ ...input, kind: "thread" })));
  server.registerTool("collab_search_memory", { description: "Search visible cross-agent memory", inputSchema: searchSchema },
    guarded(async (input) => service.search({ ...input, kind: "memory" })));
  const delegateSchema = z.object({
    requester: agent, taskId: boundedId.optional(), stage, preferredAgent: agent.optional(), project: boundedPath,
    prompt: z.string().max(200_000), artifactHash: sha256, artifactContent: z.string().max(2_000_000), approvalScope,
    approvalReference: boundedId.optional(), idempotencyKey: boundedId,
  }).strict();
  server.registerTool("collab_delegate", { description: "Delegate one bounded stage to an agent", inputSchema: delegateSchema },
    guarded(async (input) => {
      if (input.approvalScope === "external" && !input.approvalReference) throw new Error("external delegation requires explicit approval reference");
      return service.delegate(input);
    }));
  const reviewSchema = z.object({
    requester: agent, project: boundedPath, stageId: boundedId.optional(),
    artifactHash: sha256, artifactContent: z.string().max(2_000_000), prompt: z.string().max(200_000),
    approvalScope, approvalReference: boundedId.optional(), idempotencyKey: boundedId,
  }).strict();
  server.registerTool("collab_request_review", { description: "Dispatch four independent auditor and critic lanes", inputSchema: reviewSchema },
    guarded(async (input) => {
      if (input.approvalScope === "external" && !input.approvalReference) throw new Error("external review requires explicit approval reference");
      return service.requestReview(input);
    }));
  server.registerTool("collab_run_status", {
    description: "Return a durable collaboration run", inputSchema: z.object({ runId: boundedRunId }),
  }, guarded(async (input) => service.runStatus(input)));
  server.registerTool("collab_index_now", {
    description: "Refresh the read-only cross-agent history index", inputSchema: z.object({ project: boundedPath }),
  }, guarded(async (input) => service.indexNow(input)));
  return server;
}

export async function startStdioCollabServer(
  service: CollabService,
  streams?: { stdin: Readable; stdout: Writable },
): Promise<McpServer> {
  const server = createCollabMcpServer(service);
  const transport = streams
    ? new StdioServerTransport(streams.stdin, streams.stdout)
    : new StdioServerTransport();
  await server.connect(transport);
  return server;
}
