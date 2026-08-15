/**
 * Shared HTTP layer for every Octen API call.
 *
 * Node's built-in `fetch` uses undici's *global* dispatcher, whose defaults are
 * tuned for short-lived scripts, not for a long-running MCP server that fires a
 * request every few minutes:
 *
 *  - `keepAliveTimeout` is 4s, so a socket idle longer than that is closed and
 *    the next tool call pays a full TCP + TLS handshake again. Measured against
 *    api.octen.ai, four calls spanning 16s of idle: 785ms per post-idle call
 *    over 3 connections, against 272ms over 1 once the socket is held. The
 *    handshake was ~515ms, about 65% of a call whose server-side latency is
 *    ~1ms. Agent tool calls are almost always more than 4s apart, so nearly
 *    every call paid it.
 *  - the proxy environment (`HTTPS_PROXY` & co.) is ignored entirely, unlike
 *    curl / most SDKs, so behind a corporate proxy the server cannot reach the
 *    API at all while every other tool on the machine can.
 *  - there is no connect timeout the caller can reason about, and a stalled
 *    request hangs on undici's 300s `headersTimeout` — which the agent sees as
 *    a tool call that never returns rather than as an error.
 *
 * On top of the dispatcher this module centralises what every call site was
 * doing by hand (and getting wrong): a default timeout, retrying connection
 * failures, and — most importantly — reporting `err.cause`. `fetch` rejects
 * with a bare `TypeError: fetch failed`; the actual reason (ECONNRESET,
 * UND_ERR_CONNECT_TIMEOUT, ENOTFOUND, …) only exists on `err.cause.code`, and
 * dropping it is what made support tickets undiagnosable.
 */
import { Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** Read a positive-integer env override, falling back when unset/invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const FALSEY = ["false", "0", "off", "no"];

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v !== "" && !FALSEY.includes(v);
}

/** Same, for flags that are on unless explicitly switched off. */
function envFlagDefaultOn(name: string): boolean {
  return !FALSEY.includes((process.env[name] ?? "").trim().toLowerCase());
}

export const DEBUG = envFlag("OCTEN_MCP_DEBUG");

/**
 * Debug output MUST go to stderr — stdout carries the MCP protocol framing and
 * anything written there corrupts the session.
 *
 * Every line is stamped with a wall-clock UTC timestamp. That is not cosmetic:
 * diagnosing a report like the one that prompted this release means aligning
 * our log against the client's own session log and against server-side receive
 * times, and a duration without an absolute time cannot be aligned with
 * anything.
 */
