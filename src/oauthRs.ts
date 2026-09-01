/**
 * OAuth resource-server side: verify an access token, exchange its grant for
 * an API key.
 *
 * The token contract (read from the authorization server's implementation,
 * not assumed): a fosite-issued self-contained RS256 JWT with `iss`, `aud`
 * (single value — the resource URL), `exp`/`iat`, `scp` (fosite's convention:
 * an ARRAY, not a `scope` string), `sub`, and `grant_id` — deliberately no
 * key identifier of any kind, so a leaked token can only ever be exchanged
 * for the one key its grant was bound to, via the authenticated internal
 * resolve endpoint.
 *
 * Verification is plain node:crypto over the JWKS — RS256 signature checks
 * need no JOSE dependency, and this repo keeps its runtime dependency list
 * deliberately short. Key rotation is handled the standard way: unknown `kid`
 * triggers one JWKS refetch before rejecting.
 *
 * Failure taxonomy matters more than usual here (spec §A3.5): a token problem
 * is answered HTTP 401 + WWW-Authenticate so clients auto-refresh — burying
 * it in a tool-result isError breaks the refresh loop and degrades to
 * "mysterious hourly failures". An *infrastructure* problem (JWKS or resolve
 * endpoint unreachable) is 503: the token may be fine, and a client that
 * burns its refresh flow on our outage ends up logged out for nothing.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { fetch as undiciFetch } from "undici";

import { logEvent, dispatcher, envInt } from "./http.js";

/** Thrown for token problems → transport 401 (client should refresh/re-auth). */
export class TokenInvalidError extends Error {}
/** Thrown for backend problems → transport 503 (token may be fine; retry). */
export class OAuthBackendError extends Error {}

/**
 * Name what actually failed, for a `fetch` rejection.
 *
 * `fetch` rejects with a bare `TypeError: fetch failed`; the reason lives on
 * `err.cause.code`. Passing the outer message through produces "JWKS fetch
 * failed: fetch failed", which tells a reader nothing they did not already
 * know — the same dead end that made the 0.3.7 field reports unactionable, and
 * this time on a path where the answer reaches the user as a 503.
 *
 * Deliberately code-and-reason only, no URL or address: the resolve endpoint
 * is an in-cluster address and these messages are returned over the public
 * internet. `timeoutMs` is stated because "did it refuse or did it hang" is
 * the first question, and the two need opposite fixes.
 */
function fetchFailureReason(e: unknown, timeoutMs: number): string {
  const err = e as (Error & { cause?: { code?: string; message?: string; errors?: unknown[] } }) | undefined;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `no response within ${timeoutMs}ms`;
  }
  // A body read fails these two ways as well, and they are not the same fault:
  // non-JSON means something answered and it was the wrong thing (a proxy
  // error page, most often), while a socket code means the answer was cut off.
  if (err?.name === "SyntaxError") return "the body was not JSON";
  const cause = err?.cause;
  const subs = Array.isArray(cause?.errors) ? (cause.errors as { code?: string }[]) : [];
  const code = cause?.code ?? subs[0]?.code ?? err?.name;
  const detail = cause?.message;
  if (code && detail && detail !== code) return `${code} (${detail})`;
  return code ?? detail ?? "unknown transport failure";
}

const CLOCK_TOLERANCE_SEC = 60;
const JWKS_TTL_MS = 5 * 60 * 1000;
/**
 * Floor between two unknown-`kid` refetches. The refetch exists so a key
 * published mid-rotation is picked up without waiting out the TTL, and that
 * only needs to happen once per rotation — but the trigger is an *unverified*
 * token header, so without a floor each request carrying a made-up `kid`
 * becomes one JWKS request to the authorization server. Measured before this
 * cooldown: 10 unauthenticated requests produced 11 JWKS fetches, turning our
 * own AS into the amplification target. 10s keeps rotation effectively
 * immediate while capping the reachable rate at one fetch per window.
 *
 * The cost of the window is bounded and one-sided: a key published *and* used
 * within it is rejected until the window passes, so a rotation is delayed by
 * at most this long — never broken. Tunable only so the suite can exercise
 * both sides of it without sleeping ten seconds; lowering it in production
 * widens the amplification factor back out by the same ratio.
 */
