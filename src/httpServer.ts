#!/usr/bin/env node
/**
 * Octen MCP server — remote HTTP entry (Streamable HTTP transport).
 *
 * Shape of the deployment:
 *
 *  - **Stateless.** All six tools are single-shot; there is no session state
 *    worth holding, and statelessness makes horizontal scaling a matter of
 *    adding instances. Concretely: a fresh Server + transport pair per POST,
 *    with `sessionIdGenerator: undefined`, torn down when the response closes.
 *    No `Mcp-Session-Id` is issued; revisit only if a real client needs one.
 *  - **Where auth is enforced depends on whether there is an authorization
 *    server.** With one configured, an uncredentialed request is answered 401
 *    + `WWW-Authenticate` on every method — that challenge is the only trigger
 *    MCP clients act on, and without it a client concludes the server needs no
 *    authorization and never offers to log in. Without one, there is nowhere
 *    to send anybody, so `initialize` and `tools/list` stay open and a missing
 *    key fails at call time with an error that says what to fix.
 *  - **Three credential spellings**, in this order: `x-api-key: <key>`,
 *    `Authorization: Bearer <key>` (some clients can only send that one), and
 *    an `octenApiKey` query parameter for clients that can be given nothing
 *    but a URL.
 *  - **`?tools=a,b`** narrows the roster for one connection, because a client
 *    loads every advertised tool's schema into the model's context.
 *
 * The key is bound per request via a closure handed to `createOctenServer` —
 * one process serves many tenants, so the credential must travel with the
 * call, never through module state.
 *
 * Built to run as a Kubernetes Deployment: liveness/readiness both probe
 * `/healthz`, which flips to 503 the moment SIGTERM arrives so the pod is
 * pulled from endpoints while in-flight requests drain. The pod spec must set
 * `terminationGracePeriodSeconds` above the longest tool budget (300s for
 * `broad_search`) or rolling deploys will kill live calls. Reference manifests
 * live with the deployment spec (the infra repo owns the real ones — they are
 * deliberately not in this public repo).
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createOctenServer, VERSION, AVAILABLE_TOOL_NAMES, KNOWN_TOOL_NAMES } from "./server.js";
import { logEvent, envInt } from "./http.js";
import {
  looksLikeAccessToken, apiKeyFromAccessToken,
  TokenInvalidError, OAuthBackendError, type OAuthRsConfig,
} from "./oauthRs.js";

// 0 is legal and means "ephemeral port" — the test harness relies on it.
const PORT = envInt("PORT", 8080, 0);

/**
 * OAuth surface — OFF unless both are configured, so a self-hosted instance
 * without an authorization server advertises nothing it cannot honour:
 *
 *  - OCTEN_OAUTH_AUTHORIZATION_SERVER: the AS base URL (https://auth.octen.ai)
 *  - OCTEN_MCP_RESOURCE: this deployment's public resource URL
 *    (https://mcp.octen.ai/mcp). Cannot be derived behind a fronting proxy,
 *    and RFC 8707 aud-binding demands it byte-for-byte, so it is explicit.
 *
 * When on: the RFC 9728 protected-resource metadata is served (both the bare
 * and the path-derived well-known, matching what real clients fetch), and any
 * uncredentialed request is answered with the 401 challenge that makes clients
 * start OAuth at all — without a 401 + `WWW-Authenticate`, a client treats the
 * server as unauthenticated and the user never sees a consent screen.
 * `/mcp/oauth` and `?login` force that challenge even when a credential is
 * present, which is the only route from an already-configured API key to OAuth.
 */
const AUTH_SERVER = (process.env.OCTEN_OAUTH_AUTHORIZATION_SERVER ?? "").trim();
const RESOURCE = (process.env.OCTEN_MCP_RESOURCE ?? "").trim();
const OAUTH_ENABLED = AUTH_SERVER !== "" && RESOURCE !== "";

// The grant→key exchange needs the internal resolve endpoint and its service
// token (spec §I2). Without them, JWT-shaped credentials are rejected 503
// rather than silently forwarded upstream as if they were API keys.
const RS_CONFIG: OAuthRsConfig = {
  authorizationServer: AUTH_SERVER,
  resource: RESOURCE,
  resolveUrl: (process.env.OCTEN_OAUTH_RESOLVE_URL ?? "").trim() || undefined,
  resolveToken: (process.env.OCTEN_OAUTH_RESOLVE_TOKEN ?? "").trim() || undefined,
};