export function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[octen-mcp ${new Date().toISOString()}] ${msg}\n`);
}

/**
 * Connection-phase tracing.
 *
 * The single most useful thing to know about a slow or failed call is whether
 * it re-established a connection, and where that establishment died. undici
 * publishes this on diagnostics channels; without it a debug line can say a
 * call took 900ms but not that 640ms of it was a TLS handshake we should not
 * have needed.
 *
 * Subscriptions are installed only under OCTEN_MCP_DEBUG so the normal path
 * carries no cost.
 */
/** Per-call connection bookkeeping. See {@link connectTrace}. */
interface CallTrace {
  attempts: number;
  established: number;
  startedAt: number;
}

/**
 * Connection state is tracked per call, not per module.
 *
 * The obvious implementation — module-level counters, snapshotted before the
 * request and diffed after — is wrong here, and wrong in a way that only shows
 * up under the conditions this tracing exists to diagnose. Tool calls run
 * concurrently (the MCP SDK dispatches each without awaiting the last), so a
 * connection opened for request B lands between request A's snapshot and A's
 * check, and A reports B's connection as its own. Observed while testing:
 * `status=200 socket=connect-failed` on a call that reused a healthy socket,
 * and a 500ms handshake logged as 11ms because a second connect overwrote the
 * shared start time.
 *
 * `AsyncLocalStorage` fixes the attribution: undici raises the connect
 * diagnostics inside the async context of whichever request triggered the
 * connection, so each call sees only its own. Verified with three concurrent
 * requests whose `connected` events arrive out of order — each is still
 * credited to the right caller, and a fourth call reusing the socket correctly
 * records no connection attempt at all.
 */
const connectTrace = new AsyncLocalStorage<CallTrace>();

/**
 * How this request got its socket. Reported on success *and* failure, because
 * the same error code means different things either side of it: a reused socket
 * that fails is a stale keep-alive connection (ours to fix), a fresh connect
 * that fails is the network refusing us (not ours). Needs both counters — a
 * failed connect never increments `established`, so reading that alone reports
 * a connection that was never made as "reused".
 */
function socketKind(): string {
  const t = connectTrace.getStore();
  if (!t || t.attempts === 0) return "reused";
  return t.established > 0 ? "new" : "connect-failed";
}

/** Monotonic label for connections, purely so log lines can be told apart. */
let connectSeq = 0;

if (DEBUG) {
  const dc = await import("node:diagnostics_channel");
  dc.channel("undici:client:beforeConnect").subscribe(() => {
    const t = connectTrace.getStore();
    if (t) { t.attempts++; t.startedAt = Date.now(); }
  });
  dc.channel("undici:client:connected").subscribe((evt: any) => {
    const t = connectTrace.getStore();
    if (t) t.established++;
    const host = evt?.connectParams?.host ?? "?";
    const s = evt?.socket;
    debug(
      `connect #${++connectSeq} established to ${host}` +
      (t?.startedAt ? ` in ${Date.now() - t.startedAt}ms` : "") +
      // The peer address is the field that matters most when the origin is
      // anycast: api.octen.ai resolves to whichever edge is nearest the
      // client, so "which edge did this machine actually reach" is not
      // answerable from the hostname, and an edge-local problem is invisible
      // without it.
      (s?.remoteAddress ? ` peer=${s.remoteAddress}:${s.remotePort}` : "") +
      (s?.getProtocol?.() ? ` tls=${s.getProtocol()}` : "") +
      (s?.alpnProtocol ? ` alpn=${s.alpnProtocol}` : "")
    );
  });
  dc.channel("undici:client:connectError").subscribe((evt: any) => {
    const t = connectTrace.getStore();
    const err = evt?.error;
    const p = evt?.connectParams;
    debug(
      `connect FAILED` +
      (t?.startedAt ? ` after ${Date.now() - t.startedAt}ms` : "") +
      ` code=${err?.code ?? err?.name ?? "?"} ` +
      `host=${p?.hostname ?? "?"}` +
      (err?.address ? ` peer=${err.address}${err.port ? ":" + err.port : ""}` : "") +
      ` ${err?.message ?? ""}`
    );
  });
}

const PROXY_ENV = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
const proxyConfigured = PROXY_ENV.some((k) => (process.env[k] ?? "").trim() !== "");

const agentOptions: Agent.Options = {
  // Hold idle sockets long enough to span the gap between agent tool calls, but
  // strictly below what the origin will tolerate.
  //
  // 60s is measured, not chosen: against api.octen.ai a socket idle for 30s and
  // 60s is still usable, while at 90s the origin has already closed it and the
  // next call re-handshakes (816ms vs 268ms). The edge is Azure Front Door,
  // whose documented client idle timeout is 90s, and it does not advertise a
  // `Keep-Alive` hint we could follow instead — so the ceiling has to be set
  // here.
  //
  // Overshooting is not harmless: every idle gap past the origin's threshold
  // leaves us dispatching onto a socket the peer has already closed, and the
  // resulting ECONNRESET is exactly the case a retry cannot distinguish from a
  // mid-flight failure. Point `OCTEN_API_URL` at a different origin and this is
  // the knob to re-measure.
  keepAliveTimeout: envInt("OCTEN_KEEP_ALIVE_MS", 60_000),
  keepAliveMaxTimeout: envInt("OCTEN_KEEP_ALIVE_MAX_MS", 600_000),
  connectTimeout: envInt("OCTEN_CONNECT_TIMEOUT_MS", 10_000),
  // HTTP/2 measured no better than 1.1 for this workload (one request in
  // flight at a time) and is not reliable through every CONNECT proxy, so it
  // stays opt-in.
  allowH2: envFlag("OCTEN_HTTP2"),
};

/**
 * curl accepts a proxy without a scheme (`proxy.corp:8080`) and so do most
 * corporate setups' muscle memory; undici requires one and throws without it.
 */
function normalizeProxy(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  return /^[a-z0-9+.-]+:\/\//i.test(v) ? v : `http://${v}`;
}

