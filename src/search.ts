/**
 * `search` tool — wraps Octen Search API (https://docs.octen.ai/api-reference/search).
 *
 * Surfaced to the LLM as a web-search tool. Differentiators worth advertising:
 *  - `topic` (general | news) — switch between broad web and news-focused search
 *  - per-result `highlight` (ranked snippet) OR `full_content` (cleaned page body),
 *    each with a token budget so the model controls how much context it pulls back
 *  - domain / text include-exclude filters, a `language` filter (ISO 639-1
 *    codes), and a published/crawled time window
 *    (absolute `start_time`/`end_time` or relative `time_range`)
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as extract, but
 * note `meta` sits at the TOP level here (sibling of `data`), not under `data`.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { postJson, OctenHttpError } from "./http.js";

const API_KEY = process.env.OCTEN_API_KEY;

/**
 * Client-side ceilings applied when the caller passes no `timeout`. Before
 * 0.4.0 an omitted `timeout` meant *no* AbortSignal at all, so a stalled
 * request sat on undici's 300s `headersTimeout` and the agent simply hung.
 * Broad search fans out server-side, so it gets the longer budget.
 */
const SEARCH_TIMEOUT_SEC = 30;
/**
 * Broad search fans out server-side into up to `max_queries` sub-searches, and
 * the tool itself recommends 20-30 for an exhaustive survey. Before 0.4.0 an
 * omitted `timeout` meant no client deadline at all, so such a call had undici's
 * 300s to finish; capping it at the 60s the `timeout` parameter allowed would
 * have failed calls that used to succeed, with no way for the caller to ask for
 * more. The client budget is therefore larger than the parameter's own range,
 * and the range itself is widened below so there is an escape hatch.
 */
const BROAD_SEARCH_TIMEOUT_SEC = 120;
const BROAD_SEARCH_TIMEOUT_MAX_SEC = 300;

/** Tool advertisement — clients see this in the list-tools response. */
export const searchTool: Tool = {
  name: "search",
  description:
    `Search the live web and return ranked results (title, url, snippet) — fast, fresh, real-time web search for one focused lookup. Set \`topic\` to \`news\` for news-focused results. Pass \`highlight\` to get a ranked snippet per result, or \`full_content\` to pull the cleaned page body inline (heavier — costs more context). Narrow with domain / text include-exclude filters, a \`language\` filter (ISO 639-1 codes), and a time window (published/crawled \`start_time\`/\`end_time\`, or a relative \`time_range\`). Set \`include_images\` / \`include_videos\` to return media URLs per result.

USE FOR a single focused lookup: one fact, one entity, one document. If the question spans several independent subtopics, load and use \`broad_search\` instead — a sequence of search calls is slower and gives worse coverage than one fan-out. To read a page you already have the URL for, use \`extract\`.

keywords: web search, search the web, look up, find, check, fact, current information, latest, news, source, url, real-time`,
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
      language: {
        type: "array",
        items: {
          type: "string",
          enum: ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pl", "pt", "ru", "th", "tr", "vi", "zh"],
        },
        default: [],
        description: "Languages to filter results by, as ISO 639-1 codes. Empty = no filter.",
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
        description: "Request timeout in seconds (1-60). Defaults to 30s if unset.",
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
    `Search recent news and return ranked articles (title, url, snippet) — current events, headlines, timely reporting. This is \`search\` locked to \`topic: news\`; same options as \`search\` (domain / text filters, \`language\` filter, time window, highlight / full_content, media) except \`topic\`, which is fixed to news.

For a single news lookup this is the right tool. For a multi-angle news question ("what shipped across the industry this month", "how are different outlets covering X"), use \`broad_search\` with topic=news instead of looping news_search.

keywords: news search, latest news, headlines, current events, breaking news, recent, today, this week, press coverage`,
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
  language?: string[];
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
    resp = await postJson({
      path: "/search",
      body,
      label: "Octen Search",
      timeoutSec: timeout,
      defaultTimeoutSec: SEARCH_TIMEOUT_SEC,
    });
  } catch (e) {
    if (e instanceof OctenHttpError) return errorResult(e.message);
    throw e;
  }

  // Octen returns the envelope even on errors (code: 401, 429, etc.),
  // so we read the body regardless of HTTP status.
  let data: any;
  try {
    data = await resp.json();
  } catch (e) {
    // The deadline also governs body consumption: a response whose headers
    // arrived but whose body stalls aborts HERE, not in the fetch above, and
    // must be reported as the timeout it is — not as a malformed response.
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
      return errorResult(`Octen Search timed out while reading the response body (HTTP ${resp.status})`);
    }
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

/**
 * `broad_search` tool — wraps Octen Broad Search (POST /broad-search).
 *
 * Decomposes the query into up to `max_queries` related sub-queries, runs them
 * concurrently, and returns results grouped per sub-query (not deduplicated).
 * Params are flattened: the same per-result options as `search` plus
 * `max_queries`; the handler nests the search options under `search_options`
 * before POSTing.
 */
const { timeout: _omitBroadTimeout, ...broadBaseProperties } =
  (searchTool.inputSchema as any).properties as Record<string, object>;
const { query: broadQueryProp, ...broadOptionProperties } = broadBaseProperties;

export const broadSearchTool: Tool = {
  name: "broad_search",
  description:
    `Search the web across many angles in one call — for comparisons, research, surveys, and questions with several distinct parts. Expands your question into multiple sub-queries and runs them concurrently.

USE WHEN the question has multiple distinct parts or entities that one search cannot cover:
  - comparing vendors / products / pricing across many sources
  - literature reviews, market or landscape surveys
  - open-ended "what are the options for X" / "how do people solve Y"
  - a question that clearly decomposes into 3+ independent sub-questions
  - multi-angle questions about recent events ("what shipped across the industry this month") — set topic=news, do NOT loop news_search

DO NOT USE for:
  - a single fact, entity, or document → use \`search\`
  - re-running a disappointing search → do NOT call broad_search twice; follow up with a targeted \`search\` or \`extract\` on the specific gaps
  - reading a page you already have the URL for → use \`extract\`
  - a straight A-vs-B comparison of two known entities → two targeted \`search\` calls are cheaper and more controllable

COST: fans out into \`max_queries\` concurrent searches — roughly Nx the cost and notably higher latency than a single \`search\`. When in doubt, prefer \`search\`.

QUERY: pass one natural-language question (max 500 chars). Resolve pronouns and references from the conversation first — "how does it compare to the other one" is a useless query. Do NOT pre-split into sub-queries; that is this tool's job. For broader coverage raise \`max_queries\` rather than calling repeatedly. Per-sub-query options (count, topic, \`language\` filter, domain / text filters, time window, highlight / full_content, media) match \`search\` and apply to every sub-query.

RESULTS are grouped per sub-query and NOT deduplicated — the same URL may appear under several sub-queries.

max_queries: 3-5 focused comparison (2-3 entities) | 5-10 multi-facet research | 10-20 landscape scan | 20-30 exhaustive survey

For a single focused lookup use \`search\`; to read a specific page use \`extract\`.

keywords: web search, search the web, look up, find information, research, compare, comparison, versus, alternatives, options, landscape, survey, market research, pricing, latest, current information, multi-part question`,
  inputSchema: {
    type: "object",
    properties: {
      query: broadQueryProp,
      max_queries: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        default: 5,
        description:
          "Upper bound on the number of sub-queries generated (1-30). Default 5 — " +
          "raise toward 30 for surveys / deeper research, lower for a tighter search.",
      },
      ...broadOptionProperties,
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 300,
        description:
          "Request timeout in seconds (1-300). Defaults to 120s if unset. " +
          "Raise it for large `max_queries` surveys, which legitimately take longer.",
      },
    },
    required: ["query"],
  },
};

