# octen-mcp

[![npm version](https://img.shields.io/npm/v/octen-mcp.svg?color=blue)](https://www.npmjs.com/package/octen-mcp)
[![npm downloads](https://img.shields.io/npm/dm/octen-mcp.svg)](https://www.npmjs.com/package/octen-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/Octen-Team/octen-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Octen-Team/octen-mcp/actions/workflows/ci.yml)

MCP server for **Octen**. Plug it into Claude, Cursor, VS Code, Windsurf, or any MCP client to give your agent live web search and URL extraction.

Core capabilities:

- **`search` / `news_search`**: search the live web with domain, text, and time filters.
- **`extract`**: turn one or more URLs into clean, LLM-ready content.

What makes Octen useful for agents is that `extract` returns more than page text. Each successful result also includes:

- **`category`**: what the page is about
- **`page_structure`**: what kind of page it is
- **`highlights`**: ranked snippets when you pass a `query`

That lets an agent skip login walls, nav pages, and off-topic URLs before spending tokens on the full body.

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

**Claude Code**

```bash
claude mcp add --scope user octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp
```

**Codex**

```bash
codex mcp add octen --env OCTEN_API_KEY=your-key-here -- npx -y octen-mcp
```

**Gemini CLI**

```bash
gemini mcp add octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp
```

**VS Code** (or click a badge above)

```bash
code --add-mcp '{"name":"octen","command":"npx","args":["-y","octen-mcp"],"env":{"OCTEN_API_KEY":"your-key-here"}}'
```

**Cursor** — [Add to Cursor](https://cursor.com/en/install-mcp?name=octen&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9jdGVuLW1jcCJdLCJlbnYiOnsiT0NURU5fQVBJX0tFWSI6InlvdXIta2V5LWhlcmUifX0%3D) (edit the key afterwards), or use the JSON above in `~/.cursor/mcp.json`.

### Config file locations

For clients without a CLI installer, drop the JSON config above into:

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Cursor**: `~/.cursor/mcp.json`
- **VS Code workspace**: `.vscode/mcp.json` (use `servers` instead of `mcpServers`)
- **Windsurf / Cline / other clients**: paste it into that client's MCP settings

## Tools

| Tool | What it does | Best for |
|---|---|---|
| `search` | Search the live web with domain, text, time, and content controls | broad web search |
| `news_search` | Same engine as `search`, fixed to news | current events and timely reporting |
| `extract` | Fetch 1-20 URLs and return clean content, labels, and optional highlights | summarization, RAG, fact lookup |

Reference docs:

- Search: [docs.octen.ai/api-reference/search](https://docs.octen.ai/api-reference/search)
- Extract: [docs.octen.ai/api-reference/extract](https://docs.octen.ai/api-reference/extract)

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

| Variable | Required | Default |
|---|---|---|
| `OCTEN_API_KEY` | yes | — |
| `OCTEN_API_URL` | no | `https://api.octen.ai` |

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