/**
 * `EnvHttpProxyAgent` honours HTTP_PROXY / HTTPS_PROXY / NO_PROXY the way the
 * rest of the ecosystem does; the plain `Agent` avoids its per-request proxy
 * lookup when no proxy is configured.
 *
 * Construction is guarded because it happens at module load: undici rejects a
 * proxy URL it cannot parse — a `socks5://` proxy, say — by throwing
 * synchronously, and an uncaught throw here would take the whole server down at
 * startup, killing all six tools over a variable that 0.3.7 simply ignored. A
 * misconfigured proxy must degrade to "this one feature is unavailable", never
 * to "the server does not start".
 *
 * undici prints an "experimental" warning for the proxy agent on stderr — which
 * only fires when a proxy is actually configured, and reads as a useful "proxy
 * path is engaged" signal there. stderr is safe: stdout carries MCP framing.
 */
function buildDispatcher(): Dispatcher {
  if (!proxyConfigured) return new Agent(agentOptions);
  try {
    return new EnvHttpProxyAgent({
      ...agentOptions,
      httpProxy: normalizeProxy(process.env.http_proxy ?? process.env.HTTP_PROXY),
      httpsProxy: normalizeProxy(process.env.https_proxy ?? process.env.HTTPS_PROXY),
      noProxy: process.env.no_proxy ?? process.env.NO_PROXY,
    });
  } catch (e) {
    process.stderr.write(
      `[octen-mcp] proxy environment is set but unusable (${(e as Error).message}); ` +
      `continuing with direct connections. Supported: http:// and https:// proxies.\n`
    );
    return new Agent(agentOptions);
  }
}

const dispatcher: Dispatcher = buildDispatcher();

debug(
  `dispatcher=${proxyConfigured ? "EnvHttpProxyAgent" : "Agent"} ` +
  `keepAlive=${agentOptions.keepAliveTimeout}ms connect=${agentOptions.connectTimeout}ms ` +
  `h2=${agentOptions.allowH2}`
);

/**
 * Failures worth one retry.
 *
 * The first group cannot have reached the server — the connection was never
 * established — so retrying them is unambiguously safe.
 *
 * The second group is ambiguous, and the distinction matters enough to state
 * plainly: undici raises `ECONNRESET` / `UND_ERR_SOCKET` whenever the socket
 * errors, whether that happened before the request was written or after the
 * server had already begun acting on it. The case we specifically need to
 * cover is the keep-alive race — the origin reaping an idle socket exactly as
 * we dispatch on it, which raising `keepAliveTimeout` to 240s makes *more*
 * likely, not less — and that case is indistinguishable from a mid-flight
 * reset by error code alone.
 *
 * We retry them anyway. These endpoints are read-only queries, so a duplicate
 * costs quota rather than correctness, and the availability win is large (in
 * the field report that prompted this, five of five manual retries succeeded).
 * But it is a duplicate *billed* call, and for `broad_search` that means its
 * whole server-side fan-out runs twice. Set `OCTEN_RETRY=off` to disable.
 */
const RETRY_BACKOFF_MS = 250;
/** Below this much remaining budget, a second connection attempt is pointless. */
const MIN_RETRY_BUDGET_MS = 1_000;

const RETRYABLE_PRE_SEND = ["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"];
const RETRYABLE_AMBIGUOUS = ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"];
const RETRYABLE_CODES = new Set(
  envFlagDefaultOn("OCTEN_RETRY")
    ? [...RETRYABLE_PRE_SEND, ...RETRYABLE_AMBIGUOUS]
    : []
);

/** Pull the useful diagnosis out of a `fetch` rejection. */
function describeError(e: unknown): { code: string; detail: string } {
  const err = e as (Error & { cause?: any }) | undefined;
  const cause = err?.cause;
  // `AggregateError` (happy-eyeballs: every address failed) hides the real
  // codes one level further down.
  const subs: any[] = Array.isArray(cause?.errors) ? cause.errors : [];
  const sub = subs[0];
  const code: string = cause?.code ?? sub?.code ?? err?.name ?? "UNKNOWN";
  const parts = [`code=${code}`];
  // Happy Eyeballs tries every address; when IPv6 and IPv4 fail differently,
  // reporting only the first hides half the diagnosis — and "IPv6 blackholed,
  // IPv4 fine" is exactly the shape that gets misread as a server problem.
  if (subs.length > 1) {
    const others = [...new Set(subs.slice(1).map((e) => e?.code).filter(Boolean))];
    if (others.length) parts.push(`also=${others.join(",")}`);
  }
  const message = cause?.message ?? err?.message;
  if (message) parts.push(`cause=${message}`);
  const address = cause?.address ?? sub?.address;
  if (address) parts.push(`address=${address}${cause?.port ?? sub?.port ? `:${cause?.port ?? sub?.port}` : ""}`);
  if (proxyConfigured) parts.push("proxy=env");
  return { code, detail: parts.join(" ") };
}

