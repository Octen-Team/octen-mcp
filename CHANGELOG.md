# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-08-31

### Added
- **Remote HTTP transport (preview)** — `octen-mcp-http` runs the same server
  over stateless Streamable HTTP, for hosting behind a URL instead of spawning
  per client:
  - without an authorization server configured, `initialize` and `tools/list`
    are unauthenticated and credentials are enforced at `tools/call`, where a
    missing key fails with header guidance rather than an opaque handshake
    refusal. With one configured, an uncredentialed request is answered 401 +
    `WWW-Authenticate` instead — see below;
  - both `x-api-key: <key>` and `Authorization: Bearer <key>` are accepted —
    some clients can only send the latter;
  - one server instance per request, key bound by closure. The environment's
    `OCTEN_API_KEY` is deliberately **not** a fallback for HTTP callers: an
    unauthenticated request must fail, not silently ride the deployment's own
    credential. Guarded by tests including a deterministic staggered-body
    interleaving case, since the race window for shared-key-state bugs sits
    inside the body-read await where ordinary concurrent tests cannot land;
  - `GET /healthz` liveness with no upstream round-trip.

  The stdio entry is unchanged in behavior; both entries now assemble the same
  server from `src/server.ts`, so the transports cannot drift apart.

- **OAuth 2.1 resource server** for the HTTP transport — enabled only when both
  `OCTEN_OAUTH_AUTHORIZATION_SERVER` and `OCTEN_MCP_RESOURCE` are set, so a
  self-hosted instance never advertises an authorization server it cannot
  honour. RS256 access tokens are verified against the AS's JWKS with
  `node:crypto` (no new dependency), then exchanged for the grant's API key
  through an authenticated internal endpoint — the token itself never carries a
  key. RFC 9728 protected-resource metadata is served at both the bare and the
  resource-path-derived well-known, and any uncredentialed `POST /mcp` answers
  a 401 challenge, which is what makes a client start the flow at all.

  Token problems answer **401 + `WWW-Authenticate`** so clients auto-refresh;
  backend problems answer **503** so a client does not burn its refresh flow on
  our outage. Bare API keys never enter this path.

- **Three ways to pass a key**, tried in order: `x-api-key`,
  `Authorization: Bearer`, and an `octenApiKey` query parameter. The query
  form exists for clients that can be handed nothing but a URL, e.g. a hosted
  connector UI whose only input is the endpoint. It is not needed for Claude
  Desktop: that config spawns `mcp-remote`, which does take `--header` and
  `--header-file` (the latter keeps the key out of the process arguments).
  A header always wins, so nothing that can send
  one is downgraded. A key in a URL reaches proxy logs, browser history and
  `Referer` headers — none of which this server controls — so the one thing it
  can do, it does: query values are redacted from its own logs, whole rather
  than truncated.
- **`POST /mcp/oauth` and `?login` force the authorization challenge** even
  when a credential is present. Without it there is no route from an
  already-configured API key to OAuth, because the key stops the challenge from
  ever being sent. (This is not the old `?login` gate returning: an
  uncredentialed request is still challenged everywhere.)
- **`?tools=a,b` narrows a connection's tool roster**, enforced on `tools/call`
  as well as `tools/list` — filtering only the listing would leave every tool
  callable and the filter decorative. Clients load every advertised tool's full
  schema into the model's context, so this is a context saving rather than a
  capability switch. An unknown name, or a selection that leaves nothing, is a
  400 naming the bad entry and listing the real ones: silently narrowing
  produces a connection that looks healthy and is missing a tool, which sends
  whoever debugs it to look at the tool instead of at the spelling in their
  URL. Beta tools that the Beta switch has turned off read as names that do not
  exist, so a selection can never reach past that switch.

- **Tool arguments are checked against the schema each tool publishes.** The
  MCP SDK does not enforce `inputSchema`, so every constraint in it was
  advertising: measured, `count: 999999` against `maximum: 100`, a
  5000-character `query` against `maxLength: 500`, and a 5000-entry array
  against `maxItems: 1000` were each relayed to the upstream API intact. An
  agent that read the schema and respected it gained nothing over one that
  ignored it, and when it did get something wrong the answer came back as an
  opaque upstream 400 rather than a sentence naming the field.

  The validator reads the same schema object that is sent to clients, never a
  copy of its rules — a duplicated rule set drifts the first time someone edits
  a schema, and drifts silently. It implements exactly the vocabulary those
  schemas use, and a test asserts no schema ever declares a keyword it would
  skip, since an ignored keyword turns a published constraint back into
  advertising with nobody the wiser.

  Parameters outside a tool's `properties` are refused rather than relayed:
  the properties list is the published interface, and forwarding anything else
  made this server a pass-through for arbitrary JSON. Note for existing
  callers: `news_search` publishes no `topic` (it is fixed to news), so passing
  one is now an error instead of being silently overridden.

