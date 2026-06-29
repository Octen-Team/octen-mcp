/**
 * `search` tool — wraps Octen Search API (https://docs.octen.ai/api-reference/search).
 *
 * Surfaced to the LLM as a web-search tool. Differentiators worth advertising:
 *  - `topic` (general | news) — switch between broad web and news-focused search
 *  - per-result `highlight` (ranked snippet) OR `full_content` (cleaned page body),
 *    each with a token budget so the model controls how much context it pulls back
 *  - domain / text include-exclude filters and a published/crawled time window
 *    (absolute `start_time`/`end_time` or relative `time_range`)
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as extract, but
 * note `meta` sits at the TOP level here (sibling of `data`), not under `data`.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_API_BASE = process.env.OCTEN_API_URL ?? "https://api.octen.ai";
const API_KEY = process.env.OCTEN_API_KEY;

/** Tool advertisement — clients see this in the list-tools response. */
export const searchTool: Tool = {
  name: "search",
  description:
    "Search the live web with Octen and return ranked results (title, url, " +
    "snippet). Set `topic` to `news` for news-focused results. Pass `highlight` " +
    "to get a ranked snippet per result, or `full_content` to pull the cleaned " +
    "page body inline (heavier — costs more context). Narrow with domain / text " +
    "include-exclude filters and a time window (published/crawled `start_time`/" +
    "`end_time`, or a relative `time_range`). Set `include_images` / `include_videos` " +
    "to return media URLs per result.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description: "Search query. Max 500 chars.",
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
        default: "general",
        description:
          "Search category: `general` for broad web search, `news` for " +
          "news-focused results. Default general.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 5,
        description: "Number of results to return (1-100). Default 5.",
      },
      include_domains: {
        type: "array",
        items: { type: "string", maxLength: 30 },
        maxItems: 1000,
        description: "Only return results from these domains (e.g. 'arxiv.org'). Max 1000, each ≤30 chars.",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string", maxLength: 30 },
        maxItems: 150,
        description: "Drop results from these domains. Max 150, each ≤30 chars.",
      },
      include_text: {
        type: "array",
        items: { type: "string", maxLength: 30 },
        maxItems: 5,
        description: "Only return results whose content contains all of these strings. Max 5, each ≤30 chars.",
      },
      exclude_text: {
        type: "array",
        items: { type: "string", maxLength: 30 },
        maxItems: 5,
        description: "Drop results whose content contains any of these strings. Max 5, each ≤30 chars.",
      },
      time_basis: {
        type: "string",
        enum: ["auto", "published", "crawled"],
        default: "auto",
        description:
          "Which timestamp the time window filters against: page `published` " +
          "date, last `crawled` date, or `auto`. Default auto.",
      },
      time_range: {
        type: "string",
        enum: ["day", "week", "month", "year", "d", "w", "m", "y"],
        description:
          "Relative time window (e.g. `week`, `month`). Mutually exclusive with " +
          "`start_time`/`end_time` — if both are given, the absolute range wins.",
      },
      start_time: {
        type: "string",
        description: "Lower bound for the time window, ISO 8601 (e.g. '2025-01-01T00:00:00Z').",
      },
      end_time: {
        type: "string",
        description: "Upper bound for the time window, ISO 8601.",
      },
      format: {
        type: "string",
        enum: ["text", "markdown"],
        default: "text",
        description: "Format of returned content. Default text.",
      },
      safesearch: {
        type: "string",
        enum: ["off", "strict"],
        default: "strict",
        description: "Adult-content filter. Default strict.",
      },
      highlight: {
        type: "object",
        description:
          "Return a ranked highlighted snippet per result. Omit to use the server default.",
        properties: {
          enable: { type: "boolean", default: true, description: "Whether to return highlights." },
          max_tokens: {
            type: "integer",
            minimum: 100,
            maximum: 20000,
            default: 512,
            description: "Max tokens per highlight snippet (100-20000).",
          },
        },
      },
      full_content: {
        type: "object",
        description:
          "Return the cleaned full page body per result. Heavier than `highlight` — " +
          "use only when the snippet isn't enough. Omit to use the server default (off).",
        properties: {
          enable: { type: "boolean", default: false, description: "Whether to return full content." },
          max_tokens: {
            type: "integer",
            minimum: 100,
            maximum: 100000,
            default: 2048,
            description: "Max tokens of full content per result (100-100000).",
          },
        },
      },
      include_images: {
        type: "boolean",
        default: false,
        description: "Return image URLs (and a cover image) found on each result page.",
      },
      include_videos: {
        type: "boolean",
        default: false,
        description: "Return video URLs found on each result page.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        description: "Request timeout in seconds (1-60).",
      },
    },
    required: ["query"],
  },
};

/**
 * `news_search` tool — Octen Search locked to `topic: "news"`.
 *
 * Same engine as `search`, but purpose-built so the model reaches for it when the
 * user wants news without having to remember to pass `topic="news"`. Schema is
 * derived from `searchTool` minus the `topic` field, so it stays in sync as the
 * search params evolve.
 */