export interface PostJsonOptions {
  /** API path, e.g. `/search`. */
  path: string;
  /** Request body, serialised as JSON. */
  body: unknown;
  /** Human-readable API name used in error messages, e.g. `Octen Search`. */
  label: string;
  /** Caller-supplied timeout in seconds; falls back to `defaultTimeoutSec`. */
  timeoutSec?: number;
  /** Applied when the caller passes no timeout. */
  defaultTimeoutSec: number;
  /**
   * Whether raising `timeout` would actually buy more headroom. False when the
   * effective value already sits at the schema maximum — `broad_search`
   * defaults to 60s and cannot go higher — so we don't advise an agent to turn
   * a knob that is already at its stop.
   */
  canRaiseTimeout?: boolean;
}

/**
 * Classify a `resp.json()` rejection into a message that names what actually
 * happened. Body reads can fail three distinct ways, and two of them are not
 * parse errors:
 *
 *  - the shared deadline aborts a stalled read (`TimeoutError`/`AbortError`);
 *  - the connection dies mid-body — RST, FIN, or a Content-Length the origin
 *    never honored. undici surfaces these as a bare `TypeError: terminated`
 *    with the diagnosis on `cause.code` (ECONNRESET, UND_ERR_SOCKET,
 *    UND_ERR_RES_CONTENT_LENGTH_MISMATCH), exactly the `err.cause` pattern
 *    this module exists to unwrap;
 *  - the bytes are genuinely not JSON (`SyntaxError`).
 *
 * Centralised because the first fix for this lived as five identical
 * copy-pasted catch blocks, and its own review found the second bullet missing
 * from every one of them.
 *
 * No "raise `timeout`" advice on any branch: a stalled or torn-down stream is
 * indistinguishable from a slow one at this point, so the advice would be a
 * guess — the codes and correlation id are the actionable part.
 */
export function bodyReadFailure(label: string, resp: Response, e: unknown): string {
  // No id in these messages, verified rather than assumed: the only id worth
  // putting in front of a user is one the other side can look up, and for a
  // body-read failure nothing qualifies today. The client's correlation UUID
  // is not recorded by the gateway; the edge's x-azure-ref is stamped on the
  // response but edge access logging is not enabled, so Octen cannot search it
  // either (checked 2026-08-15: no AFD diagnostic settings, zero hits in
  // ingress and gateway logs). An id that support cannot find recreates the
  // mutual-unaccountability dead-end the 0.4.0 incident was about. Both ids
  // remain in the OCTEN_MCP_DEBUG trace; re-add x-azure-ref here once edge
  // logging is on.
  const suffix = "";
  const err = e as (Error & { cause?: { code?: string } }) | undefined;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `${label} timed out while reading the response body (HTTP ${resp.status})${suffix}`;
  }
  const code = err?.cause?.code;
  if (code) {
    return `${label}: connection lost while reading the response body ` +
      `(HTTP ${resp.status}, code=${code})${suffix}`;
  }
  return `${label} returned non-JSON (HTTP ${resp.status})${suffix}`;
}

/** Thrown by {@link postJson}; `message` is already formatted for the LLM. */
export class OctenHttpError extends Error {}

const API_BASE = process.env.OCTEN_API_URL ?? "https://api.octen.ai";

/**
 * POST JSON to the Octen API over the tuned dispatcher.
 *
 * Resolves with the raw `Response` (callers still read the envelope themselves,
 * since Octen returns `{code, msg}` bodies on error alongside non-2xx status).
 * Rejects with an {@link OctenHttpError} whose message names the failure code
 * and carries the correlation id.
 */
export function postJson(opts: PostJsonOptions): Promise<Response> {
  // One trace context per logical call, retry included.
  return connectTrace.run({ attempts: 0, established: 0, startedAt: 0 }, () => postJsonInner(opts));
}