- **The HTTP body cap now defaults to 6 MiB**, so `image_search`'s `image_data`
  works without configuration. A default below the largest argument a tool
  accepts means the tool is advertised and unusable over that transport, and
  the client sees a `413` with no obvious connection to the picture it sent.
- **`OCTEN_MCP_MAX_INFLIGHT_BODY`** bounds the total bytes all in-flight bodies
  hold at once, default 24 MiB. The per-request cap stops one enormous request
  and does nothing about many ordinary ones: with the per-request cap at 6 MiB,
  forty concurrent 5 MB bodies measured 772 MB resident against a 768 MiB
  container — an OOM kill reachable by anyone holding a key, with no single
  request breaking a rule. Over the budget, the newest request is shed with
  `503` + `Retry-After`, because this is capacity rather than a bad call.

  The budget is deliberately small relative to the bytes it guards: a 5 MB
  ASCII body is ~10 MB as a UTF-16 string and exists two or three times over
  (concatenated, parsed, re-serialised upstream), so resident cost runs about
  ten times the budget. Verified in a real 768 MiB container: sixty concurrent
  5 MB requests peak at 342 MiB with no OOM kill.

- **Install documentation rebuilt around the hosted endpoint**
  (`https://mcp.octen.ai/mcp`, now live). Remote is the first path a reader
  meets; local stdio follows as the alternative for clients without remote
  support. Per-client configuration is spelled out because the JSON key differs
  between them — `url`, `serverUrl`, `httpUrl`, or `servers` with an explicit
  `type` — and getting it wrong means the server is simply never contacted,
  with nothing in any log to say so. Stdio-only clients get the `mcp-remote`
  bridge, including the detail that `--header` takes no space after the colon.

  Added: a parameter table per tool, transcribed from the schemas the tools
  publish, and a troubleshooting section covering the failures that do not look
  like what they are — a `406` from an incomplete `Accept` header reads as an
  auth problem, and a wrong config key looks like the server being down.

  Corrected: the README claimed `mcp-remote` has no `--header` option. It has
  had one for several releases; the claim came from a report citing 0.2.4
  against a current 0.8.2. The query-string credential remains for clients that
  accept nothing but a URL, which is a smaller set than that claim implied.

### Fixed
- **`image_search` gained `image_data`.** The API's image input takes either a
  URL or base64 bytes; only the URL form was offered, so an image you hold
  rather than one already on the web could not be searched at all. Up to 5MB
  encoded, matching the documented ceiling — measured on the encoded string,
  which is what the API bounds. A `data:` URI is unwrapped rather than refused:
  its payload *is* the base64, and it is the form every browser and screenshot
  tool produces.

  Note for the HTTP transport: base64 travels inside the JSON-RPC body, so
  `OCTEN_MCP_MAX_BODY` (default 1 MiB) must be raised above the image or the
  request is refused. The `413` now names that variable — a byte count alone
  does not tell an operator which knob to turn.
- **`image_search` advertised the one input combination the API refuses, and
  could not express the one it documents.** The `inputs` array takes exactly one
  entry — one text input or one image input, never both. This tool required
  `query` and described `image_url` as usable "in addition" to it, so passing
  both (the advertised path) was answered upstream with `Invalid params. Inputs
  exceeds 1 entries`, while searching by reference image alone — documented and
  supported — could not be expressed at all. `query` is no longer required,
  exactly one of the two is, and asking for both is refused locally with a
  message that names the choice instead of relaying a params error.
- **`include_videos` removed from `search` / `news_search` / `broad_search`.**
  The API reference documents no such parameter for that endpoint. It did have
  an effect when sent — responses carried a `videos` field only with it set —
  but advertising a parameter the API does not document is promising something
  nobody has committed to, and since the schemas became a gate that promise is
  enforced against callers. `extract` keeps all three of its media flags; those
  are documented. The video renderer stays too: if a response ever carries
  `videos` regardless, dropping them silently is the defect above.