const { topic: _omitTopic, ...newsProperties } =
  (searchTool.inputSchema as any).properties as Record<string, object>;

export const newsSearchTool: Tool = {
  name: "news_search",
  description:
    "Search recent news with Octen and return ranked articles (title, url, " +
    "snippet). This is web search locked to `topic: news` — use it for current " +
    "events, headlines, and timely reporting. Same options as `search` " +
    "(domain / text filters, time window, highlight / full_content, media) " +
    "except `topic`, which is fixed to news.",
  inputSchema: {
    type: "object",
    properties: newsProperties,
    required: ["query"],
  },
};

interface HighlightOptions {
  enable?: boolean;
  max_tokens?: number;
}

interface FullContentOptions {
  enable?: boolean;
  max_tokens?: number;
}

interface SearchArgs {
  query: string;
  topic?: "general" | "news";
  count?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_text?: string[];
  exclude_text?: string[];
  time_basis?: "auto" | "published" | "crawled";
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_time?: string;
  end_time?: string;
  format?: "text" | "markdown";
  safesearch?: "off" | "strict";
  highlight?: HighlightOptions;
  full_content?: FullContentOptions;
  include_images?: boolean;
  include_videos?: boolean;
  timeout?: number;
}

/** Handler — POSTs to Octen Search and reshapes the response for the LLM. */
export async function handleSearch(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const args = rawArgs as unknown as SearchArgs;

  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return errorResult("`query` must be a non-empty string");
  }
  if (!API_KEY) {
    return errorResult(
      "OCTEN_API_KEY env var is not set. Get a key at https://octen.ai " +
      "and add it to your MCP client config (see README)."
    );
  }

  // `timeout` is an HTTP-client concern, not part of the search payload.
  const { timeout, ...payloadArgs } = args;

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { query: payloadArgs.query };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (key !== "query" && value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await fetch(`${DEFAULT_API_BASE}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout * 1000) : undefined,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") {
      return errorResult(`Octen Search timed out after ${timeout}s`);
    }
    return errorResult(`Network error calling Octen Search: ${err.message}`);
  }

  // Octen returns the envelope even on errors (code: 401, 429, etc.),
  // so we read the body regardless of HTTP status.
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return errorResult(`Octen Search returned non-JSON (HTTP ${resp.status})`);
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  // Unlike extract, search puts `meta` at the top level (sibling of `data`).
  const results = data?.data?.results ?? [];
  const meta = data?.meta ?? {};
  const total = results.length;

  if (total === 0) {
    return { content: [{ type: "text", text: `No results for "${args.query}".` }] };
  }

  const blocks = results.map((r: any, i: number) => formatResult(r, i + 1, total));
  const metaLine = formatMeta(meta, data?.request_id);
  const text = [...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}

/** Handler — news search. Forces `topic=news`, ignoring any caller-supplied topic. */
export async function handleNewsSearch(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const { topic: _ignored, ...rest } = rawArgs ?? {};
  return handleSearch({ ...rest, topic: "news" });
}

function formatResult(r: any, idx: number, total: number): string {
  const lines: string[] = [`## Result ${idx}/${total}: ${r.title ?? "(untitled)"}`];
  if (r.url) lines.push(r.url);
  if (r.authors) lines.push(`**Authors:** ${r.authors}`);
  if (r.time_published) lines.push(`**Published:** ${r.time_published}`);
  if (r.time_last_crawled) lines.push(`**Last crawled:** ${r.time_last_crawled}`);
  if (r.favicon) lines.push(`**Favicon:** ${r.favicon}`);
  if (r.cover_image) lines.push(`**Cover image:** ${r.cover_image}`);
  if (Array.isArray(r.images) && r.images.length) lines.push(`**Images:** ${r.images.length}`);
  if (Array.isArray(r.videos) && r.videos.length) lines.push(`**Videos:** ${r.videos.length}`);

  if (typeof r.highlight === "string" && r.highlight.length > 0) {
    lines.push(`\n### Highlight\n${r.highlight}`);
  }
  if (typeof r.full_content === "string" && r.full_content.length > 0) {
    lines.push(`\n### Content\n${r.full_content}`);
  }

  return lines.join("\n");
}

export function formatMeta(meta: any, requestId: string | undefined): string {
  const parts: string[] = [];
  const u = meta?.usage;
  if (u && typeof u === "object") {
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === "number") parts.push(`${k}: ${v}`);
    }
  }
  const lat = meta?.latency;
  if (typeof lat === "number") parts.push(`latency_ms: ${lat}`);
  else if (lat && typeof lat === "object" && typeof lat.total === "number") parts.push(`latency_ms: ${lat.total}`);
  if (meta?.warning) parts.push(`warning: ${meta.warning}`);
  if (requestId) parts.push(`request_id: ${requestId}`);
  return parts.length ? `_${parts.join(" · ")}_` : "";
}

export function errorResult(msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
