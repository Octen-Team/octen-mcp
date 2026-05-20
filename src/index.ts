#!/usr/bin/env node
/**
 * Octen Fetch MCP server — exposes /v1/extract as an LLM-callable tool.
 *
 * Transport: stdio (Claude Desktop / Claude Code / Cursor compatible).
 * The same Server + tool handlers can later be reused under an HTTP/SSE
 * transport without changing the tool definition.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { extractTool, handleExtract } from "./extract.js";

const server = new Server(
  {
    name: "octen-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {}, // we expose tools (not resources or prompts in v1)
    },
  }
);

// 1. List available tools — clients call this first to discover what we offer.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [extractTool],
}));

// 2. Dispatch tool calls.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "extract":
      return await handleExtract(args ?? {});
    default:
      // MCP convention: return an error result, don't throw.
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown tool: ${name}` },
        ],
      };
  }
});

// 3. Wire up the stdio transport and start listening.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: do NOT console.log to stdout here — stdout is the MCP wire.
  // Use console.error for any startup logging.
  console.error("[octen-mcp] server started, listening on stdio");
}

main().catch((err) => {
  console.error("[octen-mcp] fatal:", err);
  process.exit(1);
});