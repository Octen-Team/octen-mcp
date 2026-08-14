/**
 * Transport-agnostic assembly of the Octen MCP server.
 *
 * Everything about the server that is NOT "how bytes arrive" lives here — the
 * tool roster, dispatch, per-call observability, Beta gating — so the stdio
 * entry (`index.ts`) and the HTTP entry (`httpServer.ts`) cannot drift apart.
 * The two entries differ in exactly one meaningful way, expressed as
 * {@link CreateServerOptions.getApiKey}: stdio serves one user whose key lives
 * in the environment; HTTP serves many keys, one per request.
 */
import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { debug, type HandlerContext } from "./http.js";

// Read the version from package.json rather than restating it here — the
// hardcoded copy silently drifted (0.3.6 while the package shipped as 0.3.7),
// which made the version a client reported useless for triaging bug reports.
const require = createRequire(import.meta.url);
export const { version: VERSION } = require("../package.json") as { version: string };

// Beta tools (image_search, video_search) are invite-only. A host can hide them
// from tool discovery so agents never surface capabilities most accounts can't
// use. This is a process-level switch: under stdio that means per-install;
// under HTTP it gates the whole deployment. The tool list is deliberately NOT
// per-key (Exa's design, which we follow): `initialize` and `tools/list` are
// unauthenticated, so the list must be computable without a credential — a key
// without Beta access gets a clear 403 envelope error at call time instead.
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

// Monotonic per process, shared across per-request server instances in HTTP
// mode, so "call #N" in the trace stays a process-wide sequence.
let callSeq = 0;

export interface CreateServerOptions {
  /**
   * Resolves the credential for one call. Bound per server instance: stdio
   * builds one server whose key comes from the environment; the HTTP entry
   * builds a server per request with the header key closed over — module
   * state would hand one tenant's key to another's request.
   */
  getApiKey: () => string | undefined;
  transport: "stdio" | "http";
}

export function createOctenServer(opts: CreateServerOptions): Server {
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

  // 1. List available tools — clients call this first to discover what we offer.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools,
  }));

  // 2. Dispatch tool calls.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    // Stamp the moment the call reached this process, before any of our work.
    //
    // This is the measurement that settles who owns a slow call. Subtract this
    // timestamp from the one the MCP client recorded when it issued the tool
    // call, and the difference is time spent entirely outside octen-mcp — in
    // the host, or in whatever relays between them. Without it, a client-side
    // stopwatch attributes that delay to us by default, because we are the
    // last thing in the chain that reports anything at all.
    const seq = ++callSeq;
    const receivedAt = Date.now();
    debug(`call #${seq} received tool=${name} transport=${opts.transport}`);

    // In a `finally`, not around each return: the beta-disabled and
    // unknown-tool branches return without touching the switch, and a handler
    // that throws (anything not an OctenHttpError is deliberately rethrown)
    // skipped it entirely. Each of those logged "received" and never
    // "returning", so scanning the trace for calls that never came back — the
    // reason the pair exists — produced false hangs.
    const finish = () =>
      debug(`call #${seq} returning tool=${name} handler_total=${Date.now() - receivedAt}ms`);

    const ctx: HandlerContext = { apiKey: opts.getApiKey(), transport: opts.transport };

    try {
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
          return await handleSearch(args ?? {}, ctx);
        case "news_search":
          return await handleNewsSearch(args ?? {}, ctx);
        case "broad_search":
          return await handleBroadSearch(args ?? {}, ctx);
        case "extract":
          return await handleExtract(args ?? {}, ctx);
        case "image_search":
          return await handleImageSearch(args ?? {}, ctx);
        case "video_search":
          return await handleVideoSearch(args ?? {}, ctx);
        default:
          // MCP convention: return an error result, don't throw.
          return {
            isError: true,
            content: [
              { type: "text", text: `Unknown tool: ${name}` },
            ],
          };
      }
    } finally {
      finish();
    }
  });

  return server;
}
