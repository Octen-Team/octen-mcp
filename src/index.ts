#!/usr/bin/env node
/**
 * Octen MCP server — exposes Octen's /search and /extract as LLM-callable tools.
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
import {
  searchTool,
  handleSearch,
  newsSearchTool,
  handleNewsSearch,
  broadSearchTool,
  handleBroadSearch,
} from "./search.js";
import { imageSearchTool, handleImageSearch } from "./imageSearch.js";
import { videoSearchTool, handleVideoSearch } from "./videoSearch.js";

const server = new Server(
  {
    name: "octen-mcp",
    version: "0.3.6",
  },
  {
    capabilities: {
      tools: {}, // we expose tools (not resources or prompts in v1)
    },
  }
);

// Beta tools (image_search, video_search) are invite-only. A host can hide them
// from tool discovery so agents never surface capabilities most accounts can't use.
// Default preserves existing behavior (Beta tools listed); set
// OCTEN_ENABLE_BETA_TOOLS to a falsy value (false/0/off/no) to omit them entirely.
const betaFlag = (process.env.OCTEN_ENABLE_BETA_TOOLS ?? "").trim().toLowerCase();
const BETA_TOOLS_ENABLED = !["false", "0", "off", "no"].includes(betaFlag);
const BETA_TOOL_NAMES = new Set(["image_search", "video_search"]);

const enabledTools = [
  searchTool,
  newsSearchTool,
  broadSearchTool,
  extractTool,
  ...(BETA_TOOLS_ENABLED ? [imageSearchTool, videoSearchTool] : []),
];

// 1. List available tools — clients call this first to discover what we offer.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: enabledTools,
}));

// 2. Dispatch tool calls.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (!BETA_TOOLS_ENABLED && BETA_TOOL_NAMES.has(name)) {
    return {
      isError: true,
      content: [
        { type: "text", text: `Tool "${name}" is disabled: Beta tools are turned off via OCTEN_ENABLE_BETA_TOOLS.` },
      ],
    };
  }

  switch (name) {
    case "search":
      return await handleSearch(args ?? {});
    case "news_search":
      return await handleNewsSearch(args ?? {});
    case "broad_search":
      return await handleBroadSearch(args ?? {});
    case "extract":
      return await handleExtract(args ?? {});
    case "image_search":
      return await handleImageSearch(args ?? {});
    case "video_search":
      return await handleVideoSearch(args ?? {});
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