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
import { logEvent, type HandlerContext } from "./http.js";
import { validateArgs } from "./validate.js";

// Read the version from package.json rather than restating it here — the
// hardcoded copy silently drifted (0.3.6 while the package shipped as 0.3.7),
// which made the version a client reported useless for triaging bug reports.
const require = createRequire(import.meta.url);
export const { version: VERSION } = require("../package.json") as { version: string };

// Beta tools (image_search, video_search) are invite-only. A host can hide them
// from tool discovery so agents never surface capabilities most accounts can't
// use. This is a process-level switch: under stdio that means per-install;
// under HTTP it gates the whole deployment. The tool list is deliberately NOT
// per-key: `initialize` and `tools/list` are
// unauthenticated, so the list must be computable without a credential — a key
// without Beta access gets a clear 403 envelope error at call time instead.
const betaFlag = (process.env.OCTEN_ENABLE_BETA_TOOLS ?? "").trim().toLowerCase();
const BETA_TOOLS_ENABLED = !["false", "0", "off", "no"].includes(betaFlag);
const BETA_TOOL_NAMES = new Set(["image_search", "video_search"]);

const allTools = [
  searchTool,
  newsSearchTool,
  broadSearchTool,
  extractTool,
  imageSearchTool,
  videoSearchTool,
];

const enabledTools = allTools.filter((t) => BETA_TOOLS_ENABLED || !BETA_TOOL_NAMES.has(t.name));

/**
 * Every tool this process can serve, after the Beta switch.
 *
 * Exported so the transport can reject an unknown name in a per-connection
 * tool selection *before* building a server, and say which names are real. A
 * selection must never be a way around the Beta switch, so a Beta tool that is
 * switched off is absent here and cannot be selected.
 */
export const AVAILABLE_TOOL_NAMES: readonly string[] = enabledTools.map((t) => t.name);

/**
 * Every tool name this build knows, Beta switch ignored.
 *
 * Exists only so a refusal can tell the two cases apart. Answering
 * `?tools=image_search` on a Beta-off deployment with "Unknown tool name" is
 * false — the name is real, it is this deployment that does not serve it — and
 * it sends whoever reads the message hunting for a typo that is not there.
 * Both are still refused; only the sentence differs.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = allTools.map((t) => t.name);

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
  /**
   * Restrict this server instance to these tool names; omitted means all.
   *
   * Per instance rather than per process, because the HTTP transport builds a
   * fresh server for every request and can therefore honour a different
   * selection per connection. The saving is context, not capability: a client
   * loads every advertised tool's full schema into the model's context, so a
   * caller who only wants `search` should not have to carry the description of
   * five tools it will never call.
   *
   * Callers are expected to have validated the names against
   * {@link AVAILABLE_TOOL_NAMES} — this only filters.
   */
  tools?: readonly string[];
}

export function createOctenServer(opts: CreateServerOptions): Server {
  const server = new Server(
    {
      name: "octen-mcp",
      version: VERSION,
      // Branding surface for connector directories and client UIs — the
      // fields those directories read. Purely declarative.
      title: "Octen",
      websiteUrl: "https://octen.ai",
      icons: [{ src: "https://octen.ai/favicon.ico", mimeType: "image/x-icon" }],
    },
    {
      capabilities: {
        tools: {}, // we expose tools (not resources or prompts in v1)
      },
    }
  );

  const selected = opts.tools
    ? enabledTools.filter((t) => opts.tools!.includes(t.name))
    : enabledTools;
  const selectedNames = new Set(selected.map((t) => t.name));
  const byName = new Map(selected.map((t) => [t.name, t]));

  // 1. List available tools — clients call this first to discover what we offer.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: selected,
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
    logEvent("call_received", { seq, tool: name, transport: opts.transport },
      `call #${seq} received tool=${name} transport=${opts.transport}`);

    // In a `finally`, not around each return: the beta-disabled and
    // unknown-tool branches return without touching the switch, and a handler
    // that throws (anything not an OctenHttpError is deliberately rethrown)
    // skipped it entirely. Each of those logged "received" and never
    // "returning", so scanning the trace for calls that never came back — the
    // reason the pair exists — produced false hangs.
    const finish = () =>
      logEvent("call_returning", { seq, tool: name, handler_ms: Date.now() - receivedAt },
        `call #${seq} returning tool=${name} handler_total=${Date.now() - receivedAt}ms`);

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

      // Enforced on the call path too, not only in the listing. A selection
      // that merely hid tools would be decoration: nothing stops a client from
      // calling a name it was never shown, and a caller who narrowed the set
      // for cost or blast-radius reasons would be getting neither.
      if (!selectedNames.has(name)) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: opts.tools && AVAILABLE_TOOL_NAMES.includes(name)
              ? `Tool "${name}" exists but is not enabled for this connection ` +
                `(enabled: ${[...selectedNames].join(", ")}).`
              : `Unknown tool: ${name}`,
          }],
        };
      }

      // Against the tool's own advertised schema, not a copy of its rules —
      // a duplicated rule set drifts the first time someone edits a schema,
      // and drifts silently. The SDK does not do this for us: measured,
      // `count: 999999` against `maximum: 100` was forwarded upstream intact.
      const schemaError = validateArgs(byName.get(name)?.inputSchema, args ?? {});
      if (schemaError) {
        return { isError: true, content: [{ type: "text", text: `Invalid arguments for \`${name}\`: ${schemaError}` }] };
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
        /* c8 ignore next 8 -- unreachable: the membership check above rejects
           any name not in this switch. Kept so that adding a tool to the
           roster without a case here fails loudly rather than falling through
           to whatever the last case happened to be. */
        default:
          // MCP convention: return an error result, don't throw.
          return {
            isError: true,
            content: [
              { type: "text", text: `Tool "${name}" is advertised but not wired up — this is a bug in octen-mcp.` },
            ],
          };
      }
    } finally {
      finish();
    }
  });

  return server;
}
