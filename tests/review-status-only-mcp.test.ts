import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReviewStatusOnlyMcpServer,
  type ReviewStatusOnlyService,
} from "../src/mcp/review-status-only-server.js";
import { ReviewStatusQuery } from "../src/app/review-status-query.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { openStateDatabaseLease } from "../src/store/state-database-fence.js";

describe("review status-only MCP authority profile", () => {
  it("exposes only collab_status and cannot invoke a mutation port", async () => {
    const mutation = vi.fn();
    const service: ReviewStatusOnlyService & { requestReview: typeof mutation } = {
      status: vi.fn(async () => ({ protocol: "agent-collab-review-only/v1" })),
      requestReview: mutation,
    };
    const server = createReviewStatusOnlyMcpServer(service);
    const client = new Client({ name: "helper-status-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["collab_status"]);

    await expect(client.callTool({
      name: "collab_request_review",
      arguments: {},
    })).resolves.toMatchObject({ isError: true });
    expect(mutation).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("reads provider and queue state through a readonly lease without initializing stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-status-only-"));
    const database = join(root, "collaboration.db");
    try {
      initializeCurrentExecutionSchema(database);
      const lease = openStateDatabaseLease(database, "offline_observation", { readonly: true });
      const query = new ReviewStatusQuery(lease);
      await expect(query.status()).resolves.toMatchObject({
        protocol: "agent-collab-review-status-only/v1",
        capabilities: { reviewOnly: true, readOnly: true },
        providers: {
          codex: { required: true, health: "probing", recoveryGeneration: 0 },
          grok: { required: false, health: "probing", recoveryGeneration: 0 },
          claude: { required: false, health: "probing", recoveryGeneration: 0 },
        },
        queue: { queued: 0, claimed: 0, completed: 0, failed: 0 },
      });
      query.close();
      await expect(query.status()).rejects.toThrow(/closed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
