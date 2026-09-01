# octen-mcp

[![npm version](https://img.shields.io/npm/v/octen-mcp.svg?color=blue)](https://www.npmjs.com/package/octen-mcp)
[![npm downloads](https://img.shields.io/npm/dm/octen-mcp.svg)](https://www.npmjs.com/package/octen-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/Octen-Team/octen-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Octen-Team/octen-mcp/actions/workflows/ci.yml)

MCP server for **Octen**. Plug it into Claude, Cursor, VS Code, Windsurf, or any MCP client to give your agent live web search and URL extraction.

Core capabilities:

- **`search` / `news_search`**: search the live web with domain, text, language, and time filters.
- **`broad_search`**: decompose a query into multiple sub-queries, search them concurrently, and return results grouped per sub-query for broad coverage.
- **`extract`**: turn one or more URLs into clean, LLM-ready content.
- **`image_search`** (In Beta — contact us for beta access): search the web for images by text query, by a reference image URL, or by base64 image data — exactly one of the three.
- **`video_search`** (In Beta — contact us for beta access): search the web for videos by text query.

What makes Octen useful for agents is that `extract` returns more than page text. Each successful result also includes:

- **`category`**: what the page is about
- **`page_structure`**: what kind of page it is
- **`highlights`**: ranked snippets when you pass a `query`

That lets an agent skip login walls, nav pages, and off-topic URLs before spending tokens on the full body.

## Why Octen MCP

### Fast
Web search averages 62ms. Fast enough for multi-step MCP workflows.

### Accurate
Powered by SOTA text and VL embedding models. Better sources, fewer hallucinations.

### Fresh
Live web data with minute-level updates. Useful for news, prices, and fast-moving pages.

### Efficient
Clean highlights, optional `full_content`, and page labels keep model context relevant.

## Quick start

You need an `OCTEN_API_KEY` from [octen.ai](https://octen.ai).

**Two ways to connect.** Both serve the same six tools.

| | Endpoint | When |
|---|---|---|
| **Hosted (recommended)** | `https://mcp.octen.ai/mcp` | Nothing to install or update. Works with any client that speaks remote MCP. |
| **Local** | `npx -y octen-mcp` | Clients without remote support, air-gapped setups, or when you want the process on your own machine. |

> **Node compatibility (local only):** 0.4.2 and later run on every supported
> Node (>= 18.17), including Node 26+. Versions 0.4.1 and below fail every call
> on hosts whose embedded undici is v8+ (Node 26 and later) with
> `Network error … code=UND_ERR_INVALID_ARG cause=invalid onError method` — if
> you see that error, upgrade the package (or run on Node <= 24).

## Connect to the hosted endpoint

### Passing your key

Three ways, tried in this order. **Prefer a header** — a key in a URL is
exposed to proxy logs, browser history and `Referer` headers.

| Form | Use when |
|---|---|
| `x-api-key: <key>` | The default. |
| `Authorization: Bearer <key>` | Your client only offers one header field. |
| `?octenApiKey=<key>` appended to the URL | Your client accepts nothing but a URL. |

Or use **OAuth** and paste no key at all — see [Signing in instead](#signing-in-instead).

### By client

**Claude Code**

```bash
claude mcp add --transport http octen https://mcp.octen.ai/mcp --header "x-api-key: your-key-here"
```

**Cursor** — `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "octen": {
      "url": "https://mcp.octen.ai/mcp",
      "headers": { "x-api-key": "your-key-here" }
    }
  }
}
```

**VS Code** — `.vscode/mcp.json` (workspace) or the user config. Note `servers`,
not `mcpServers`, and the explicit `type`:

```json
{
  "servers": {
    "octen": {
      "type": "http",
      "url": "https://mcp.octen.ai/mcp",
      "headers": { "x-api-key": "your-key-here" }
    }
  }
}
```

**Codex**

```bash
codex mcp add octen --url https://mcp.octen.ai/mcp --header "x-api-key: your-key-here"
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`. The key is `serverUrl`,
not `url`:

```json
{
  "mcpServers": {
    "octen": {
      "serverUrl": "https://mcp.octen.ai/mcp",
      "headers": { "x-api-key": "your-key-here" }
    }
  }
}
```

**Gemini CLI** — `~/.gemini/settings.json`. The key is `httpUrl`:

```json
{
  "mcpServers": {
    "octen": {
      "httpUrl": "https://mcp.octen.ai/mcp",
      "headers": { "x-api-key": "your-key-here" }
    }
  }
}
```

**Claude Desktop** takes the URL directly — no config file, no bridge. In
**Settings → Connectors**, click **Add custom connector**, name it `Octen`, and
enter:

```
https://mcp.octen.ai/mcp
```

Leave the Advanced settings empty: the OAuth Client ID and Secret fields are
for servers that cannot register a client on their own, and ours can. Claude
will offer to sign you in, and an Octen key is issued to that connection when
you approve.

The connector dialog has no field for request headers, so an **API key** goes
in the URL instead:

```
https://mcp.octen.ai/mcp?octenApiKey=your-key-here
```

Signing in is the better of the two — a URL is not a secret-carrying medium,
and the sign-in flow can be revoked from your account without editing anything
on this side. Note also that Claude connects from Anthropic's servers rather
than from your machine, so a self-hosted deployment has to be reachable from
the public internet for this to work at all; a private one wants the bridge
below.

**Clients that only speak stdio** (Zed, Warp, Raycast, Cline) reach a remote
server through the `mcp-remote` bridge. Note there is **no space after the
colon** in `--header` — the value is split on the first one:

```json
{
  "mcpServers": {
    "octen": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp.octen.ai/mcp",
        "--header", "x-api-key:your-key-here"
      ]
    }
  }
}
```

If a client cannot pass a header at all and takes only a URL, put the key in
the URL instead: `https://mcp.octen.ai/mcp?octenApiKey=your-key-here`.

### Signing in instead

If the deployment is configured with an authorization server — the hosted one
is — a request with no credential is answered `401` +
`WWW-Authenticate: Bearer resource_metadata="…"`. That is the signal MCP
clients use to start an OAuth flow, so a client that supports OAuth will offer
to sign you in rather than ask for a key.

To move a connection that already has a key onto OAuth, point it at
`https://mcp.octen.ai/mcp/oauth` (or append `?login`). That path issues the
challenge even when a key is present, which is the only way to trigger the
switch — with a key attached, the ordinary endpoint has no reason to.

### Loading fewer tools

`?tools=search,extract` limits a connection to the tools you name, for both
`tools/list` and `tools/call`:

```
https://mcp.octen.ai/mcp?tools=search,extract
```

Clients load every advertised tool's full schema into the model's context, so
narrowing the set is a real saving when you only need one or two. An unknown
name is refused with a `400` listing the valid ones, rather than a connection
that quietly comes up short.

## Run it locally instead

```json
{
  "mcpServers": {
    "octen": {
      "command": "npx",
      "args": ["-y", "octen-mcp"],
      "env": { "OCTEN_API_KEY": "your-key-here" }
    }
  }
}
```

[![Install in VS Code](https://img.shields.io/badge/Install%20in-VS%20Code-007ACC?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=octen&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Octen%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22octen-mcp%22%5D%2C%22env%22%3A%7B%22OCTEN_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/Install%20in-VS%20Code%20Insiders-24bfa5?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=octen&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Octen%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22octen-mcp%22%5D%2C%22env%22%3A%7B%22OCTEN_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D&quality=insiders)

| Agent | One-line install |
|--|--|
| Claude Code | `claude mcp add --scope user octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| Codex | `codex mcp add octen --env OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| Gemini CLI | `gemini mcp add octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| VS Code | `code --add-mcp '{"name":"octen","command":"npx","args":["-y","octen-mcp"],"env":{"OCTEN_API_KEY":"your-key-here"}}'` (or click a badge above) |
| Cursor | [Add to Cursor](https://cursor.com/en/install-mcp?name=octen&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9jdGVuLW1jcCJdLCJlbnYiOnsiT0NURU5fQVBJX0tFWSI6InlvdXIta2V5LWhlcmUifX0%3D) (then edit the key), or use the JSON above in `~/.cursor/mcp.json` |
| Claude Desktop | No CLI. For the hosted endpoint use **Settings → Connectors → Add custom connector** (above); for a local install, the config file (below) |

### Config file locations

- **Claude Desktop**: `~/Library/Application\ Support/Claude/claude_desktop_config.json` — only needed for a local (stdio) install; the hosted endpoint is added as a connector instead
- **Cursor**: `~/.cursor/mcp.json`
- **VS Code workspace**: `.vscode/mcp.json` (use `servers` instead of `mcpServers`)
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Gemini CLI**: `~/.gemini/settings.json`
- **Cline / other clients**: paste it into that client's MCP settings

## Troubleshooting

**`401` on every call.** No credential reached the server. Check the header
name — `x-api-key`, or `Authorization: Bearer` — and, if you are using
`mcp-remote`, that there is no space after the colon in `--header`.

**The tools do not appear.** Most clients read MCP config once at startup;
restart the client after editing it. If the config uses the wrong key for your
client (`url` vs `serverUrl` vs `httpUrl`), the server is never contacted at
all — see the per-client sections above.

**`406 Not Acceptable`.** The request's `Accept` header must list *both*
`application/json` and `text/event-stream`. Clients do this for you; hand-rolled
`curl` probes usually do not, and the resulting 406 looks like an auth failure.

**`400` mentioning `tools`.** A name in `?tools=` is not one this deployment
serves. The error lists the ones that are.

**A tool errors with `code=403 … beta access`.** `image_search` and
`video_search` are in Beta and enabled per account; the message says how to
request it.

**Errors name what happened.** A failed call reports which dependency failed
and why — a timeout, a connection code, an expired token and by how long — plus
Octen's own `request_id` where the API returned one. Quote that id in a support
request; it is the one an engineer can look up.

## Tools

| Tool | What it does | Best for |
|---|---|---|
| `search` | Search the live web with domain, text, language (ISO 639-1), time, and content controls | a single focused web search |
| `news_search` | Same engine as `search`, fixed to news | current events and timely reporting |
| `broad_search` | Decompose a query into up to `max_queries` sub-queries, search concurrently, return grouped results (same per-sub-query options as `search`, including the `language` filter) | research-style, multi-angle coverage |
| `extract` | Fetch 1-20 URLs and return clean content, labels, and optional highlights | summarization, RAG, fact lookup |
| `image_search` | _In Beta — contact us for beta access._ Search the web for images by text query (optional reference `image_url`) | finding pictures, photos, visual references |
| `video_search` | _In Beta — contact us for beta access._ Search the web for videos by text query | finding videos, clips, footage |

Reference docs:

- Search: [docs.octen.ai/api-reference/search](https://docs.octen.ai/api-reference/search)
- Extract: [docs.octen.ai/api-reference/extract](https://docs.octen.ai/api-reference/extract)

### Parameters

Transcribed from the schemas each tool publishes — and those are enforced, so an
out-of-contract value is refused before any call is made, with a message naming
the field. The limits track the
[API reference](https://docs.octen.ai/api-reference/search); a test fails if the
two drift apart.

`image_search` takes **exactly one** of `query`, `image_url` or `image_data`.
Every tool also accepts `timeout` (seconds) — a client-side deadline, not sent
to the API.

#### `search`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `query` | string | yes | ≤500 chars |  |
| `topic` | string |  | `general` / `news` | `"general"` |
| `count` | integer |  | 1–100 | `5` |
| `include_domains` | array |  | ≤1200 items; each ≤60 |  |
| `exclude_domains` | array |  | ≤1200 items; each ≤60 |  |
| `include_text` | array |  | ≤5 items; each ≤30 |  |
| `exclude_text` | array |  | ≤5 items; each ≤30 |  |
| `time_basis` | string |  | `auto` / `published` / `crawled` | `"auto"` |
| `time_range` | string |  | `day` / `week` / `month` / `year` / `d` / `w` / `m` / `y` |  |
| `start_time` | string |  |  |  |
| `end_time` | string |  |  |  |
| `format` | string |  | `text` / `markdown` | `"text"` |
| `safesearch` | string |  | `off` / `strict` | `"strict"` |
| `language` | array |  |  | `[]` |
| `highlight` | object |  | `enable`, `max_tokens` |  |
| `full_content` | object |  | `enable`, `max_tokens` |  |
| `include_images` | boolean |  |  | `false` |
| `timeout` | integer |  | 1–60 |  |

#### `news_search`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `query` | string | yes | ≤500 chars |  |
| `count` | integer |  | 1–100 | `5` |
| `include_domains` | array |  | ≤1200 items; each ≤60 |  |
| `exclude_domains` | array |  | ≤1200 items; each ≤60 |  |
| `include_text` | array |  | ≤5 items; each ≤30 |  |
| `exclude_text` | array |  | ≤5 items; each ≤30 |  |
| `time_basis` | string |  | `auto` / `published` / `crawled` | `"auto"` |
| `time_range` | string |  | `day` / `week` / `month` / `year` / `d` / `w` / `m` / `y` |  |
| `start_time` | string |  |  |  |
| `end_time` | string |  |  |  |
| `format` | string |  | `text` / `markdown` | `"text"` |
| `safesearch` | string |  | `off` / `strict` | `"strict"` |
| `language` | array |  |  | `[]` |
| `highlight` | object |  | `enable`, `max_tokens` |  |
| `full_content` | object |  | `enable`, `max_tokens` |  |
| `include_images` | boolean |  |  | `false` |
| `timeout` | integer |  | 1–60 |  |

#### `broad_search`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `query` | string | yes | ≤500 chars |  |
| `max_queries` | integer |  | 1–30 | `5` |
| `topic` | string |  | `general` / `news` | `"general"` |
| `count` | integer |  | 1–100 | `5` |
| `include_domains` | array |  | ≤1200 items; each ≤60 |  |
| `exclude_domains` | array |  | ≤1200 items; each ≤60 |  |
| `include_text` | array |  | ≤5 items; each ≤30 |  |
| `exclude_text` | array |  | ≤5 items; each ≤30 |  |
| `time_basis` | string |  | `auto` / `published` / `crawled` | `"auto"` |
| `time_range` | string |  | `day` / `week` / `month` / `year` / `d` / `w` / `m` / `y` |  |
| `start_time` | string |  |  |  |
| `end_time` | string |  |  |  |
| `format` | string |  | `text` / `markdown` | `"text"` |
| `safesearch` | string |  | `off` / `strict` | `"strict"` |
| `language` | array |  |  | `[]` |
| `highlight` | object |  | `enable`, `max_tokens` |  |
| `full_content` | object |  | `enable`, `max_tokens` |  |
| `include_images` | boolean |  |  | `false` |
| `timeout` | integer |  | 1–300 |  |

#### `extract`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `urls` | array | yes | ≤20 items; each ≤2048 |  |
| `query` | string |  | ≤500 chars |  |
| `max_age_seconds` | integer |  | 300–31536000 | `86400` |
| `format` | string |  | `markdown` / `text` | `"markdown"` |
| `timeout` | integer |  | 1–60 | `30` |
| `include_images` | boolean |  |  | `false` |
| `include_videos` | boolean |  |  | `false` |
| `include_audio` | boolean |  |  | `false` |

#### `image_search`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `query` | string |  | ≤500 chars |  |
| `image_url` | string |  |  |  |
| `image_data` | string |  | ≤5242880 chars |  |
| `topic` | string |  | `general` / `design` | `"general"` |
| `count` | integer |  | 1–10 | `5` |
| `include_domains` | array |  |  |  |
| `exclude_domains` | array |  |  |  |
| `safesearch` | string |  | `off` / `strict` | `"strict"` |
| `html_snippet` | object |  | `enable`, `max_tokens` |  |
| `timeout` | integer |  | 1–60 |  |

#### `video_search`

| Parameter | Type | Required | Limits | Default |
|---|---|---|---|---|
| `query` | string | yes | ≤500 chars |  |
| `count` | integer |  | 1–10 | `5` |
| `time_range` | string |  | `day` / `week` / `month` / `year` / `d` / `w` / `m` / `y` |  |
| `start_time` | string |  |  |  |
| `end_time` | string |  |  |  |
| `safesearch` | string |  | `off` / `strict` | `"strict"` |
| `timeout` | integer |  | 1–60 |  |

### Keep the tools always on (optional)

In clients with **MCP tool search** enabled (the Claude Code default), tools are
*deferred* — the model runs a `ToolSearch` step to load them on demand. If you'd
rather have the Octen tools resident from the first turn (no discovery step), set
`alwaysLoad` on the server in your `.mcp.json` (Claude Code v2.1.121+):

```jsonc
{
  "mcpServers": {
    "octen": {
      "command": "npx",
      "args": ["-y", "octen-mcp"],
      "env": { "OCTEN_API_KEY": "your-key-here" },
      "alwaysLoad": true
    }
  }
}
```

Each always-loaded tool uses context on every turn, and `alwaysLoad` blocks startup
until the server connects (capped at the ~5s connect timeout), so reserve it for tools
you hit constantly. To keep the cost down, mark just the highest-traffic tools — e.g.
`search` and `broad_search` — with `"anthropic/alwaysLoad": true` in each tool's `_meta`,
leaving the rest deferred.

## Why agents like this

Most extract tools stop at "here is the page body." Octen helps one step earlier:

- **Skip bad pages early**: `page_structure.primary == "No Main Content"` tells the agent it hit a login wall, empty shell, or similar non-content page.
- **Filter by topic early**: `category` helps a pipeline ignore pages outside the target vertical before embedding or summarizing.
- **Use less context**: `query` returns `highlights` when the user wants a specific fact instead of the full page.

For the full decision tree and integration patterns, see [docs/best-practices.md](docs/best-practices.md).

## Example prompts

- `Fetch octen.ai and summarize the main product features.`
- `Search for recent MCP news from the last week.`
- `Fetch these URLs and only summarize the ones whose category is Finance.`
- `Search site:docs.anthropic.com prompt caching and return only the relevant highlights.`

## Self-hosting the HTTP server

The hosted endpoint above runs this same code; you can run it yourself instead:

```bash
PORT=8080 npx -y -p octen-mcp octen-mcp-http   # or: octen-mcp-http after a global install
```

Endpoints: `POST /mcp` (stateless Streamable HTTP) and `GET /healthz`. Stateless
by design — there is no session to lose, so scaling is a matter of running more
copies behind a load balancer. Credentials travel per request and never come
from the server's own environment: a request without one fails rather than
quietly spending the host's key.

**Authorization is off unless you configure it.** Set both
`OCTEN_OAUTH_AUTHORIZATION_SERVER` and `OCTEN_MCP_RESOURCE` and the server
advertises RFC 9728 protected-resource metadata and answers uncredentialed
requests with a `401` challenge. Leave them unset and it advertises nothing —
an instance should never point clients at an authorization server it does not
have — and a missing key surfaces at call time instead.

**Argument validation.** Each tool's declared `inputSchema` is enforced, not
just advertised: types, ranges, string lengths, array sizes, enums, required
parameters, and the property list itself. An out-of-contract call is refused
with a message naming the field, before anything is sent to the API.

**Sending an image as base64.** `image_search` accepts `image_data` up to 5MB
encoded, which travels inside the JSON-RPC body. `OCTEN_MCP_MAX_BODY` defaults
to 6 MiB to make that work unconfigured; `OCTEN_MCP_MAX_INFLIGHT_BODY` (24 MiB)
separately bounds what all in-flight bodies hold at once, since a per-request
cap does nothing about many concurrent ones.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OCTEN_API_KEY` | yes | — | |
| `OCTEN_API_URL` | no | `https://api.octen.ai` | |
| `OCTEN_ENABLE_BETA_TOOLS` | no | on | Set to `false`/`0`/`off`/`no` to hide the Beta `image_search` / `video_search` tools from discovery. |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | no | — | Honoured since 0.4.0. Node's built-in `fetch` ignores these by default, so before 0.4.0 the server could not reach the API from behind a proxy even when every other tool on the machine could. **Set them explicitly in your client config** — see below; most MCP clients do not pass your shell environment through. |
| `OCTEN_KEEP_ALIVE_MS` | no | `60000` | How long an idle connection is kept for reuse. undici's own default of 4s meant nearly every call re-paid a full TLS handshake (~515ms measured). 60s is measured against `api.octen.ai`, which closes idle connections between 60s and 90s — staying under that means we always release first, instead of dispatching onto a socket the origin has already closed. Re-measure if you point `OCTEN_API_URL` elsewhere. |
| `OCTEN_KEEP_ALIVE_MAX_MS` | no | `600000` | Upper bound on the above when the origin advertises its own `Keep-Alive` hint. `api.octen.ai` does not send one. |
| `OCTEN_CONNECT_TIMEOUT_MS` | no | `10000` | Ceiling on **establishing the outbound connection to `api.octen.ai`** — unrelated to the MCP client's own startup connect timeout mentioned above. Lower it (e.g. `5000`) on a path where connections fail intermittently, so the automatic retry engages sooner. |
| `OCTEN_RETRY` | no | on | Set to `false`/`0`/`off`/`no` to disable the single automatic retry on connection-level failures. Retries cost quota when the original request had in fact reached the server. |
| `OCTEN_HTTP2` | no | off | Opt into HTTP/2. Measured no faster for the usual one-request-at-a-time pattern, and not reliable through every CONNECT proxy — worth trying if you issue many tool calls in parallel. |
| `OCTEN_MCP_DEBUG` | no | off | Request tracing on **stderr** (stdout carries MCP framing). See below. |

### Remote HTTP form only

These are read only by `octen-mcp-http`; the stdio entry ignores them.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | `0` picks an ephemeral port. |
| `OCTEN_MCP_LOG` | no | human text | `json` emits one JSON object per event, for a log pipeline. |
| `OCTEN_MCP_MAX_BODY` | no | `6291456` | Per-request body cap, in bytes, enforced on bytes received. Over it: `413`. Sized so `image_search`'s `image_data` (5MB encoded) works unconfigured; turn it down if this deployment never sends images. |
| `OCTEN_MCP_MAX_INFLIGHT_BODY` | no | `25165824` | Ceiling on the total bytes all in-flight bodies hold at once. The per-request cap stops one huge request; this stops many ordinary ones. Over it: `503` + `Retry-After`. Measured: resident cost runs about ten times this, because a base64 body exists two or three times over as a UTF-16 string. |
| `OCTEN_MCP_BODY_DRAIN_MS` | no | `2000` | After a `413`, how long to keep discarding the rest of the body so the `413` itself gets delivered. |
| `OCTEN_DRAIN_TIMEOUT_MS` | no | `310000` | On `SIGTERM`, how long in-flight calls may finish. Must stay below the pod's `terminationGracePeriodSeconds`, and above the longest tool budget (`broad_search`, 300s). |

**OAuth.** Off unless both of the first two are set, so an instance never
advertises an authorization server it does not have.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OCTEN_OAUTH_AUTHORIZATION_SERVER` | for OAuth | — | Authorization server base URL. Compared byte-for-byte against the token's `iss`, and used to build the JWKS URL — **no trailing slash**; the process refuses to start with one, because it would reject every token. |
| `OCTEN_MCP_RESOURCE` | for OAuth | — | This deployment's public URL, e.g. `https://mcp.example.com/mcp`. Compared byte-for-byte against the token's `aud` (RFC 8707), so a stray trailing slash fails every call. Cannot be inferred behind a proxy, hence explicit. |
| `OCTEN_OAUTH_RESOLVE_URL` | for OAuth | — | Internal endpoint that exchanges a grant for an API key. Must be reachable privately; a public address will not serve it. |
| `OCTEN_OAUTH_RESOLVE_TOKEN` | for OAuth | — | Shared secret sent to that endpoint as `X-Octen-Service-Token`. |
| `OCTEN_OAUTH_RESOLVE_CACHE_TTL_MS` | no | `60000` | How long a resolved grant is reused. This is the revocation-propagation window: a token revoked now keeps working for up to this long. `0` resolves on every call, at the cost of putting that service in front of every tool call. |
| `OCTEN_JWKS_REFETCH_COOLDOWN_MS` | no | `10000` | Floor between JWKS refetches triggered by an unknown key id. The trigger is an unverified token header, so without a floor each such request becomes one request to the authorization server. Lowering it widens that by the same ratio. |

### Setting these in Claude Desktop (and where the logs go)

MCP servers do not inherit your shell environment. Claude Desktop spawns them
with `HOME`, `LOGNAME`, `PATH`, `SHELL` and `USER` — and nothing else except what
you put in the server's `env` block. **A proxy configured system-wide will not be
picked up**; it has to be named explicitly, alongside the API key:

```json
{
  "mcpServers": {
    "octen": {
      "command": "npx",
      "args": ["-y", "octen-mcp"],
      "env": {
        "OCTEN_API_KEY": "your-key-here",
        "HTTPS_PROXY": "http://proxy.example:8080"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config — it reads it at launch.

Server output lands in:

- **macOS**: `~/Library/Logs/Claude/mcp-server-octen.log`
- **Windows**: `%APPDATA%\Claude\logs\mcp-server-octen.log`

Everything the server writes to stderr, including the tracing below, goes there.

### Diagnosing a slow or failing call

Add `"OCTEN_MCP_DEBUG": "1"` to the `env` block above while you are investigating,
and **take it out afterwards** — the client appends this to a log file that is
never rotated, so leaving it on grows that file for the life of the install.

With it on, every call is traced to stderr:

```
[octen-mcp 2026-08-14T04:36:36.219Z] call #1 received tool=search
[octen-mcp 2026-08-14T04:36:36.637Z] connect #1 established to api.octen.ai in 410ms peer=203.0.113.10:443 tls=TLSv1.3 alpn=http/1.1
[octen-mcp 2026-08-14T04:36:37.155Z] /search attempt=1 status=200 elapsed=935ms socket=new request_id=42cd56a5-…
[octen-mcp 2026-08-14T04:36:37.157Z] call #1 returning tool=search handler_total=938ms
```

Each field answers a specific question:

- **`call #N received` timestamp** — when the call reached this process. Subtract it
  from the time your MCP client issued the tool call: the difference is time spent
  entirely outside `octen-mcp`, in the host or in whatever relays between them. A
  client-side stopwatch alone cannot separate that from time we are responsible for.
- **`connect … established in Xms`** — a handshake happened, and what it cost.
  `connect FAILED` names the phase and error code instead.
- **`peer=` / `tls=` / `alpn=`** — which address the connection actually reached
  (the API hostname is anycast, so the hostname alone cannot tell you which
  edge), and the negotiated TLS version and protocol — a mismatch there
  otherwise presents as an unexplained slow or failed handshake.
- **`socket=new` / `socket=reused`** — whether this call paid for a handshake. This
  is the difference between "the service is slow" and "the connection was thrown
  away between calls".
- **`elapsed`** vs **`handler_total`** — time in the HTTP request vs time in the tool
  handler. A large gap means the cost is in request assembly or response formatting,
  not the network.
- **`request_id`** — in *this trace only*: the client-generated correlation id,
  stable across the retry, tying a call's attempts together. It never appears in
  user-facing error messages, deliberately: Octen support cannot look it up (the
  gateway does not record the header), and an id labelled `request_id` reads
  like one they could. Error messages carry only ids verified searchable on
  Octen's side — today that is exactly one: the server's own `request_id` from
  an API error envelope.

Failures name the cause rather than `fetch failed`:

```
Network error calling Octen Search: code=ECONNREFUSED cause=connect ECONNREFUSED 203.0.113.9:443
address=203.0.113.9:443 — could not establish a connection.
If this machine requires an HTTP proxy, set HTTPS_PROXY.
```

`UND_ERR_CONNECT_TIMEOUT` means the connection was never established, `ECONNRESET`
means it was established and then torn down, and `ENOTFOUND` means DNS — three
different problems with three different owners.

Request timeouts: `search` and the media tools default to 30s, `broad_search` to 120s (raisable to 300s),
and `extract` to its per-URL budget plus headroom. The search tools accept a
`timeout` parameter to override; `extract`'s `timeout` is the *server-side,
per-URL* fetch budget, so the client ceiling is derived from it rather than
equal to it. The automatic retry draws down the same deadline as the first
attempt, so the stated timeout bounds the whole call, retry included.

## Local development

```bash
git clone https://github.com/Octen-Team/octen-mcp.git
cd octen-mcp
npm install
npm run build
OCTEN_API_KEY=<key> npm run inspect
```

## More docs

- Best practices for agent integration: [docs/best-practices.md](docs/best-practices.md)
- Search API reference: [docs.octen.ai/api-reference/search](https://docs.octen.ai/api-reference/search)
- Extract API reference: [docs.octen.ai/api-reference/extract](https://docs.octen.ai/api-reference/extract)

## License

[MIT](LICENSE) © Octen
