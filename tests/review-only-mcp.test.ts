import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewOnlyMcpServer,
  startStdioReviewOnlyMcpServer,
  type ReviewOnlyCollabService,
} from "../src/mcp/review-only-server.js";

const fakeService = (): ReviewOnlyCollabService => ({
  status: vi.fn(async () => ({ mode: "review-only" })),
  requestReview: vi.fn(async () => ({ reviewId: "review-1", laneCount: 6 })),
  reviewStatus: vi.fn(async ({ reviewId }) => ({
    review: { reviewId, runState: "FULL_CROSS_PROVIDER" },
    barrier: { satisfied: false },
  })),
});

const connect = async (service: ReviewOnlyCollabService, clientName = "codex-mcp-client") => {
  const server = createReviewOnlyMcpServer(service);
  const client = new Client({ name: clientName, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
};

describe("review-only MCP boundary", () => {
  it("registers exactly the quarantined review allowlist", async () => {
    const { client, server } = await connect(fakeService());

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "collab_request_review",
      "collab_run_status",
      "collab_status",
    ]);
    await client.close();
    await server.close();
  });

  it("keeps requester and approval scope out of caller input and injects fixed review authority", async () => {
    const service = fakeService();
    const { client, server } = await connect(service);
    const artifactContent = "immutable review artifact";
    const artifactHash = createHash("sha256").update(artifactContent).digest("hex");
    const tools = await client.listTools();
    const requestTool = tools.tools.find((tool) => tool.name === "collab_request_review");

    expect(requestTool?.inputSchema).not.toHaveProperty("properties.requester");
    expect(requestTool?.inputSchema).not.toHaveProperty("properties.approvalScope");
    const result = await client.callTool({
      name: "collab_request_review",
      arguments: {
        workspaceRoot: "/repo",
        artifactHash,
        artifactContent,
        prompt: "audit and critique",
        idempotencyKey: "review:immutable-artifact",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.requestReview).toHaveBeenCalledWith({
      requester: "codex",
      workspaceRoot: "/repo",
      artifactHash,
      artifactContent,
      prompt: "audit and critique",
      approvalScope: "workspace-read",
      idempotencyKey: "review:immutable-artifact",
    });
    await client.close();
    await server.close();
  });

  it("rejects caller-supplied authority fields before dispatch", async () => {
    const service = fakeService();
    const { client, server } = await connect(service);
    const artifactContent = "immutable review artifact";

    const result = await client.callTool({
      name: "collab_request_review",
      arguments: {
        requester: "grok",
        workspaceRoot: "/repo",
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        artifactContent,
        prompt: "audit and critique",
        approvalScope: "external",
        idempotencyKey: "review:authority-injection",
      },
    });

    expect(result.isError).toBe(true);
    expect(service.requestReview).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it.each(["claude-code", "grok-cli", "review-only-test-client"])(
    "rejects the mutating tool surface for a non-Codex MCP client profile: %s",
    async (clientName) => {
      const service = fakeService();
      const { client, server } = await connect(service, clientName);
      const result = await client.callTool({
        name: "collab_request_review",
        arguments: {
          workspaceRoot: "/repo",
          artifactHash: createHash("sha256").update("artifact").digest("hex"),
          artifactContent: "artifact",
          prompt: "audit",
          idempotencyKey: `review:${clientName}`,
        },
      });

      expect(result.isError).toBe(true);
      expect(service.requestReview).not.toHaveBeenCalled();
      await client.close();
      await server.close();
    },
  );

  it("uses a review-scoped status port and cannot fall through to generic run status", async () => {
    const genericRunStatus = vi.fn(async () => ({ secretWorkflowState: "must-not-leak" }));
    const service = {
      ...fakeService(),
      reviewStatus: vi.fn(async ({ reviewId }: { reviewId: string }) => {
        if (reviewId !== "review-allowed") throw new Error("review not found");
        return { review: { reviewId } };
      }),
      runStatus: genericRunStatus,
    };
    const { client, server } = await connect(service);

    const result = await client.callTool({
      name: "collab_run_status",
      arguments: { runId: "workflow-private" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.type === "text" ? content[0].text ?? "" : "";

    expect(result.isError).toBe(true);
    expect(text).not.toContain("must-not-leak");
    expect(service.reviewStatus).toHaveBeenCalledWith({ reviewId: "workflow-private" });
    expect(genericRunStatus).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("owns the stdio server and review runtime close lifecycle", async () => {
    const service = { ...fakeService(), close: vi.fn() };
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const runtime = await startStdioReviewOnlyMcpServer(service, {
      stdin: clientToServer,
      stdout: serverToClient,
    });
    const client = new Client({ name: "codex-mcp-client", version: "1.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "collab_request_review",
      "collab_run_status",
      "collab_status",
    ]);

    await client.close();
    await runtime.close();
    await runtime.close();
    expect(service.close).toHaveBeenCalledOnce();
  });
});
