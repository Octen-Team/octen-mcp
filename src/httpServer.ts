#!/usr/bin/env node
/**
 * Octen MCP server — remote HTTP entry (Streamable HTTP transport).
 *
 * The deployment shape follows Exa's (probed live, 2026-08-14 — see
 * docs/remote-mcp-feasibility.md):
 *
 *  - **Stateless.** All six tools are single-shot; there is no session state
 *    worth holding, and statelessness makes horizontal scaling a matter of
 *    adding instances. Concretely: a fresh Server + transport pair per POST,
 *    with `sessionIdGenerator: undefined`, torn down when the response closes.
 *  - **Auth is enforced at `tools/call`, not at the door.** `initialize` and
 *    `tools/list` succeed without a credential, so clients can connect and
 *    show the tools before a key is configured, and a wrong key fails at call
 *    time with an error that says what to fix — instead of an opaque refusal
 *    during the handshake, which is the hardest failure for a user to place.
 *  - **Two credential spellings.** `x-api-key: <key>` (our API's native
 *    header) and `Authorization: Bearer <key>` — some clients (Codex's URL
 *    servers, for one) can only send the latter.
 *
 * The key is bound per request via a closure handed to `createOctenServer` —
 * one process serves many tenants, so the credential must travel with the
 * call, never through module state.
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createOctenServer, VERSION } from "./server.js";
import { debug } from "./http.js";

const PORT = Number(process.env.PORT ?? "8080");

/** Extract the API key from either supported header. */
function apiKeyFrom(req: IncomingMessage): string | undefined {
  const direct = req.headers["x-api-key"];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token !== "") return token;
  }
  return undefined;
}

// Mirrors the header set Exa's endpoint advertises, so any client that works
// against theirs works against ours.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Accept, Content-Type, Authorization, x-api-key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = (req.url ?? "").split("?")[0];

  // Liveness only — deliberately no upstream round-trip, so a health probe
  // cannot consume quota or mask an API-side incident as our own.
  if (path === "/healthz") {
    json(res, 200, { status: "ok", name: "octen-mcp", version: VERSION });
    return;
  }

  if (path !== "/mcp") {
    json(res, 404, { error: "not found" });
    return;
  }

  if (req.method !== "POST") {
    // Stateless: no standalone SSE stream to GET, no session to DELETE.
    json(
      res, 405,
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This is a stateless MCP endpoint; use POST." }, id: null },
      { Allow: "POST, OPTIONS" }
    );
    return;
  }

  const apiKey = apiKeyFrom(req);
  debug(
    `http POST /mcp key=${apiKey ? apiKey.slice(0, 8) + "…" : "(none)"} ` +
    `ua=${(req.headers["user-agent"] ?? "-").toString().slice(0, 60)}`
  );

  // A fresh pair per request: request IDs cannot collide across concurrent
  // POSTs, and the closure pins this request's key to this request's calls.
  const server = createOctenServer({ getApiKey: () => apiKey, transport: "http" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    debug(`http transport error: ${(e as Error).message}`);
    if (!res.headersSent) {
      json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

httpServer.listen(PORT, () => {
  const actual = (httpServer.address() as { port: number }).port;
  // stderr, like every other diagnostic — stdout stays silent even though this
  // transport doesn't use it, so log-scraping setups behave the same for both.
  console.error(`[octen-mcp] v${VERSION} HTTP transport listening on :${actual}/mcp`);
});
