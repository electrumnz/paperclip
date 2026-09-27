import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaperclipMcpServer } from "./index.js";

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "test-key",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function resultText(result: CallToolResult): string {
  const block = result.content.find((entry) => entry.type === "text");
  return block?.type === "text" ? block.text : "";
}

async function connectedClient() {
  const { server } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kee-1003-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The JSON body of the first PATCH /issues/... the server sent. */
function patchedIssueBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// KEE-1003: the KEE-579 symptom, relocated from the REST route to the MCP tool
// boundary. An agent calling paperclipUpdateIssue with a mistyped field got a
// successful tool call that wrote nothing, with no error to explain why.
describe("paperclipUpdateIssue unknown-key handling over MCP", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown field instead of reporting a successful no-op", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "PAP-1135" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connectedClient();

    const result = (await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: { issueId: "PAP-1135", assigneeId: "22222222-2222-2222-2222-222222222222" },
    })) as CallToolResult;

    expect(result.isError, `expected a tool error, got: ${resultText(result)}`).toBe(true);
    // The unknown key must be named, so the caller can correct the typo.
    expect(resultText(result)).toContain("assigneeId");
    // Nothing may be written on a rejected call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still forwards the real assignment field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "PAP-1135" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connectedClient();

    const result = (await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: { issueId: "PAP-1135", assigneeAgentId: "22222222-2222-2222-2222-222222222222" },
    })) as CallToolResult;

    expect(result.isError, `expected success, got: ${resultText(result)}`).toBeFalsy();
    expect(patchedIssueBody(fetchMock)).toMatchObject({
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("keeps issueId out of the forwarded body so the strict PATCH route stays compatible", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "PAP-1135" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connectedClient();

    await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: { issueId: "PAP-1135", status: "in_progress" },
    });

    const body = patchedIssueBody(fetchMock);
    expect(body).toMatchObject({ status: "in_progress" });
    // KEE-579 made the REST route strict; a leaked issueId would be a 400 there.
    expect(body).not.toHaveProperty("issueId");
  });

  it("leaves an absent field absent rather than inventing a null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "PAP-1135" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connectedClient();

    await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: { issueId: "PAP-1135" },
    });

    const body = patchedIssueBody(fetchMock);
    expect(Object.keys(body)).toEqual([]);
  });
});