- **Declared parameter limits did not match the published API.** Seven of them,
  across four tools. Two were rejecting calls the API serves: `exclude_domains`
  was capped at 150 against a documented 1200, and every domain longer than 30
  characters was refused against a documented 60. Three were missing entirely
  (`urls` item length, `max_age_seconds` upper bound, `html_snippet.max_tokens`
  upper bound), so nothing bounded them at all.

  This mattered little while the schemas were advertising; it started costing
  users the moment they became a gate. A limit stricter than the API's refuses
  work the API would do, and a looser one defers the failure upstream where the
  message is worse. `test/apiContract.test.mjs` now pins every documented
  limit and enum, so the next divergence fails a test instead of a user's call.
- **`include_images` / `include_videos` returned no URLs.** The tools promise,
  in their own descriptions, to "return media URLs per result"; what came back
  was a count. Measured against the live API: a search whose result carried 101
  image URLs rendered as the single line `**Images:** 101`, and the only image
  links anywhere in the output were favicons. `extract` did the same for its
  images, videos and audio — 37 / 14 / 3 URLs, none of them printed. Setting
  the flag cost an upstream fetch and returned nothing actionable.

  Each entry now prints as `url — description`, capped at ten per list with the
  true total stated alongside. The caption matters as much as the link: on news
  results it carries what was photographed, where, when, and the photographer's
  credit, and a bare URL leaves a model with nothing it can say about the
  picture. The cap is there because one result really can carry a hundred
  images, and pasting all of them into a model's context costs more than the
  answer is worth — but a cap the reader cannot see is the same silent drop in
  a smaller size, so the total is always stated.
- **`cover_image` rendered as `[object Object]`.** The field arrives as
  `{url, description}` and search interpolated the object. `extract` had
  already been reading `.url` correctly — the two had drifted, which is also
  how the counting bug above came to exist in two places. Both now share one
  renderer rather than a copy each.
- **The OAuth flow never started.** The 401 challenge — the only trigger MCP
  clients act on — fired solely on a `?login` entrypoint, so a client given the
  plain `/mcp` URL got 200 from `initialize`, concluded the server needed no
  authorization, listed tools, and failed at the first `tools/call` with a
  message pointing at manual API-key setup. Connected, and never able to
  authorize. Confirmed on pre before the fix: `initialize`, `tools/list` and
  `tools/call` all answered 200 with no `WWW-Authenticate` on any of them.

  An uncredentialed request now gets 401 + `WWW-Authenticate` on every method
  when an authorization server is configured. The trade is that anonymous
  `tools/list` is no longer possible against such a deployment; deployments
  without an authorization server are unchanged, since there would be nowhere
  to send the client.
- **JWTs this server cannot verify were retried as API keys.** The structural
  gate that routes a bearer value to the OAuth path or the API-key path
  required `alg: RS256` *and* a `kid`, so anything token-shaped but
  unverifiable fell through to the key path: measured, `alg: none`, an HS256
  token, and one missing `kid` were each forwarded verbatim to the upstream as
  an API key and answered HTTP 200 with a tool-level "Invalid API Key". A
  client holding a bearer token needs 401 + a challenge to know it should
  re-authorize; a tool error reads as a backend fault to retry, so it never
  does. It also put a whole bearer token — possibly minted for another
  audience — into the API gateway's logs as if it were a key. The gate is now
  shape-only (three segments, header with a string `alg`), and the specific
  reason comes back as a 401. Values that are not token-shaped are still keys,
  and a wrong key still earns the tool-level "check your key" error.

  Not affected, verified rather than assumed: an *expired* token already took
  the OAuth path and answered 401, because tokens from the authorization server
  always carry a `kid`.
- **The request-size cap could be answered with a connection reset instead of a
  413.** Hanging up while the client is still sending resets the connection,
  and a reset discards the response bytes still in flight — measured both ways:
  a client that stopped after 128 KB received the 413, one that kept sending
  received only `ECONNRESET`. The body is now drained and discarded (bounded by
  `OCTEN_MCP_BODY_DRAIN_MS`, default 2s) so the answer survives the close.