async function postJsonInner(opts: PostJsonOptions): Promise<Response> {
  const { path, body, label, timeoutSec, defaultTimeoutSec, canRaiseTimeout = true } = opts;
  const apiKey = process.env.OCTEN_API_KEY!;
  const effectiveTimeoutSec = timeoutSec ?? defaultTimeoutSec;
  // One correlation id for the whole logical call, retry included, so a support
  // ticket maps to every attempt in the server logs.
  const requestId = randomUUID();
  const payload = JSON.stringify(body);

  let lastDetail = "";
  // ONE deadline for the whole call, created before the loop so the retry
  // draws down the same budget rather than starting a fresh one. Building it
  // per attempt would let a 30s timeout run for 60s — reintroducing, at a
  // higher threshold, the "tool call that never returns" this module exists to
  // prevent.
  const deadline = AbortSignal.timeout(effectiveTimeoutSec * 1000);
  const callStarted = Date.now();

  // Two attempts: the second exists for the keep-alive race, where the origin
  // closes an idle socket at the moment we dispatch on it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "x-request-id": requestId,
        },
        body: payload,
        signal: deadline,
        // @ts-expect-error — `dispatcher` is an undici extension to RequestInit
        // that Node honours but the DOM `fetch` types do not declare.
        dispatcher,
      });
      // Guarded rather than left to `debug()` to discard: the message reads
      // response headers, and building it on every request would be wasted work
      // whenever tracing is off.
      if (DEBUG) {
        // Azure Front Door stamps every response that reaches the edge. Unlike
        // our own correlation id, this one already exists in Octen's
        // infrastructure logs, so it is the handle that works today.
        const edgeRef = resp.headers?.get?.("x-azure-ref");
        debug(
          `${path} attempt=${attempt} status=${resp.status} ` +
          `elapsed=${Date.now() - started}ms ` +
          // Whether this call paid for a handshake is the difference between
          // "the service is slow" and "we threw the connection away".
          `socket=${socketKind()} ` +
          `request_id=${requestId}` +
          (edgeRef ? ` x-azure-ref=${edgeRef}` : "")
        );
      }
      return resp;
    } catch (e) {
      const elapsed = Date.now() - started;
      const err = e as Error;

      if (err.name === "TimeoutError" || err.name === "AbortError") {
        debug(
          `${path} attempt=${attempt} TIMEOUT after ${elapsed}ms ` +
          `socket=${socketKind()} request_id=${requestId}`
        );
        throw new OctenHttpError(
          // No id here: nothing reached the server, so there is nothing the
          // other side could look up — and a client-generated id labelled
          // request_id reads like one they could.
          `${label} timed out after ${effectiveTimeoutSec}s` +
          // Deliberately not phrased as "the client default": for `extract` the
          // ceiling is derived from the caller's own per-URL `timeout`, so
          // calling it a default would be false. Raising `timeout` raises the
          // ceiling in both cases, which is the actionable part.
          (timeoutSec === undefined && canRaiseTimeout
            ? " — pass `timeout` to raise this ceiling."
            : "")
        );
      }

      const { code, detail } = describeError(e);
      lastDetail = detail;
      debug(
        // `socket=` on the failure path too, not just on success: a reused
        // socket that fails is a stale keep-alive connection, a new one that
        // fails is the network refusing us. Same error code, different owner.
        `${path} attempt=${attempt} FAILED after ${elapsed}ms ` +
        `socket=${socketKind()} ` +
        `${detail} request_id=${requestId}`
      );

      if (attempt === 1 && RETRYABLE_CODES.has(code)) {
        // Only retry if the shared deadline can still accommodate one. Sleeping
        // into an already-expired budget would abort the second attempt
        // instantly and report a generic timeout in place of the specific
        // network diagnosis we already have — strictly worse information about
        // the same failure. `timeout` may be as low as 1s.
        const remaining = effectiveTimeoutSec * 1000 - (Date.now() - callStarted);
        if (remaining > RETRY_BACKOFF_MS + MIN_RETRY_BUDGET_MS) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        debug(`${path} not retrying: only ${remaining}ms of budget left request_id=${requestId}`);
      }

      throw new OctenHttpError(
        `Network error calling ${label}: ${detail}` +
        (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ECONNREFUSED"
          ? proxyConfigured
            ? " — a proxy is configured in the environment and was used; check it allows api.octen.ai."
            : " — could not establish a connection. If this machine requires an HTTP proxy, set HTTPS_PROXY."
          : "")
      );
    }
  }

  /* c8 ignore next */
  throw new OctenHttpError(`Network error calling ${label}: ${lastDetail}`);
}