/**
 * Both URLs are parsed at startup, not on first use.
 *
 * Deferring it meant a bad value passed every startup check — the process
 * listened, `/healthz` answered 200, so Kubernetes kept the pod in rotation —
 * and then threw out of the request handler on the first `?login`, killing the
 * process. A pod that is healthy until someone uses it is the worst shape this
 * can fail in, so an unusable value stops the process here, where the log line
 * is the first thing an operator sees.
 */
function requireUrl(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    console.error(`[octen-mcp] ${name} is not a valid absolute URL: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    console.error(`[octen-mcp] ${name} must be http(s), got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return u;
}

const RESOURCE_URL = OAUTH_ENABLED ? requireUrl("OCTEN_MCP_RESOURCE", RESOURCE) : undefined;
if (OAUTH_ENABLED) {
  requireUrl("OCTEN_OAUTH_AUTHORIZATION_SERVER", AUTH_SERVER);
  // A trailing slash here is a 100% outage that looks like every user's token
  // being bad. The value is used two ways and breaks both: the JWKS URL
  // becomes `…//api/oauth/jwks`, and `iss` is compared byte-for-byte against a
  // value the authorization server never emits with a trailing slash — so
  // every token is refused. Measured. The rejection message does print both
  // strings, but they differ by the one character nobody sees, so this is
  // worth refusing at startup rather than explaining afterwards.
  if (AUTH_SERVER.endsWith("/")) {
    console.error(
      `[octen-mcp] OCTEN_OAUTH_AUTHORIZATION_SERVER must not end with "/" — ` +
      `got ${JSON.stringify(AUTH_SERVER)}. It is compared byte-for-byte against the ` +
      `\`iss\` claim and used to build the JWKS URL; a trailing slash breaks both.`);
    process.exit(1);
  }
}

/**
 * RFC 9728 path-derived form: the well-known prefix followed by the resource's
 * own path. Derived rather than hardcoded to `/mcp` — a self-hosted instance
 * mounted elsewhere would otherwise advertise a document at a path it does not
 * serve, and clients that follow the challenge would 404 into a dead end.
 */
const PRM_PATH = RESOURCE_URL
  ? `/.well-known/oauth-protected-resource${RESOURCE_URL.pathname === "/" ? "" : RESOURCE_URL.pathname}`
  : "";
const PRM_URL = RESOURCE_URL ? `${RESOURCE_URL.origin}${PRM_PATH}` : "";

function prmDocument(): unknown {
  return {
    resource: RESOURCE,
    authorization_servers: [AUTH_SERVER],
    scopes_supported: ["mcp:tools"],
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 6750 §3 quoted-string charset for `error_description`: printable ASCII
 * minus `"` and `\`. The values passed through here are partly derived from an
 * unverified token, and a CRLF reaching `res.writeHead` throws
 * `ERR_INVALID_CHAR` out of the request handler — an unauthenticated remote
 * kill. {@link safeKid} already scrubs the one field known to carry attacker
 * text; this is the layer that holds when the next such field is added without
 * anyone remembering why the first one was scrubbed.
 */
function headerSafe(s: string): string {
  return s.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, " ").slice(0, 200);
}

/**
 * Requests larger than this are refused before the transport parses them.
 *
 * 6 MiB, sized so `image_search`'s `image_data` works without configuration:
 * the API caps that at 5 MiB encoded, and the JSON-RPC envelope around it is
 * negligible, so this leaves headroom without inviting much else. A default
 * below the largest argument a tool accepts would mean the tool is advertised
 * and unusable over this transport — the client sees a 413 with no obvious
 * connection to the picture it tried to send.
 *
 * It is a real cost: an in-flight request may now hold 6 MiB rather than 1,
 * and the credential check runs before the body is read, so reaching it takes
 * a valid key. Deployments that never send images can and should turn this
 * back down.
 */
const MAX_BODY_BYTES = envInt("OCTEN_MCP_MAX_BODY", 6 * 1024 * 1024);

class BodyTooLargeError extends Error {}
/** Thrown when the *sum* of bodies in flight would exceed the budget → 503. */
class BodyBudgetExceededError extends Error {}

/**
 * Ceiling on the total bytes all in-flight request bodies may hold at once.
 *
 * The per-request cap stops one enormous request; it does nothing about many
 * ordinary ones. With the per-request cap at 6 MiB, forty concurrent bodies
 * measured 772 MB resident against a 768 MiB container limit — an OOM kill
 * reachable by anyone holding a key, with no single request breaking a rule.
 *
 * 24 MiB, not because that is a lot of bytes but because of what each byte
 * costs once it is in the process: a 5 MB ASCII body is ~10 MB as a UTF-16 JS
 * string, and it exists two or three times over — the concatenated body, the
 * parsed argument, the outgoing request. Measured, the resident cost runs
 * about ten times the budget, so 24 MiB is what fits a 768 MiB container with
 * room to work. It still allows several largest-case images at once, far more
 * concurrent image search than a real deployment does.
 * Over it, the newest request is refused 503 + Retry-After: this is capacity,
 * not a malformed call, and the caller should come back rather than change
 * anything.
 */
const MAX_INFLIGHT_BODY_BYTES = envInt("OCTEN_MCP_MAX_INFLIGHT_BODY", 24 * 1024 * 1024);
let inflightBodyBytes = 0;

/**
 * How long we keep draining an over-sized request after answering 413, so the
 * answer survives the close. See the drain block for why hanging up
 * immediately loses the response.
 */
const BODY_DRAIN_MS = envInt("OCTEN_MCP_BODY_DRAIN_MS", 2_000);

/**
 * Read the body with the cap enforced on bytes actually received.
 *
 * Checking `Content-Length` alone is not a cap, it is a cap against clients
 * that volunteer their size. A chunked request declares no length, so the
 * check passed and the transport buffered whatever arrived — measured at 75 MB
 * accepted against a 1 MiB cap, on an endpoint that needs no credential to
 * reach and a container limited to 512 MiB. Metering the stream is the only
 * version of this check that holds.
 *
 * The parsed value is handed to the transport (which accepts a pre-parsed
 * body) rather than letting it read the stream again, because there is no way
 * to meter a stream someone else is consuming.
 */
/**
 * A request's claim on {@link inflightBodyBytes}, released once — by whoever
 * gets there first.
 *
 * The charge has to outlive the read. An earlier version released it the
 * moment the body finished arriving, which accounted for the wrong window
 * entirely: the string is still held while it is parsed, dispatched, and sent
 * upstream, so the budget was measuring a few milliseconds of each request's
 * several seconds. Forty concurrent 5 MB bodies still reached 1022 MB with it
 * in place.
 */
interface BodyCharge { bytes: number; release(): void }

function newBodyCharge(): BodyCharge {
  return {
    bytes: 0,
    release() { inflightBodyBytes -= this.bytes; this.bytes = 0; },
  };
}

function readBody(req: IncomingMessage, limit: number, charge: BodyCharge): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    // Failures release here; success hands the charge to the caller, which
    // holds it until the response closes.
    const settle = (fn: () => void, releaseNow: boolean) => {
      if (done) return;
      done = true;
      if (releaseNow) charge.release();
      fn();
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        settle(() => reject(new BodyTooLargeError(`body exceeded ${limit} bytes`)), true);
        return;
      }
      inflightBodyBytes += c.length;
      charge.bytes += c.length;
      if (inflightBodyBytes > MAX_INFLIGHT_BODY_BYTES) {
        settle(() => reject(new BodyBudgetExceededError(
          `in-flight request bodies would exceed ${MAX_INFLIGHT_BODY_BYTES} bytes`)), true);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks).toString("utf8")), false));
    req.on("error", (e) => settle(() => reject(e), true));
    req.on("aborted", () => settle(() => reject(new Error("client aborted the request")), true));
  });
}

/**
 * How long to wait for in-flight requests after SIGTERM. Default covers the
 * longest tool budget (broad_search 300s) with a margin; the pod's
 * terminationGracePeriodSeconds must exceed it or Kubernetes wins the race.
 */
const DRAIN_TIMEOUT_MS = envInt("OCTEN_DRAIN_TIMEOUT_MS", 310_000);

/**
 * Query-string spellings accepted as a credential.
 *
 * Exactly one, deliberately. Accepting alternative spellings to make somebody
 * else's config paste in unchanged buys nothing — nobody configuring this
 * server goes looking for a name it does not document — and every extra name
 * is one more string on our public interface that docs have to explain and a
 * packet capture will show.
 *
 * This has nothing to do with logging: redactUrl masks values and keeps
 * parameter names, and only fires on crash paths. A client that sends an
 * unrecognised spelling still puts it in a crash log; what appears there
 * depends on what the client sent, not on what we accept.
 */
const QUERY_KEY_PARAMS = ["octenApiKey"];

/**
 * Replace every query-string *value* with a placeholder.
 *
 * Whole value, never a prefix: a truncated credential still hands out a usable
 * head start, and printing it truncated reads as though it had been made safe.
 * Every parameter is redacted rather than a known list of key names, so a
 * parameter added later is redacted before anyone remembers to add it here.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const path = url.slice(0, q);
  const names: string[] = [];
  for (const [k] of new URLSearchParams(url.slice(q + 1))) names.push(`${k}=<redacted>`);
  return names.length ? `${path}?${names.join("&")}` : path;
}

/**
 * Extract the API key: `x-api-key`, then `Authorization: Bearer`, then the
 * query string.
 *
 * The query fallback is last on purpose — any client that can set a header
 * should keep using one. It exists for clients that can only be handed a URL,
 * e.g. a hosted-connector UI whose only input field is the endpoint.
 *
 * It is **not** needed for Claude Desktop: that config spawns `mcp-remote`,
 * which does take headers — `--header Name:Value`, and `--header-file <path>`
 * to keep the credential out of the process arguments (verified against
 * mcp-remote 0.6.0; an earlier version of this comment claimed it had "no
 * header option", which was simply wrong). Prefer `--header-file` there.
 *
 * A key in a URL is exposed to proxy logs, browser history and Referer headers
 * — none of which we control. What we do control is our own logs, which is why
 * {@link redactUrl} exists and why nothing here logs `req.url` raw.
 */
function apiKeyFrom(req: IncomingMessage): string | undefined {
  const direct = req.headers["x-api-key"];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token !== "") return token;
  }
  const query = queryOf(req);
  for (const name of QUERY_KEY_PARAMS) {
    const v = query.get(name);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * Read `?tools=a,b` into a validated selection.
 *
 * Unknown names are an error rather than a silent skip, and so is a selection
 * that leaves nothing. Both alternatives fail the same miserable way: the
 * connection comes up looking fine and a tool the caller asked for simply is
 * not there, which sends whoever debugs it looking at the tool rather than at
 * the spelling in their URL. A 400 that names the bad entry and lists the real
 * ones ends that in one round trip.
 *
 * Beta tools that are switched off are absent from `AVAILABLE_TOOL_NAMES`, so
 * naming one reads exactly like naming a tool that does not exist — a
 * selection cannot be used to re-enable them.
 */
function parseToolSelection(query: URLSearchParams): { tools?: readonly string[] } | { error: string } {
  const raw = query.get("tools");
  // Absent, or present-but-empty (`?tools=`): no selection, serve everything.
  if (raw === null || raw.trim() === "") return {};

  const asked = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const rejected = asked.filter((n) => !AVAILABLE_TOOL_NAMES.includes(n));
  if (rejected.length > 0) {
    // Both are refused, but not for the same reason, and saying so is the
    // whole point: a real tool name that this deployment does not serve is not
    // a typo, and calling it "unknown" sends the reader hunting for one that
    // is not there.
    const notHere = rejected.filter((n) => KNOWN_TOOL_NAMES.includes(n));
    const notReal = rejected.filter((n) => !KNOWN_TOOL_NAMES.includes(n));
    const list = (ns: string[]) => ns.map((n) => JSON.stringify(n)).join(", ");
    const parts: string[] = [];
    if (notReal.length > 0) {
      parts.push(`Unknown tool name${notReal.length > 1 ? "s" : ""}: ${list(notReal)}.`);
    }
    if (notHere.length > 0) {
      parts.push(
        `${list(notHere)} ${notHere.length > 1 ? "are" : "is"} not enabled on this deployment ` +
        `(Beta tools are off via OCTEN_ENABLE_BETA_TOOLS).`);
    }
    return { error: `${parts.join(" ")} Available: ${AVAILABLE_TOOL_NAMES.join(", ")}.` };
  }
  if (asked.length === 0) {
    return { error: `\`tools\` selected nothing. Available: ${AVAILABLE_TOOL_NAMES.join(", ")}.` };
  }
  // Deduplicated so `?tools=search,search` cannot advertise a tool twice.
  return { tools: [...new Set(asked)] };
}