- **Remote kill via a hostile token header.** A `kid` containing CRLF reached
  `res.writeHead` through the `WWW-Authenticate` challenge; the resulting
  `ERR_INVALID_CHAR` escaped an async handler as an unhandled rejection and
  ended the process. Unauthenticated and one request per kill — with a single
  replica that is a full outage. Fixed in three places: the value is sanitised
  at its source, `error_description` is filtered to the RFC 6750 charset, and
  the request handler now has an error boundary so no future throw can exceed
  one failed request.
- **JWKS amplification.** An unknown `kid` triggered a JWKS refetch per
  request, with no cross-request limit — measured at 11 fetches from 10
  unauthenticated requests, aimed at our own authorization server. Refetches
  are now rate-limited and concurrent misses share one fetch. Rotation still
  picks up a new key, delayed by at most the cooldown.
- **A misconfigured resource URL used to pass startup and every health probe**,
  then kill the process on the first `?login` — a pod that is healthy until
  someone uses it. Both OAuth URLs are now parsed at startup and an unusable
  value stops the process there.
- **The OAuth path bypassed the tuned HTTP dispatcher**, so JWKS and grant
  resolution ignored the proxy environment (the 0.4.0 fix, missing from the
  code added after it) and re-handshaked on every call.
- **Generic failures replaced with specific ones.** `fetch failed`,
  `Authorization backend temporarily unavailable`, `Invalid or expired access
  token` and `Internal server error` each fit a dozen unrelated causes, which
  is what makes a report unactionable. Every failure now names the dependency
  and the reason: which endpoint, which transport code or HTTP status, how long
  a token has been expired, both sides of an audience mismatch, and whether the
  caller should retry or re-authorize. Internal addresses are still never
  disclosed.
- **Environment overrides could be disabled by a typo.** `OCTEN_MCP_MAX_BODY`
  and `OCTEN_DRAIN_TIMEOUT_MS` were parsed with a bare `Number()`, so a
  non-numeric value became `NaN` — silently removing the body cap and turning
  the drain deadline into an infinite one. Both now fall back, and the drain
  logs the budget it actually resolved to.
- **Requests blocked in credential resolution were invisible to the drain**, so
  SIGTERM could exit underneath one. They are counted from arrival now.
- **A trailing slash on `OCTEN_OAUTH_AUTHORIZATION_SERVER` refused every
  token.** The value is used two ways and a trailing slash breaks both: the
  JWKS URL becomes `…//api/oauth/jwks`, and `iss` is compared byte-for-byte
  against a value no authorization server emits with a trailing slash. The
  process started, every health probe passed, and 100% of tokens were rejected
  — measured. Refused at startup now, because the rejection message prints two
  strings that differ by the one character nobody sees.
- **A trailing slash on the endpoint answered 404.** `…/mcp/` is the commonest
  paste artifact in a URL a human copies into a client config; answering it
  with 404 makes a working deployment look broken for a reason nobody
  inspects. Both spellings are accepted now.
- **A burst on one grant made one resolve-key call per request** — measured at
  eight for eight simultaneous calls. That burst is what an agent firing
  several tools at once right after authorizing looks like, so the
  dependency's worst moment was also its most likely one. In-flight
  resolutions are shared now, as the JWKS path already did.
- **The advertised metadata URL was hardcoded to `/mcp`** rather than derived
  from the resource path, so an instance mounted elsewhere pointed clients at a
  document it does not serve.

### Changed
- The grant→key cache lifetime is now `OCTEN_OAUTH_RESOLVE_CACHE_TTL_MS`
  (default 60000, `0` disables caching). This is the revocation-propagation
  window — measured on pre, a revoked token still worked at t=45s and was
  refused at t=60s — and it is a deliberate trade rather than an implementation
  detail: resolving on every call would put a synchronous dependency on the
  authorization server in front of every tool call. It is also an increment on
  top of the access token's own ~3600s lifetime, not the whole exposure.


## [0.4.2] — 2026-08-19