const JWKS_REFETCH_COOLDOWN_MS = envInt("OCTEN_JWKS_REFETCH_COOLDOWN_MS", 10_000, 0);
const JWKS_TIMEOUT_MS = 5_000;
/** Tighter than JWKS: this one runs on every OAuth tool call the cache misses. */
const RESOLVE_TIMEOUT_MS = 3_000;
/**
 * How long a resolved grant→key mapping is reused before going back to the
 * authorization server.
 *
 * This is the revocation-propagation window, and it is a deliberate trade, so
 * it is configuration rather than a buried constant: measured on pre, a token
 * revoked at t=0 still worked at t=45s and was refused at t=60s.
 *
 * Not zero, because resolving on every call would put a synchronous dependency
 * on the dashboard in front of every single tool call — strictly more fragile
 * than the window is harmful. And the window is an *increment*, not the whole
 * exposure: an access token's own lifetime is ~3600s, so revocation already
 * takes effect on that scale; this only adds to the case where someone revokes
 * deliberately and expects it to bite immediately. Lower it if that case
 * matters more than the extra load on the resolve endpoint.
 */
const RESOLVE_TTL_MS = envInt("OCTEN_OAUTH_RESOLVE_CACHE_TTL_MS", 60 * 1000, 0);
const RESOLVE_CACHE_MAX = 10_000;

/**
 * `kid` is attacker-controlled: it arrives inside an unverified token header
 * and is read before any signature check. It reaches a log line and — via the
 * caller's `WWW-Authenticate` — an HTTP response header, so anything outside
 * printable ASCII must not survive. A CRLF here previously reached
 * `res.writeHead`, which rejects it with `ERR_INVALID_CHAR` from inside the
 * request handler: one unauthenticated request, process gone.
 *
 * Sanitised rather than dropped, because "which key id did it claim" is the
 * one fact that makes a rotation bug diagnosable.
 */
function safeText(v: unknown, max = 64): string {
  const clean = String(v).replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "").slice(0, max);
  return clean === "" ? "(empty)" : clean;
}

export interface OAuthRsConfig {
  /** AS base URL — also the expected `iss`, byte-for-byte. */
  authorizationServer: string;
  /** This deployment's resource URL — the expected `aud`, byte-for-byte. */
  resource: string;
  /** Internal resolve endpoint; absent = JWT path disabled (bare keys only). */
  resolveUrl?: string;
  /** Shared secret for the resolve endpoint's X-Octen-Service-Token header. */
  resolveToken?: string;
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * Cheap structural test, run before any crypto: three dot-separated segments
 * whose first segment decodes to a JSON object carrying a string `alg`. A bare
 * Octen API key cannot match, so the two credential forms sharing one
 * `Authorization` header do not collide.
 *
 * Deliberately shape-only. Requiring `alg === "RS256"` and a `kid` here — the
 * first version of this — routed every JWT this server cannot verify into the
 * *API key* path instead: measured, a token with `alg: none`, one signed
 * HS256, and one missing `kid` were each forwarded verbatim to the upstream as
 * an API key and answered HTTP 200 with an "Invalid API Key" tool error. Two
 * things wrong with that. A client holding a bearer token needs 401 + a
 * challenge to know it should re-authorize; a tool-level error reads as a
 * backend fault it should retry, so it never does. And it sprays a whole
 * bearer token — possibly one minted for some other audience — at our API
 * gateway, where it lands in request logs as if it were a key.
 *
 * So: anything token-shaped is judged as a token, and the specific reason
 * (unsupported algorithm, no kid, bad signature, expired) comes back as a 401.
 * Anything else is a key, and a wrong key still earns the tool-level "check
 * your key" error — which is the right answer for that case.
 */
export function looksLikeAccessToken(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = b64urlJson(parts[0]);
    return typeof header === "object" && header !== null && typeof header.alg === "string";
  } catch {
    return false;
  }
}

// ---- JWKS ------------------------------------------------------------------

interface Jwk { kid: string; kty: string; n?: string; e?: string; [k: string]: unknown }

let jwksKeys = new Map<string, KeyObject>();
let jwksFetchedAt = 0;
/** Start of the last refetch *attempt* — failures count, or a down AS invites hammering. */
let jwksAttemptedAt = 0;
/** In-flight fetch, shared so a burst of concurrent misses makes one request. */
let jwksInFlight: Promise<void> | undefined;

/** One JWKS fetch at a time, however many callers miss the cache at once. */
function fetchJwks(cfg: OAuthRsConfig): Promise<void> {
  if (jwksInFlight) return jwksInFlight;
  jwksAttemptedAt = Date.now();
  jwksInFlight = fetchJwksOnce(cfg).finally(() => { jwksInFlight = undefined; });
  return jwksInFlight;
}