interface BroadSearchArgs extends SearchArgs {
  max_queries?: number;
}

/** Handler — POSTs to Octen Broad Search and reshapes the grouped response. */
export async function handleBroadSearch(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const args = rawArgs as unknown as BroadSearchArgs;

  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return errorResult("`query` must be a non-empty string");
  }
  if (!API_KEY) {
    return errorResult(
      "OCTEN_API_KEY env var is not set. Get a key at https://octen.ai " +
      "and add it to your MCP client config (see README)."
    );
  }

  // `timeout` is an HTTP-client concern; `query` and `max_queries` stay at the
  // top level, everything else is nested under `search_options`.
  const { timeout, max_queries, query, ...rest } = args;
  const searchOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) searchOptions[key] = value;
  }

  const body: Record<string, unknown> = { query };
  if (max_queries !== undefined) body.max_queries = max_queries;
  if (Object.keys(searchOptions).length > 0) body.search_options = searchOptions;

  let resp: Response;
  try {
    resp = await postJson({
      path: "/broad-search",
      body,
      label: "Octen Broad Search",
      timeoutSec: timeout,
      defaultTimeoutSec: BROAD_SEARCH_TIMEOUT_SEC,
      canRaiseTimeout: BROAD_SEARCH_TIMEOUT_SEC < BROAD_SEARCH_TIMEOUT_MAX_SEC,
    });
  } catch (e) {
    if (e instanceof OctenHttpError) return errorResult(e.message);
    throw e;
  }

  let data: any;
  try {
    data = await resp.json();
  } catch (e) {
    // The deadline also governs body consumption: a response whose headers
    // arrived but whose body stalls aborts HERE, not in the fetch above, and
    // must be reported as the timeout it is — not as a malformed response.
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
      return errorResult(`Octen Broad Search timed out while reading the response body (HTTP ${resp.status})`);
    }
    return errorResult(`Octen Broad Search returned non-JSON (HTTP ${resp.status})`);
  }

  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Broad Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const groups: any[] = data?.data?.search_results ?? [];
  const queries: string[] = data?.data?.queries ?? [];
  const meta = data?.meta ?? {};

  if (groups.length === 0) {
    return { content: [{ type: "text", text: `No results for "${args.query}".` }] };
  }

  const header = queries.length
    ? `Decomposed into ${queries.length} sub-quer${queries.length === 1 ? "y" : "ies"}: ${queries.join(" · ")}`
    : "";
  const blocks = groups.map((g: any, gi: number) => {
    const sub = g?.query ?? `sub-query ${gi + 1}`;
    const results: any[] = Array.isArray(g?.results) ? g.results : [];
    const inner = results.length
      ? results.map((r: any, i: number) => formatResult(r, i + 1, results.length)).join("\n\n---\n\n")
      : "_No results._";
    return `# Sub-query: ${sub}\n\n${inner}`;
  });
  const metaLine = formatMeta(meta, data?.request_id);
  const text = [header, ...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
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