/**
 * The logged fingerprint of a credential: enough to tell two keys apart in a
 * trace, never enough to be one.
 *
 * A flat 8-character prefix — what this used to be — is the whole credential
 * for anything shorter than that, and the query-string form makes short
 * hand-typed values more likely to turn up. Measured: a 7-character key
 * appeared in the log in full. Half the value, capped at 8, keeps traces
 * distinguishable without that edge.
 */
function keyFingerprint(key: string): string {
  return key.slice(0, Math.min(8, Math.floor(key.length / 2))) + "…";
}

/** Parse the request's query string. Never throws: `req.url` is attacker input. */
function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? "";
  const q = raw.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
}

// The header set hosted MCP endpoints advertise, so a browser-based client
// written against any of them works here unchanged.
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

// ---- Drain state -----------------------------------------------------------
//
// On SIGTERM: healthz flips to 503 (readiness pulls the pod from endpoints),
// new MCP requests are answered 503 + Retry-After — the listener stays open so
// a client racing endpoint removal gets a retryable answer instead of a TCP
// reset — and the process exits once in-flight work finishes or the drain
// budget runs out. A second signal exits immediately —
// that is the ctrl-c-twice escape hatch in local runs.
let draining = false;
let inFlight = 0;

/**
 * `http.createServer` does not await its handler, so a rejection escaping an
 * async one is an unhandled rejection — which Node turns into process exit by
 * default. That makes every un-caught throw anywhere in request handling a
 * whole-server outage rather than one failed request, and the throws reachable
 * from unauthenticated input are exactly the ones an attacker would look for
 * (an invalid header value from a hostile token header was one, fixed at its
 * source too). This boundary is what keeps the blast radius at one request no
 * matter which of those is found next.
 */
