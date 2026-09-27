import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaperclipMcpServer } from "./index.js";

const RUNTIME_URL = "http://localhost:3100/internal/runtime-tools";
const RUNTIME_TOKEN = "runtime-tools-token-for-test";

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "test-key",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

async function connectedClient() {
  const { server, tools } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "list-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, tools };
}

function resultText(result: CallToolResult): string {
  const block = result.content.find((entry) => entry.type === "text");
  return block?.type === "text" ? block.text : "";
}

// KEE-1003 switched registration from server.tool(name, desc, schema.shape, cb)
// to server.registerTool(name, { inputSchema: schema }, cb) so a strict schema
// survives. These guard the switch: every tool must still be discoverable, with
// a usable description and a published input schema.
describe("paperclip MCP tool registration", () => {
  it("lists every defined tool with a description and an object input schema", async () => {
    const { client, tools } = await connectedClient();
    const listed = (await client.listTools()).tools;

    expect(listed).toHaveLength(tools.length);
    for (const tool of listed) {
      expect(tool.description, `${tool.name} lost its description`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name} input schema is not an object`).toBe("object");
    }
  });

  it("publishes the update fields agents need, including the real assignment field", async () => {
    const { client } = await connectedClient();
    const listed = (await client.listTools()).tools;
    const update = listed.find((tool) => tool.name === "paperclipUpdateIssue");

    const properties = update?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain("issueId");
    expect(Object.keys(properties)).toContain("assigneeAgentId");
    // The key from the bug report is not a field; it must not be advertised.
    expect(Object.keys(properties)).not.toContain("assigneeId");
  });
});

// The registerTool switch does more than fix paperclipUpdateIssue. Two tools were
// already `.strict()` in @paperclipai/shared and were having that strictness
// stripped by the same SDK bug, so this change repairs them too. That is a live
// behaviour change on tools in active use, so it is pinned here deliberately:
// a caller that today sends an extra key and gets a real connection-intent card
// back will get an MCP -32602 validation error instead. Dropping the key (the old
// behaviour) is what produced the KEE-579-class silent no-op, but a caller
// regression is still possible, so this is stated rather than assumed safe.
describe("connection tool strictness repaired by the registration fix", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL", RUNTIME_URL);
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL", RUNTIME_URL);
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_TOKEN", RUNTIME_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const cases = [
    { tool: "connections_search", valid: { query: "slack" }, extra: { query: "slack", bogusKey: "extra" } },
    { tool: "connection_request", valid: { service: "slack" }, extra: { service: "slack", bogusKey: "extra" } },
  ] as const;

  for (const { tool, valid, extra } of cases) {
    it(`${tool} still serves a valid call over the runtime endpoint`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { client } = await connectedClient();

      const result = (await client.callTool({ name: tool, arguments: valid })) as CallToolResult;

      expect(result.isError, `expected success, got: ${resultText(result)}`).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(RUNTIME_URL);
    });

    it(`${tool} rejects an unknown key instead of silently dropping it`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const { client } = await connectedClient();

      const result = (await client.callTool({ name: tool, arguments: extra })) as CallToolResult;

      expect(result.isError, `expected a tool error, got: ${resultText(result)}`).toBe(true);
      expect(resultText(result)).toContain("bogusKey");
      // A rejected call must not reach the runtime endpoint.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