### Fixed
- **Every call failed on Node 26+ (`code=UND_ERR_INVALID_ARG cause=invalid
  onError method`).** Since 0.4.0 the server built its tuned connection agent
  from the packaged undici 6 and handed it as `dispatcher` to the host's
  global `fetch` — coupling two undici versions across the dispatch-handler
  protocol. undici 8, which Node embeds from 26, removed the legacy handler
  compatibility that v7 still carried, so the host's fetch rejects the v6
  dispatcher at validation before a single byte is sent: 100% of tool calls
  fail on such hosts. 0.4.1 and below need Node <= 24; from 0.4.2 all
  supported Node versions (>= 18.17) work.

  The fix makes the HTTP stack self-contained — `fetch` and the dispatcher
  both come from the packaged undici, so the host's embedded undici version
  is out of the picture entirely, for this incompatibility and for future
  protocol changes alike. Requests now also pin `accept-encoding` to exactly
  what the packaged undici can decode (`gzip, deflate, br`) instead of
  inheriting a scheme- and version-dependent default. CI runs the suite on
  Node 18/20/22/24/26; a real-socket regression test drives the built server
  through the packaged stack on the host's own Node, and a lint-style guard
  keeps global `fetch` / `Response` / `Headers` / `Request` usage out of
  `src/`.

## [0.4.1] — 2026-08-15

### Fixed
- **Body-read failures were lumped into `returned non-JSON`.** `resp.json()`
  can fail three distinct ways, and two of them are not parse errors:
  - the client deadline aborting a stalled read — now
    `timed out while reading the response body (HTTP <status>)`;
  - the connection dying mid-body with no timeout involved (RST, FIN, or a
    Content-Length the origin never honored; undici surfaces these as a bare
    `TypeError: terminated` with the diagnosis on `cause.code`) — now
    `connection lost while reading the response body (HTTP <status>,
    code=ECONNRESET|UND_ERR_SOCKET|…)`. This shape was missed by the first
    cut of this fix and caught by its review;
  - genuinely malformed bytes — keeps `returned non-JSON`.

  The classification is centralised in one helper rather than five
  copy-pasted catch blocks. Found by rebuilding the 0.4.0 field report's
  failure shapes on real sockets; regression tests drive the built server
  against an upstream that stalls, and one that RSTs, mid-body.
- **The client-generated correlation UUID no longer appears in user-facing
  error messages.** 0.4.0 echoed it as `request_id=<uuid>`, which reads like an
  id Octen support can search. They cannot — the gateway does not record the
  `x-request-id` header — so a ticket quoting it dead-ends: the same
  mutual-unaccountability failure the 0.4.0 incident was about, rebuilt in
  miniature. Error messages now carry only ids verified to be searchable on
  Octen's side — which, checked against the live infrastructure, is exactly
  one: the server's `request_id` from an API error envelope (confirmed
  retrievable in gateway logs). The client UUID remains in the
  `OCTEN_MCP_DEBUG` trace, and the `x-request-id` header still accompanies
  every call, so server-side recording can light it up later without a client
  change.
