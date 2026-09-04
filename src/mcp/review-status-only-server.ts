import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";

import { sanitizeResult } from "../security/redaction.js";

export interface ReviewStatusOnlyService {
  status(): Promise<unknown>;
}

export interface CloseableReviewStatusOnlyService extends ReviewStatusOnlyService {
  close(): void | Promise<void>;
}

export interface StartedReviewStatusOnlyMcpServer {
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

export function createReviewStatusOnlyMcpServer(service: ReviewStatusOnlyService): McpServer {
  const server = new McpServer({ name: "agent-collab-review-status-only", version: "0.1.0" });
  server.registerTool(
    "collab_status",
    { description: "Return collaboration review-provider and review-queue status" },
    async () => {
      try { return textResult(await service.status()); }
      catch (error) { return errorResult(error); }
    },
  );
  return server;
}

export async function startStdioReviewStatusOnlyMcpServer(
  service: CloseableReviewStatusOnlyService,
  streams?: { stdin: Readable; stdout: Writable },
): Promise<StartedReviewStatusOnlyMcpServer> {
  const server = createReviewStatusOnlyMcpServer(service);
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
      let firstError: unknown;
      try { await server.close(); } catch (error) { firstError = error; }
      try { await service.close(); } catch (error) { firstError ??= error; }
      if (firstError !== undefined) throw firstError;
    },
  };
}