async function fetchJwksOnce(cfg: OAuthRsConfig): Promise<void> {
  // Path is the AS implementation's fixed convention (metadata builds
  // jwks_uri as issuer + this path), so no discovery round-trip is needed.
  const url = `${cfg.authorizationServer}/api/oauth/jwks`;
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    // Same dispatcher as every other outbound call: proxy environment honoured,
    // sockets held between calls. Without it this path silently uses undici's
    // global default and cannot reach the AS from behind a proxy.
    res = await undiciFetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), dispatcher });
  } catch (e) {
    throw new OAuthBackendError(
      `could not reach the authorization server's JWKS endpoint: ${fetchFailureReason(e, JWKS_TIMEOUT_MS)}`);
  }
  if (res.status !== 200) {
    throw new OAuthBackendError(`the authorization server's JWKS endpoint answered HTTP ${res.status}`);
  }
  let doc: { keys?: Jwk[] };
  try {
    doc = (await res.json()) as { keys?: Jwk[] };
  } catch (e) {
    throw new OAuthBackendError(
      `the authorization server's JWKS response could not be read: ${fetchFailureReason(e, JWKS_TIMEOUT_MS)}`);
  }
  const next = new Map<string, KeyObject>();
  for (const k of doc.keys ?? []) {
    if (k.kty !== "RSA" || !k.kid) continue;
    try {
      next.set(k.kid, createPublicKey({ key: k as never, format: "jwk" }));
    } catch {
      /* skip malformed keys; a usable set may remain */
    }
  }
  if (next.size === 0) {
    throw new OAuthBackendError(
      `the authorization server's JWKS contained no usable RSA keys ` +
      `(${(doc.keys ?? []).length} key(s) present)`);
  }
  jwksKeys = next;
  jwksFetchedAt = Date.now();
}

async function keyFor(cfg: OAuthRsConfig, kid: string): Promise<KeyObject> {
  if (Date.now() - jwksFetchedAt > JWKS_TTL_MS) await fetchJwks(cfg);
  let key = jwksKeys.get(kid);
  if (!key && Date.now() - jwksAttemptedAt >= JWKS_REFETCH_COOLDOWN_MS) {
    // Rotation path: a just-published kid is not in the cached set yet. Rate
    // limited, because the caller is unauthenticated at this point — see
    // JWKS_REFETCH_COOLDOWN_MS.
    await fetchJwks(cfg);
    key = jwksKeys.get(kid);
  }
  if (!key) {
    throw new TokenInvalidError(
      `the token is signed with a key this server does not know (kid=${safeText(kid)}); ` +
      `the authorization server publishes ${[...jwksKeys.keys()].map((k) => safeText(k, 24)).join(", ") || "none"}`);
  }
  return key;
}

// ---- Verification -----------------------------------------------------------

export interface VerifiedToken { grantId: string; subject?: string }

export async function verifyAccessToken(cfg: OAuthRsConfig, token: string): Promise<VerifiedToken> {
  const [h, p, sig] = token.split(".");
  let header: any, payload: any;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
  } catch {
    throw new TokenInvalidError("the token's header or payload is not valid base64url JSON");
  }
  // Pin the algorithm before touching key material — accepting whatever the
  // header claims is the classic none/HS-confusion hole.
  if (header.alg !== "RS256") {
    throw new TokenInvalidError(`this server only accepts RS256 tokens; this one declares alg=${safeText(header.alg, 24)}`);
  }
  if (typeof header.kid !== "string") {
    throw new TokenInvalidError("the token header carries no kid, so its signing key cannot be identified");
  }
  const key = await keyFor(cfg, header.kid);
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${h}.${p}`),
    key,
    Buffer.from(sig, "base64url")
  );
  if (!ok) {
    throw new TokenInvalidError(
      `the token's signature does not verify against the published key (kid=${safeText(header.kid)})`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number") {
    throw new TokenInvalidError("the token carries no exp claim, so it can never be considered valid");
  }
  if (payload.exp + CLOCK_TOLERANCE_SEC < now) {
    // The age matters: seconds past expiry is a refresh that did not happen,
    // while days past is a stored token being replayed. Different fixes.
    throw new TokenInvalidError(
      `the token expired ${now - payload.exp}s ago (tolerance ${CLOCK_TOLERANCE_SEC}s)`);
  }
  if (payload.iss !== cfg.authorizationServer) {
    throw new TokenInvalidError(
      `the token was issued by ${safeText(payload.iss)}, but this server only accepts tokens from ${cfg.authorizationServer}`);
  }
  // fosite emits aud as an array (granted audience, single value by AS policy).
  const aud: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.resource)) {
    // Byte-for-byte per RFC 8707, so this fires on a stray trailing slash —
    // which is invisible unless both values are printed side by side.
    throw new TokenInvalidError(
      `the token is bound to audience [${aud.map((a) => safeText(a)).join(", ")}], ` +
      `but this resource is ${cfg.resource}`);
  }
  const scopes: unknown[] = Array.isArray(payload.scp) ? payload.scp : [];
  if (!scopes.includes("mcp:tools")) {
    throw new TokenInvalidError(
      `the token is missing the mcp:tools scope (it has [${scopes.map((s) => safeText(s, 32)).join(", ")}]); ` +
      `re-authorize and grant it`);
  }
  if (typeof payload.grant_id !== "string" || payload.grant_id === "") {
    throw new TokenInvalidError("the token carries no grant_id, so no API key can be resolved from it");
  }
  return { grantId: payload.grant_id, subject: typeof payload.sub === "string" ? payload.sub : undefined };
}

