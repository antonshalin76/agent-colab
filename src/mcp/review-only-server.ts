import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { sanitizeResult } from "../security/redaction.js";
import type { ReviewInput } from "./server.js";

export type ReviewOnlyRequestInput = Omit<
  ReviewInput,
  "requester" | "approvalScope" | "approvalReference"
> & {
  requester: "codex";
  approvalScope: "workspace-read";
};

export interface ReviewOnlyCollabService {
  status(): Promise<unknown>;
  requestReview(input: ReviewOnlyRequestInput): Promise<unknown>;
  reviewStatus(input: { reviewId: string }): Promise<unknown>;
}

export interface CloseableReviewOnlyCollabService extends ReviewOnlyCollabService {
  close(): void | Promise<void>;
}

export interface StartedReviewOnlyMcpServer {
  readonly server: McpServer;
  close(): Promise<void>;
}

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(sanitizeResult(value)) }],
});

const errorResult = (error: unknown) => ({
  isError: true,
  content: [{
    type: "text" as const,
    text: JSON.stringify({
      error: sanitizeResult(error instanceof Error ? error.message : String(error)),
    }),
  }],
});

const guarded = <T>(handler: (input: T) => Promise<unknown>) => async (input: T) => {
  try {
    return textResult(await handler(input));
  } catch (error) {
    return errorResult(error);
  }
};

const boundedPath = z.string().min(1).max(4_096);
const boundedId = z.string().min(1).max(512);
const boundedRunId = z.string().min(1).max(1_024);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const reviewSchema = z.object({
  workspaceRoot: boundedPath,
  stageId: boundedId.optional(),
  artifactHash: sha256,
  artifactContent: z.string().max(2_000_000),
  prompt: z.string().max(200_000),
  idempotencyKey: boundedId,
}).strict();

export function createReviewOnlyMcpServer(
  service: ReviewOnlyCollabService,
  options: { readonly expectedClientName?: string } = {},
): McpServer {
  const expectedClientName = options.expectedClientName ?? "codex-mcp-client";
  const server = new McpServer({ name: "agent-collab-review-only", version: "0.1.0" });
  const assertCodexLaunchProfile = (): void => {
    const client = server.server.getClientVersion();
    if (client?.name !== expectedClientName) {
      throw new Error("mutating review MCP requires the Codex MCP client launch profile");
    }
  };

  server.registerTool(
    "collab_status",
    { description: "Return collaboration review-provider and review-queue status" },
    guarded(async () => {
      assertCodexLaunchProfile();
      return service.status();
    }),
  );

  server.registerTool(
    "collab_request_review",
    {
      description: "Dispatch six immutable workspace-read auditor and critic lanes for Codex",
      inputSchema: reviewSchema,
    },
    guarded(async (input) => {
      assertCodexLaunchProfile();
      return service.requestReview({
        ...input,
        requester: "codex",
        approvalScope: "workspace-read",
      });
    }),
  );

  server.registerTool(
    "collab_run_status",
    {
      description: "Return a durable review and its barrier status",
      inputSchema: z.object({ runId: boundedRunId }).strict(),
    },
    guarded(async ({ runId }) => {
      assertCodexLaunchProfile();
      return service.reviewStatus({ reviewId: runId });
    }),
  );

  return server;
}

export async function startStdioReviewOnlyMcpServer(
  service: CloseableReviewOnlyCollabService,
  streams?: { stdin: Readable; stdout: Writable },
): Promise<StartedReviewOnlyMcpServer> {
  const server = createReviewOnlyMcpServer(service);
  const transport = streams
    ? new StdioServerTransport(streams.stdin, streams.stdout)
    : new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error) {
    try { await server.close(); } catch { /* preserve the connection error */ }
    try { await service.close(); } catch { /* preserve the connection error */ }
    throw error;
  }
  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      let serverError: unknown;
      try { await server.close(); } catch (error) { serverError = error; }
      try { await service.close(); } catch (error) { serverError ??= error; }
      if (serverError !== undefined) throw serverError;
    },
  };
}