- **The `x-azure-ref` edge reference is removed everywhere** — the debug
  trace, the docs, and (briefly, within this release's own review cycle) error
  messages. Verified against the live infrastructure: edge access logging is
  not enabled, so the reference cannot be looked up at Octen, and an
  identifier surfaced anywhere in the product reads as a capability. A guard
  test now asserts infrastructure response headers never leak into user-facing
  text.
- README claimed `broad_search`'s default timeout is 60s; it has been 120s
  (raisable to 300s) since 0.4.0.

## [0.4.0] — 2026-08-14

Reliability and latency fixes in the HTTP layer. No tool, schema, or parameter
changes — every tool behaves the same, it just gets there faster and says what
went wrong when it doesn't.

Released as a minor rather than a patch, because two things change underneath a
caller who upgrades without reading: a runtime dependency appears where there
had been only the MCP SDK, and requests that previously ran untimed and
un-retried now do both — and a retry costs quota. Neither should arrive silently
via `~0.3.x`. The declared Node floor also moves, but that one changes nothing
in practice; see Changed.

### Fixed
- **Network failures are now diagnosable.** `fetch` rejects with a bare
  `TypeError: fetch failed`; the actual reason lives on `err.cause`, which every
  call site discarded. Errors now report `cause.code` (`ECONNRESET`,
  `UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`, …), the peer address, and a
  correlation id, and unwrap `AggregateError` when every address failed. Support
  tickets previously carried no information beyond "fetch failed".
- **Every request has a timeout.** `timeout` was only honoured when the caller
  passed it explicitly — otherwise no `AbortSignal` was attached at all and a
  stalled request sat on undici's 300s `headersTimeout`, which an agent sees as
  a tool call that never returns. Defaults: 30s for `search` / `news_search` /
  `image_search` / `video_search`, 120s for `broad_search` (this entry
  originally said 60s in error — the shipped 0.4.0 code already defaulted to
  120s, raisable to 300s; corrected in 0.4.1). `extract` had no
  client timeout whatsoever; its `timeout` is the server-side per-URL budget, so
  the client ceiling is now derived from it with headroom.
- **Connections are reused between tool calls.** The server used undici's global
  dispatcher, whose `keepAliveTimeout` is 4s — longer than that idle and the
  socket is closed, so the next tool call re-pays TCP + TLS. Agent tool calls are
  almost always more than 4s apart, so nearly every call paid it. Measured
  against `api.octen.ai`: four calls spanning 16s of idle opened **3 connections
  at 785ms each**; they now open **1**, and calls after the first settle at
  **~270ms** against a server-side latency of ~1ms.
- `src/index.ts` reported version `0.3.6` while the package shipped as `0.3.7`,
  making the version a client reports useless for triage. It is now read from
  `package.json`.

### Added
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` support. Node's built-in `fetch`
  ignores proxy environment variables, unlike curl and most SDKs, so behind a
  corporate proxy the server could not reach the API at all while every other
  tool on the machine could.

  Note for MCP clients generally, and Claude Desktop specifically: the server
  does not inherit your shell environment. Claude Desktop passes `HOME`,
  `LOGNAME`, `PATH`, `SHELL` and `USER` plus the config's `env` block, and
  nothing else — so a system-wide proxy is *not* picked up automatically and has
  to be named in `env` like the API key. The README shows the config.
- One retry with backoff on connection-level failures (`ECONNRESET`,
  `UND_ERR_CONNECT_TIMEOUT`, …), covering in particular the keep-alive race
  where the origin reaps an idle socket exactly as we dispatch on it — which
  holding sockets for 240s makes *more* likely, not less. Permanent failures
  are not retried, and neither is anything that produced a response.

  Worth stating precisely, because the obvious justification is not quite true:
  `ECONNREFUSED` / `EAI_AGAIN` / `UND_ERR_CONNECT_TIMEOUT` genuinely cannot have
  reached the server, but `ECONNRESET` / `UND_ERR_SOCKET` are raised whenever
  the socket errors — before the request was written *or* after the server
  began acting on it — and the two are indistinguishable by error code. We
  retry both: these are read-only queries, so a duplicate costs quota rather
  than correctness. But it is a duplicate billed call, and for `broad_search`
  the whole server-side fan-out runs twice. Set `OCTEN_RETRY=off` to disable.
- An `x-request-id` correlation id per logical call, stable across the retry and
  echoed in error messages. Octen's own `request_id` is generated server-side
  and only comes back on success, so a failed call previously had no identifier
  at all; this one at least ties a user's error message to the retry attempts in
  its debug output. Server-side lookup by this header is *not* available yet —
  the API does not record it — so it does not currently let a failed request be
  found in Octen's logs.
- `OCTEN_MCP_DEBUG=1` — request tracing on **stderr** (stdout carries MCP
  protocol framing), built around the questions a field report actually has to
  answer:
  - a UTC timestamp on every line, so the trace can be aligned against a
    client's session log and against server-side receive times;
  - the moment each tool call **reached this process**, which is what separates
    delay inside `octen-mcp` from delay in the host or a relay ahead of it — a
    client-side stopwatch attributes all of it to us by default;
  - whether the call reused a connection or paid for a handshake
    (`socket=new` / `socket=reused`), and what the handshake cost;
  - connection failures by phase and error code, rather than after the fact;
  - `x-azure-ref` from the edge. (Removed in 0.4.1: this entry originally
    claimed the ref was "already present in Octen's infrastructure logs" —
    edge access logging is in fact not enabled, so the reference could not be
    looked up at Octen and only misled.)
- Tunables: `OCTEN_KEEP_ALIVE_MS`, `OCTEN_KEEP_ALIVE_MAX_MS`,
  `OCTEN_CONNECT_TIMEOUT_MS`, `OCTEN_HTTP2`, `OCTEN_RETRY`. HTTP/2 is off by
  default: it measured no faster for the usual one-request-at-a-time pattern
  and is not reliable through every CONNECT proxy.

### Changed
- `engines.node` tightened from `>=18` to `>=18.17`, to match undici 6.

  **In practice this excludes nobody, and nobody needs to upgrade Node for it.**
  npm treats `engines` as advisory: on Node 18.16 the install prints an
  `EBADENGINE` warning and then proceeds, and the server runs normally — checked,
  including a live search call. It only blocks under `engine-strict=true`, and
  there the binding constraint is not ours: `@hono/node-server`, reached through
  `@modelcontextprotocol/sdk`, already requires Node `>=20`, so 0.3.7 fails to
  install on 18.16 for the same reason 0.4.0 does. The declaration is here to be
  truthful about what this package is tested against, not to force an upgrade.
- New runtime dependency on `undici` (^6), required to configure a dispatcher —
  Node exposes no core API for it. It is the same project that Node bundles for
  `fetch`, though not necessarily the same major version: Node 18 ships undici 5
  and Node 24 ships undici 7 internally. Passing a `dispatcher` built by one
  major to a `fetch` implemented by another is a supported-in-practice but
  unguaranteed combination, so the pin is deliberate and worth revisiting when
  the Node floor moves.

### Notes
- The timeout is a deadline for the whole call, not per attempt: the retry
  draws down the same budget, so a 30s timeout cannot become 60s.
- `keepAliveTimeout` is 60s because that is what `api.octen.ai` tolerates, not
  because 60s is a round number. Measured: a socket idle 30s or 60s is still
  usable; at 90s the origin has already closed it and the next call re-shakes
  hands (816ms against 268ms). The edge does not advertise a `Keep-Alive` hint
  to follow, so the ceiling has to be set client-side — and setting it too high
  is not a harmless over-reach, since every gap past the origin's threshold
  leaves us dispatching onto a socket the peer has already closed.

## [0.3.7] — 2026-07-30

### Changed
- Tool **descriptions** rewritten for discovery & routing in deferred-loading
  clients (no behavior/schema/param change):
  - Every tool now opens with a generic, retrieval-friendly first sentence
    (no brand name or internal jargon up front) and carries a `keywords:` line —
    `image_search` / `video_search` no longer open with "In Beta.".
  - `broad_search` gained an explicit **COST** signal, four concrete negative
    examples (single fact → `search`; don't re-run; known URL → `extract`;
    A-vs-B → two `search` calls), a `max_queries` problem-type → number mapping,
    pronoun-resolution guidance, and a `broad_search + topic=news` boundary.
  - `search` gained symmetric guidance pointing multi-subtopic questions to
    `broad_search`; sibling cross-references added across `search` / `broad_search`
    / `extract`.
- README: optional `alwaysLoad` ("keep the tools always on") section for clients
  with MCP tool search enabled.

## [0.3.6] — 2026-07-28

### Added
- `OCTEN_ENABLE_BETA_TOOLS` env var. Defaults to enabled (existing behavior). Set
  it to `false`/`0`/`off`/`no` to omit the Beta `image_search` and `video_search`
  tools from tool discovery and reject any direct call to them — lets a host
  expose only the four generally-available tools.

## [0.3.5] — 2026-07-27

### Added
- `language` parameter (ISO 639-1 codes) for language filtering on the search / news_search / broad_search tools.

## [0.3.4] — 2026-07-24

### Removed
- `country` parameter removed from the search / news_search / broad_search tool schemas.

## [0.3.3] — 2026-07-20

### Changed
- `country` parameter description aligned with the official wording: "Follow ISO 3166, the International Standard for country codes and codes for their subdivisions".

## [0.3.2] — 2026-07-16

### Added
- **`country`** input parameter on `search`, `news_search`, and `broad_search` —
  ISO 3166-1 alpha-2 country code (e.g. `US`, `JP`) or `auto` (server default)
  for region-specific results. Sent top-level on `POST /search`; nested under
  `search_options` on `POST /broad-search`. Omitted from the request when unset
  so the server default applies.
- Minimal unit-test suite (`npm test`, Node's built-in `node:test` runner)
  covering request-body assembly for `search` / `news_search` / `broad_search`.

## [0.3.1] — 2026-07-06

Aligns the `extract` tool with the current Extract API reference
(https://docs.octen.ai/api-reference/extract).

### Removed
- **`include_favicon`** input parameter. The page `favicon` is now returned by
  default when available, so the flag is no longer needed (or accepted by the
  API).

### Added
- `cover_image` (`{url}`) is now surfaced in each result when `include_images`
  is set and the page has a cover image.

## [0.3.0] — 2026-06-29

### Added
- `broad_search` tool wrapping Octen Broad Search (`POST /broad-search`) —
  decomposes a query into up to `max_queries` (1–30, default 5) sub-queries,
  searches them concurrently, and returns results grouped per sub-query. Accepts
  the same per-sub-query options as `search` (flattened, assembled into
  `search_options`).
- `image_search` tool wrapping Octen Image Search (`POST /image-search`) —
  flattened `query` + optional `image_url`, `topic` (general/design; `design`
  returns a style `summary` + `html_snippet`), `count` (1–10), domain/time
  filters, `safesearch`, `html_snippet`. **In Beta — contact us for beta access.**
- `video_search` tool wrapping Octen Video Search (`POST /video-search`) — text
  `query`, `count` (1–10), time filters, `safesearch`; results include the matched
  segment timestamps, duration, cover, and source. **In Beta — contact us for beta access.**

## [0.2.0] — 2026-06-23

### Added
- `search` tool wrapping Octen Search API (`POST https://api.octen.ai/search`).
- Supports `query`, `topic` (general/news), `count`, domain and text
  include/exclude filters (`include_domains` ≤1000, `exclude_domains` ≤150,
  `include_text`/`exclude_text` ≤5, each entry ≤30 chars), a time window
  (`time_basis`, `time_range`, `start_time`, `end_time`), `format`, `safesearch`,
  `include_images` / `include_videos`, and per-result `highlight` / `full_content`
  options (`highlight.max_tokens` 100–20000 default 512; `full_content.max_tokens`
  100–100000 default 2048).
- Results render as a single markdown block (title, url, authors, timestamps,
  favicon, image/video counts, highlight/content) — consistent with the `extract` tool.
- `news_search` tool — `search` locked to `topic: news` for current-events/headline
  queries. Accepts every `search` parameter except `topic`.

## [0.1.5] — 2026-05-20

### Changed
- Align `mcpName` in `package.json` with the canonical GitHub
  organization name (`io.github.Octen-Team/octen-mcp`), required by the
  MCP Registry's case-sensitive ownership check.

## [0.1.4] — 2026-05-20

### Changed
- Tool response is now a single markdown text block instead of a compact
  summary followed by the entire raw JSON. Some models (Claude included)
  would otherwise reach for `jq` / file_search to dig through the JSON
  dump just to find a title — wasted turns and a worse UX. Markdown gives
  the model the structured info (title, category, page_structure,
  highlights/full_content) ready to use.

## [0.1.3] — 2026-05-20

### Added
- `mcpName` field in `package.json` (`io.github.octen-team/octen-mcp`),
  required by the official MCP Registry to link the npm package to a
  registry entry.

## [0.1.2] — 2026-05-20

### Changed
- VS Code install button now prompts for the API key on click (no manual JSON
  editing needed). Added a VS Code Insiders variant alongside.
- Removed the Cursor install button. Cursor's deeplink format can't pre-prompt
  for credentials, so the manual JSON config block is the canonical path now.

## [0.1.1] — 2026-05-20

### Fixed
- Align the MCP server's self-reported name (in the `initialize` handshake and
  startup log) with the published package name `octen-mcp`.

## [0.1.0] — 2026-05-20

### Added
- Initial release.
- `extract` tool wrapping Octen Extract API (`POST https://api.octen.ai/extract`).
- Supports `urls`, `query`, `max_age_seconds`, `format`, `timeout`, `include_images`,
  `include_videos`, `include_audio`, `include_favicon`.
- Surfaces Octen-unique response fields: `category`, `page_structure`, `highlights`.
- stdio transport (works with Claude Desktop, Cursor, Claude Code, Windsurf).
- `OCTEN_API_KEY` env var for authentication.
- `OCTEN_API_URL` override for staging or self-hosted endpoints.

[Unreleased]: https://github.com/Octen-Team/octen-mcp/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/Octen-Team/octen-mcp/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Octen-Team/octen-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Octen-Team/octen-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.2.0
[0.1.5]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.5
[0.1.4]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.0