// ---- Grant → key resolution --------------------------------------------------

const resolveCache = new Map<string, { apiKey: string; expiresAt: number }>();
/**
 * In-flight resolutions, keyed by grant.
 *
 * Without this, a cold cache turns a burst into a stampede: measured, eight
 * simultaneous calls on one grant produced eight resolve-key requests. That is
 * exactly the shape a real client makes — an agent firing several tool calls
 * at once right after authorizing — so the worst moment for the dependency is
 * also its most likely one. The JWKS path already coalesced; this one did not.
 */
const resolveInFlight = new Map<string, Promise<string>>();

export function resolveGrant(cfg: OAuthRsConfig, grantId: string): Promise<string> {
  const cached = resolveCache.get(grantId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.apiKey);
  const inFlight = resolveInFlight.get(grantId);
  if (inFlight) return inFlight;
  const p = resolveGrantOnce(cfg, grantId).finally(() => resolveInFlight.delete(grantId));
  resolveInFlight.set(grantId, p);
  return p;
}

async function resolveGrantOnce(cfg: OAuthRsConfig, grantId: string): Promise<string> {
  if (!cfg.resolveUrl || !cfg.resolveToken) {
    // A deployment error, not a transient one: this instance advertises OAuth
    // but cannot complete it. Naming the variables is the whole fix.
    throw new OAuthBackendError(
      "this deployment advertises OAuth but cannot exchange grants for keys " +
      "(OCTEN_OAUTH_RESOLVE_URL / OCTEN_OAUTH_RESOLVE_TOKEN are not both set)");
  }
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(cfg.resolveUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Octen-Service-Token": cfg.resolveToken,
      },
      body: JSON.stringify({ grant_id: grantId }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      // This call sits on the hot path for every OAuth tool call; the shared
      // dispatcher is what keeps its socket alive between them.
      dispatcher,
    });
  } catch (e) {
    throw new OAuthBackendError(
      `could not reach the grant-resolution service: ${fetchFailureReason(e, RESOLVE_TIMEOUT_MS)}`);
  }
  if (res.status !== 200) {
    // 401 here is our own service token, not the caller's credential — worth
    // separating, because otherwise it reads as the user's token being wrong
    // and sends them round a re-authorization loop that cannot help.
    throw new OAuthBackendError(
      res.status === 401 || res.status === 403
        ? `the grant-resolution service rejected this server's own service token (HTTP ${res.status})`
        : `the grant-resolution service answered HTTP ${res.status}`);
  }
  let body: { active?: boolean; api_key?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (e) {
    throw new OAuthBackendError(
      `the grant-resolution service's response could not be read: ${fetchFailureReason(e, RESOLVE_TIMEOUT_MS)}`);
  }
  if (!body.active || typeof body.api_key !== "string" || body.api_key === "") {
    // The grant was revoked (or never existed): a *token* problem — the
    // client must re-authorize, so this is 401 territory, not 503.
    resolveCache.delete(grantId);
    throw new TokenInvalidError(
      "the authorization behind this token is no longer active — it was revoked, " +
      "or the API key it was bound to was deleted; re-authorize to continue");
  }
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(grantId, { apiKey: body.api_key, expiresAt: Date.now() + RESOLVE_TTL_MS });
  return body.api_key;
}

/** Full RS-side path: verify, then exchange. Errors are typed for the 401/503 split. */
export async function apiKeyFromAccessToken(cfg: OAuthRsConfig, token: string): Promise<string> {
  const { grantId } = await verifyAccessToken(cfg, token);
  const apiKey = await resolveGrant(cfg, grantId);
  logEvent("oauth_resolved", { grant_prefix: grantId.slice(0, 8) },
    `access token verified, grant ${grantId.slice(0, 8)}… resolved`);
  return apiKey;
}
