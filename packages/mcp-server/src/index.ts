import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    // KEE-1003: register the schema *instance*, not `tool.schema.shape`. The
    // SDK's `getZodSchemaObject()` turns a raw shape back into a fresh
    // `z.object(shape)`, which is never strict, so `.strict()` on the tool
    // schema was discarded before argument validation. A schema instance is
    // passed through untouched, so a strict tool stays strict. A lenient tool
    // is unaffected: `normalizeObjectSchema()` hands an object instance
    // straight to `safeParseAsync()`.
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.execute,
    );
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
