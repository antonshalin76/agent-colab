import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCollabMcpServer, type CollabService } from "../src/mcp/server.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("legacy full MCP quarantine", () => {
  it("cannot invoke linear delegation even through an injected service", async () => {
    const delegate = vi.fn(async () => ({ activated: true }));
    const service = {
      status: async () => ({}),
      validateFlow: async () => ({}),
      search: async () => ({}),
      delegate,
      requestReview: async () => ({}),
      runStatus: async () => ({}),
      indexNow: async () => ({}),
    } satisfies CollabService;
    const server = createCollabMcpServer(service);
    const client = new Client({ name: "legacy-quarantine-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    servers.push(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "collab_delegate",
      arguments: {
        requester: "codex",
        stage: "planning",
        project: "/tmp/project",
        prompt: "forbidden",
        artifactHash: "0".repeat(64),
        artifactContent: "",
        approvalScope: "workspace-read",
        idempotencyKey: "forbidden",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/permanently disabled|graph collaboration runtime/i);
    expect(delegate).not.toHaveBeenCalled();
  });
});
