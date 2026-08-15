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
- **`image_search`** (In Beta — contact us for beta access): search the web for images by text query, optionally with a reference image.
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

[![Install in VS Code](https://img.shields.io/badge/Install%20in-VS%20Code-007ACC?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=octen&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Octen%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22octen-mcp%22%5D%2C%22env%22%3A%7B%22OCTEN_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/Install%20in-VS%20Code%20Insiders-24bfa5?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=octen&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Octen%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22octen-mcp%22%5D%2C%22env%22%3A%7B%22OCTEN_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D&quality=insiders)

For most MCP clients, the config is:

```json
{
  "mcpServers": {
    "octen": {
      "command": "npx",
      "args": ["-y", "octen-mcp"],
      "env": {
        "OCTEN_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Install command by client

| Agent | One-line install |
|--|--|
| Claude Code | `claude mcp add --scope user octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| Codex | `codex mcp add octen --env OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| Gemini CLI | `gemini mcp add octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp` |
| VS Code | `code --add-mcp '{"name":"octen","command":"npx","args":["-y","octen-mcp"],"env":{"OCTEN_API_KEY":"your-key-here"}}'` (or click a badge above) |
| Cursor | [Add to Cursor](https://cursor.com/en/install-mcp?name=octen&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9jdGVuLW1jcCJdLCJlbnYiOnsiT0NURU5fQVBJX0tFWSI6InlvdXIta2V5LWhlcmUifX0%3D) (then edit the key), or use the JSON above in `~/.cursor/mcp.json` |
| Claude Desktop | No CLI — add the JSON above to the config file (see below) |

### Config file locations

For clients without a CLI installer, drop the JSON config above into:

- **Claude Desktop**: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
- **Cursor**: `~/.cursor/mcp.json`
- **VS Code workspace**: `.vscode/mcp.json` (use `servers` instead of `mcpServers`)
- **Windsurf / Cline / other clients**: paste it into that client's MCP settings

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
[octen-mcp 2026-08-14T04:36:36.637Z] connect #1 established to api.octen.ai in 410ms
[octen-mcp 2026-08-14T04:36:37.155Z] /search attempt=1 status=200 elapsed=935ms socket=new request_id=42cd56a5-… x-azure-ref=20260814T043636Z-16d98fb8cd8…
[octen-mcp 2026-08-14T04:36:37.157Z] call #1 returning tool=search handler_total=938ms
```

Each field answers a specific question:

- **`call #N received` timestamp** — when the call reached this process. Subtract it
  from the time your MCP client issued the tool call: the difference is time spent
  entirely outside `octen-mcp`, in the host or in whatever relays between them. A
  client-side stopwatch alone cannot separate that from time we are responsible for.
- **`connect … established in Xms`** — a handshake happened, and what it cost.
  `connect FAILED` names the phase and error code instead.
- **`socket=new` / `socket=reused`** — whether this call paid for a handshake. This
  is the difference between "the service is slow" and "the connection was thrown
  away between calls".
- **`elapsed`** vs **`handler_total`** — time in the HTTP request vs time in the tool
  handler. A large gap means the cost is in request assembly or response formatting,
  not the network.
- **`x-azure-ref`** — stamped by the edge on every request that reaches it, and
  already present in Octen's own logs. Quote it in a support report. Its *absence*
  on a failure is itself informative: the request never arrived.
- **`request_id`** — a correlation id, and its *format* tells you which system can
  look it up. A UUID (with dashes, e.g. `d6ad2a98-…`) is client-generated: it appears
  when the request never produced an Octen response (network errors, timeouts,
  body-read failures) and ties the error to the retry attempts in this trace. A
  20+-char id starting with a timestamp (e.g. `20260814053244…`) came from Octen's
  server inside an API error envelope — quote that one to Octen support, it is
  directly searchable in service logs.

Failures name the cause rather than `fetch failed`:

```
Network error calling Octen Search: code=ECONNREFUSED cause=connect ECONNREFUSED 203.0.113.9:443
address=203.0.113.9:443 request_id=d6ad2a98-… — could not establish a connection.
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