const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    logEvent("request_crash", { msg: (e as Error).message, url: redactUrl(req.url ?? "") },
      `unhandled error in request handler: ${(e as Error).message}`);
    // Only static, known-safe header values here: this is the last line of
    // defence, and a throw inside it would defeat the purpose.
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        // Even the last-resort answer names the fault. Reaching here at all is
        // a bug in this server, and the one thing that makes such a bug
        // findable from a user's report is the message they can quote.
        error: { code: -32603, message: `Unhandled error in octen-mcp: ${(e as Error).message}` },
        id: null,
      }));
    } else {
      res.destroy();
    }
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = (req.url ?? "").split("?")[0];

  // Liveness AND readiness — deliberately no upstream round-trip, so a health
  // probe cannot consume quota or mask an API-side incident as our own. The
  // drain flip is what makes rolling deploys graceful.
  if (path === "/healthz") {
    json(res, draining ? 503 : 200, {
      status: draining ? "draining" : "ok",
      name: "octen-mcp",
      version: VERSION,
    });
    return;
  }

  // Both spellings: the bare well-known (what some clients try first) and the
  // path-derived one this deployment advertises in its challenge.
  if (
    OAUTH_ENABLED &&
    req.method === "GET" &&
    (path === "/.well-known/oauth-protected-resource" || path === PRM_PATH)
  ) {
    json(res, 200, prmDocument());
    return;
  }

  // `/mcp/` too: a trailing slash is the commonest paste artifact in a URL a
  // human copies into a client config, and answering it with 404 makes a
  // working deployment look broken for a reason nobody inspects. `/mcp/oauth`
  // is the same endpoint with the forced-authorization behaviour below.
  if (path !== "/mcp" && path !== "/mcp/" && path !== "/mcp/oauth") {
    // Name the endpoints rather than a bare "not found": the commonest cause
    // is a client configured with the origin instead of the full MCP URL, and
    // that is invisible from the status code alone.
    json(res, 404, {
      error: `No handler for ${path || "/"}. This server exposes POST /mcp (MCP Streamable HTTP) ` +
        `and GET /healthz` + (OAUTH_ENABLED ? `, plus GET ${PRM_PATH}.` : "."),
    });
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

  if (draining) {
    json(res, 503, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Server is shutting down; retry against another instance." },
      id: null,
    }, { "Retry-After": "1" });
    return;
  }

  // Cheap early rejection on the declared size, before anything reads the
  // stream. Not a cap on its own — a chunked request declares nothing — which
  // is why `readBody` meters the bytes that actually arrive.
  const declaredLength = Number(req.headers["content-length"] ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    json(res, 413, {
      jsonrpc: "2.0",
      error: { code: -32000, message: `Request body exceeds ${MAX_BODY_BYTES} bytes ` +
          `(OCTEN_MCP_MAX_BODY). Sending an image as base64 needs this raised.` },
      id: null,
    });
    return;
  }

  // Counted from here, before credential resolution rather than after it.
  // Starting the count at dispatch left a request blocked on the resolve-key
  // round-trip invisible to the drain, so SIGTERM saw zero in flight and
  // exited underneath it — the client gets a reset instead of the clean 503
  // the drain exists to give it.
  inFlight++;
  // The body's claim on the shared budget is released with the response, not
  // with the read — see BodyCharge.
  const bodyCharge = newBodyCharge();
  res.on("close", () => { inFlight--; bodyCharge.release(); });

  const apiKey = apiKeyFrom(req);

  // OAuth trigger. When this deployment has an authorization server, a request
  // carrying NO credential is answered with the challenge — on every method,
  // `initialize` included, not only on a `?login` entrypoint.
  //
  // This is the MCP spec's trigger and the only one clients act on: 401 +
  // `WWW-Authenticate` → fetch the advertised metadata → discover the AS →
  // authorize. Gating it behind a query parameter made the flow depend on the
  // user pasting `…/mcp?login` rather than `…/mcp`; paste the plain URL and
  // `initialize` answers 200, so the client concludes the server needs no
  // authorization and never offers to log in. The failure then surfaces at the
  // first `tools/call` as a tool-level "no API key on this request" — which
  // reads as a misconfiguration the user should fix, not as an invitation to
  // authorize. Connected-but-never-authorized, with a misleading error at the
  // end of it.
  //
  // The cost is that anonymous `tools/list` is no longer possible against an
  // OAuth-enabled deployment. That was worth having when a credential could
  // only be a bare key pasted into a config; it is not worth the flow above
  // once there is an authorization server to send people to. Deployments
  // without one (self-hosted, bare keys only) are untouched: no AS to point
  // at, so nothing is advertised and enforcement stays at call time.
  //
  // Presence of a credential — even an unvalidated one — passes through here;
  // an invalid or expired JWT is answered 401 at validation just below, which
  // is what drives a client's automatic refresh.
  // Forced authorization. `/mcp/oauth` and `?login` issue the challenge even
  // when a credential IS present, which is the one thing the rule above cannot
  // express: someone already using a bare API key has no way to switch to
  // OAuth, because their key stops the challenge from ever being sent.
  //
  // Worth separating from the history here: `?login` used to be the *gate* on
  // the challenge — no `?login`, no challenge — and that was removed because
  // it made the whole flow depend on the user pasting a query parameter no
  // client adds on its own. What is added back is the opposite direction, and
  // does not reintroduce that gate: an uncredentialed request is still
  // challenged everywhere.
  //
  // With no authorization server configured there is nothing to force, so this
  // is inert and the path behaves as a plain alias — better than a 404 that
  // makes a working deployment look broken.
  const forceLogin = path === "/mcp/oauth" || queryOf(req).has("login");

  if (OAUTH_ENABLED && (apiKey === undefined || forceLogin)) {
    logEvent("oauth_challenge", {
      forced: forceLogin && apiKey !== undefined ? true : undefined,
      ua: (req.headers["user-agent"] ?? "").toString().slice(0, 60) || undefined,
    },
      `401 challenge issued (${apiKey === undefined ? "no credential" : "forced"})`);
    json(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        // Two different situations reach this response, and telling a caller
        // who *did* send a key that they sent none is the kind of wrong
        // message that sends someone to check their config for an hour.
        message: apiKey === undefined
          ? "No credential on this request. Send an Octen API key as `x-api-key: <key>` " +
            "(or `Authorization: Bearer <key>`, or the `octenApiKey` query parameter), or " +
            `complete the OAuth flow advertised in the WWW-Authenticate header (metadata: ${PRM_URL}).`
          : "This endpoint requires authorization even when a key is supplied. Complete the " +
            `OAuth flow advertised in the WWW-Authenticate header (metadata: ${PRM_URL}), or ` +
            "use /mcp to keep using the key you sent.",
      },
      id: null,
    }, { "WWW-Authenticate": `Bearer resource_metadata="${PRM_URL}"` });
    return;
  }

  // JWT path (spec §A3): a Bearer that is structurally an access token is
  // verified and exchanged for the grant's API key BEFORE dispatch. Failure
  // semantics split on purpose: token problems are transport-level 401 with a
  // challenge (clients auto-refresh on it; an isError would break that loop),
  // backend problems are 503 (the token may be fine — don't make the client
  // burn its refresh flow on our outage). Bare API keys never enter this path.
  let effectiveKey = apiKey;
  if (OAUTH_ENABLED && apiKey !== undefined && looksLikeAccessToken(apiKey)) {
    try {
      effectiveKey = await apiKeyFromAccessToken(RS_CONFIG, apiKey);
    } catch (e) {
      if (e instanceof TokenInvalidError) {
        logEvent("oauth_reject", { reason: e.message }, `access token rejected: ${e.message}`);
        // The specific reason goes in the body too, not only in the challenge:
        // an agent (and the human reading its transcript) sees the JSON-RPC
        // error, and "invalid or expired" alone cannot distinguish a clock
        // skew from a trailing slash in the resource URL from a revoked
        // grant — three problems with three unrelated fixes. This is the
        // failure mode that made the earlier field reports unactionable.
        json(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: `Access token rejected: ${e.message}` },
          id: null,
        }, {
          "WWW-Authenticate":
            `Bearer error="invalid_token", error_description="${headerSafe(e.message)}", ` +
            `resource_metadata="${PRM_URL}"`,
        });
        return;
      }
      const msg = e instanceof OAuthBackendError ? e.message : (e as Error).message;
      logEvent("oauth_backend_error", { reason: msg }, `oauth backend unavailable: ${msg}`);
      json(res, 503, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            `Could not verify this access token because an Octen-side dependency is unavailable: ${msg}. ` +
            "The token itself may be fine — retry shortly rather than re-authorizing.",
        },
        id: null,
      }, { "Retry-After": "5" });
      return;
    }
  }

  // Per-connection tool selection. Validated here rather than inside the
  // server so a bad name is one clear 400 instead of a connection that comes
  // up looking healthy and is missing a tool.
  const selection = parseToolSelection(queryOf(req));
  if ("error" in selection) {
    json(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32602, message: selection.error },
      id: null,
    });
    return;
  }

  logEvent("http_request", {
    tools: selection.tools ? selection.tools.join(",") : undefined,
    key_prefix: apiKey ? keyFingerprint(apiKey) : undefined,
    ua: (req.headers["user-agent"] ?? "").toString().slice(0, 60) || undefined,
  },
    `http POST /mcp key=${apiKey ? keyFingerprint(apiKey) : "(none)"} ` +
    `ua=${(req.headers["user-agent"] ?? "-").toString().slice(0, 60)}`);

  // A fresh pair per request: request IDs cannot collide across concurrent
  // POSTs, and the closure pins this request's key to this request's calls.
  const server = createOctenServer({ getApiKey: () => effectiveKey, transport: "http", tools: selection.tools });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  let parsed: unknown;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES, bodyCharge);
    parsed = raw === "" ? undefined : JSON.parse(raw);
  } catch (e) {
    if (e instanceof BodyBudgetExceededError) {
      // Capacity, not a bad request: the same call will work shortly, and the
      // caller has nothing to fix. Drained like the 413 below so the answer
      // survives the close.
      logEvent("body_budget_exceeded", { inflight: inflightBodyBytes, budget: MAX_INFLIGHT_BODY_BYTES },
        `refused: in-flight bodies at ${inflightBodyBytes} of ${MAX_INFLIGHT_BODY_BYTES} bytes`);
      res.writeHead(503, { "Content-Type": "application/json", Connection: "close", "Retry-After": "1" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Server is at capacity for request bodies of this size; retry shortly. " +
            "(Concurrency ceiling: OCTEN_MCP_MAX_INFLIGHT_BODY.)",
        },
        id: null,
      }));
      req.resume();
      const cut = setTimeout(() => req.destroy(), BODY_DRAIN_MS);
      req.once("end", () => clearTimeout(cut));
      req.once("close", () => clearTimeout(cut));
      return;
    }
    if (e instanceof BodyTooLargeError) {
      // `Connection: close` — the body is still arriving, so this socket
      // cannot carry another request.
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Request body exceeds ${MAX_BODY_BYTES} bytes ` +
          `(OCTEN_MCP_MAX_BODY). Sending an image as base64 needs this raised.` },
        id: null,
      }));

      // Then keep reading — and discarding — until the client stops.
      //
      // Hanging up here instead does not work, and the reason is TCP rather
      // than Node: closing while the peer is mid-send sends a reset, and a
      // reset discards whatever response bytes were still in flight. Measured
      // both ways against this server: a client that stopped after 128 KB
      // received the 413, while a client that kept sending received nothing at
      // all — only ECONNRESET. That is precisely the unexplained failure this
      // cap exists to replace, so the cap would have been self-defeating.
      //
      // Discarding costs no memory (readBody stops accumulating the moment it
      // rejects), and the timer bounds how long a client that ignores the 413
      // can keep us absorbing its bytes.
      const drainStarted = Date.now();
      req.resume();
      const cutoff = setTimeout(() => {
        logEvent("body_drain_cutoff", { limit: MAX_BODY_BYTES, budget_ms: BODY_DRAIN_MS },
          `oversized body still arriving after ${BODY_DRAIN_MS}ms; closing`);
        req.destroy();
      }, BODY_DRAIN_MS);
      // `end` and `close` can both fire; the guard keeps this to one line.
      let logged = false;
      const stopDraining = () => {
        clearTimeout(cutoff);
        if (logged) return;
        logged = true;
        logEvent("body_drained", { limit: MAX_BODY_BYTES, drain_ms: Date.now() - drainStarted },
          `413 sent and the rest of the body drained in ${Date.now() - drainStarted}ms`);
      };
      req.once("end", stopDraining);
      req.once("close", stopDraining);
      return;
    }
    json(res, 400, {
      jsonrpc: "2.0",
      // -32700 is the JSON-RPC parse error; naming the parser's own complaint
      // is what turns "it just fails" into a fixable report.
      error: { code: -32700, message: `Could not parse the request body as JSON: ${(e as Error).message}` },
      id: null,
    });
    return;
  }

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    logEvent("http_error", { msg: (e as Error).message }, `http transport error: ${(e as Error).message}`);
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: "2.0",
        // The reason travels with the response. A bare "Internal server error"
        // leaves the caller unable to tell our bug from their malformed frame,
        // and leaves us with a report that contains nothing to search for.
        error: { code: -32603, message: `MCP transport error: ${(e as Error).message}` },
        id: null,
      });
    }
  }
}

function shutdown(signal: string): void {
  if (draining) {
    // Second signal: the operator (or a local ctrl-c) wants out now.
    process.exit(130);
  }
  draining = true;
  // The budget is logged, not just used: it is the number that decides whether
  // this pod exits on its own or gets SIGKILLed, it has to stay under the
  // pod's terminationGracePeriodSeconds, and an operator comparing the two has
  // no other way to see what this process actually resolved the env var to.
  logEvent("drain_start", { signal, in_flight: inFlight, budget_ms: DRAIN_TIMEOUT_MS },
    `drain started on ${signal}, ${inFlight} request(s) in flight, budget ${DRAIN_TIMEOUT_MS}ms`);
  // Keep LISTENING through the drain. Readiness failing (healthz 503) is what
  // takes this pod out of rotation; closing the listener here instead would
  // RST any client that races endpoint removal, where the draining gate above
  // answers 503 + Retry-After and lets it fail over cleanly. The listener is
  // torn down by process exit.
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const timer = setInterval(() => {
    if (inFlight === 0 || Date.now() > deadline) {
      const forced = inFlight > 0;
      logEvent("drain_complete", { in_flight: inFlight, forced },
        `drain complete, in_flight=${inFlight}${forced ? " (deadline hit)" : ""}`);
      clearInterval(timer);
      process.exit(forced ? 1 : 0);
    }
  }, 200);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

httpServer.listen(PORT, () => {
  const actual = (httpServer.address() as { port: number }).port;
  // stderr, like every other diagnostic — stdout stays silent even though this
  // transport doesn't use it, so log-scraping setups behave the same for both.
  console.error(`[octen-mcp] v${VERSION} HTTP transport listening on :${actual}/mcp`);
});
