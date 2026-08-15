# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] — 2026-08-15

### Fixed
- A response whose 200 headers arrived but whose body stalled mid-stream was
  reported as `returned non-JSON (HTTP 200)` — pointing whoever read the error
  at a serialization problem when the actual event was a stalled connection.
  The client deadline governs body consumption too; when it aborts a stalled
  body read, all five tools now report
  `timed out while reading the response body` instead. Found by rebuilding the
  0.4.0 field report's failure shapes on real sockets; the regression test
  drives the built server against an upstream that sends half a body and goes
  silent.

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
  `image_search` / `video_search`, 60s for `broad_search`. `extract` had no
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
  - `x-azure-ref` from the edge, which unlike our own correlation id is already
    present in Octen's infrastructure logs — and whose absence on a failure is
    itself evidence the request never arrived.
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

[Unreleased]: https://github.com/Octen-Team/octen-mcp/compare/v0.3.7...HEAD
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