#!/usr/bin/env node
/**
 * Octen MCP server — exposes Octen's /search and /extract as LLM-callable tools.
 *
 * Transport: stdio (Claude Desktop / Claude Code / Cursor compatible).
 * The same Server + tool handlers can later be reused under an HTTP/SSE
 * transport without changing the tool definition.
 */
import { createRequire } from "node:module";

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
import { debug } from "./http.js";

// Read the version from package.json rather than restating it here — the
// hardcoded copy silently drifted (0.3.6 while the package shipped as 0.3.7),
// which made the version a client reported useless for triaging bug reports.
const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const server = new Server(
  {
    name: "octen-mcp",
    version: VERSION,
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
let callSeq = 0;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // Stamp the moment the call reached this process, before any of our work.
  //
  // This is the measurement that settles who owns a slow call. Subtract this
  // timestamp from the one the MCP client recorded when it issued the tool
  // call, and the difference is time spent entirely outside octen-mcp — in the
  // host, or in whatever relays between them. Without it, a client-side stopwatch
  // attributes that delay to us by default, because we are the last thing in
  // the chain that reports anything at all.
  const seq = ++callSeq;
  const receivedAt = Date.now();
  debug(`call #${seq} received tool=${name}`);

  const finish = <T>(result: T): T => {
    debug(`call #${seq} returning tool=${name} handler_total=${Date.now() - receivedAt}ms`);
    return result;
  };

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
      return finish(await handleSearch(args ?? {}));
    case "news_search":
      return finish(await handleNewsSearch(args ?? {}));
    case "broad_search":
      return finish(await handleBroadSearch(args ?? {}));
    case "extract":
      return finish(await handleExtract(args ?? {}));
    case "image_search":
      return finish(await handleImageSearch(args ?? {}));
    case "video_search":
      return finish(await handleVideoSearch(args ?? {}));
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
  console.error(`[octen-mcp] v${VERSION} started, listening on stdio`);
}

main().catch((err) => {
  console.error("[octen-mcp] fatal:", err);
  process.exit(1);
});