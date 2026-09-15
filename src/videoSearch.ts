/**
 * `video_search` tool — wraps Octen Video Search API (POST /video-search).
 *
 * Invite-only beta. Surfaced to the LLM as a video-search tool: it takes a
 * text `query` and returns ranked videos (title, source page, cover image,
 * duration, matching segment, authors, description).
 *
 * The underlying API accepts a TEXT-ONLY `inputs` array. We FLATTEN that for
 * the LLM: a top-level `query` string becomes `[{type:"text", data:query}]`.
 *
 * Same envelope (`{code, msg, request_id, data, meta}`) and `x-api-key` auth
 * as search; `meta` sits at the top level (sibling of `data`).
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatMeta, errorResult } from "./search.js";
import { postJson, OctenHttpError, bodyReadFailure, missingKeyMessage, type HandlerContext } from "./http.js";

/** Client-side ceiling when the caller passes no `timeout`. */
const VIDEO_SEARCH_TIMEOUT_SEC = 30;

const API_KEY = process.env.OCTEN_API_KEY;

/** Tool advertisement — clients see this in the list-tools response. */
export const videoSearchTool: Tool = {
  name: "video_search",
  // Explicit MCP tool annotations: every Octen tool is a read-only query
  // against the open web — it fetches and never mutates external state.
  // Plugin-directory reviews require these three hints on every tool.
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Find videos on the web by text query — returns ranked results (title, source page, cover image, duration, matching segment, authors, description). In Beta; contact us to request beta access. Pass a text \`query\`. Use this when the user wants to find videos, clips, footage, tutorials, or a specific moment within a video — not for general text web search.

keywords: find videos, video search, clips, footage, youtube, tutorial video, watch, movie, video clip`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description: "Text query describing the videos to find.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Number of results to return (1-10). Default 5.",
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
      safesearch: {
        type: "string",
        enum: ["off", "strict"],
        default: "strict",
        description: "Adult-content filter. Default strict.",
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

interface VideoSearchArgs {
  query: string;
  count?: number;
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_time?: string;
  end_time?: string;
  safesearch?: "off" | "strict";
  timeout?: number;
}

/** Handler — POSTs to Octen Video Search and reshapes the response for the LLM. */
export async function handleVideoSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as VideoSearchArgs;

  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return errorResult("`query` must be a non-empty string");
  }
  // When a transport supplies ctx, it is authoritative — no env fallback. The
  // stdio entry resolves the env key into ctx itself; falling back here would
  // let an unauthenticated HTTP caller silently ride the deployment's own
  // credential. The bare fallback exists only for direct in-process callers
  // (the unit suites) that invoke handlers without a transport.
  const apiKey = ctx ? ctx.apiKey : API_KEY;
  if (!apiKey) {
    return errorResult(missingKeyMessage(ctx));
  }

  // `timeout` is an HTTP-client concern; `query` is flattened into `inputs` (text only).
  const { timeout, query, ...payloadArgs } = args;

  const inputs: Array<Record<string, unknown>> = [{ type: "text", data: query }];

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { inputs };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      path: "/video-search",
      body,
      label: "Octen Video Search",
      timeoutSec: timeout,
      defaultTimeoutSec: VIDEO_SEARCH_TIMEOUT_SEC,
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
    // Body reads fail three distinct ways (deadline abort, connection torn
    // down mid-stream, genuinely malformed bytes); bodyReadFailure names
    // which one happened instead of lumping them as a parse error.
    return errorResult(bodyReadFailure(`Octen Video Search`, resp, e));
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Video Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const results = data?.data?.results ?? [];
  const meta = data?.meta ?? {};
  const total = results.length;

  if (total === 0) {
    return { content: [{ type: "text", text: `No video results for "${args.query}".` }] };
  }

  const blocks = results.map((r: any, i: number) => formatResult(r, i + 1, total));
  const metaLine = formatMeta(meta, data?.request_id);
  const text = [...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}

function formatResult(r: any, idx: number, total: number): string {
  const lines: string[] = [`## Result ${idx}/${total}: ${r.title ?? "(untitled)"}`];
  if (r.url) lines.push(r.url);
  if (r.source_page) lines.push(`**Source page:** ${r.source_page}`);
  if (r.cover_url) lines.push(`**Cover:** ${r.cover_url}`);
  if (typeof r.duration_seconds === "number") lines.push(`**Duration:** ${r.duration_seconds}s`);
  const seg = r.match_segment;
  if (seg && typeof seg === "object" &&
      (typeof seg.start_seconds === "number" || typeof seg.end_seconds === "number")) {
    lines.push(`**Match segment:** ${seg.start_seconds ?? "?"}s–${seg.end_seconds ?? "?"}s`);
  }
  if (r.authors) {
    const authors = Array.isArray(r.authors) ? r.authors.join(", ") : r.authors;
    lines.push(`**Authors:** ${authors}`);
  }
  if (r.time_published) lines.push(`**Published:** ${r.time_published}`);
  if (r.time_last_crawled) lines.push(`**Last crawled:** ${r.time_last_crawled}`);
  if (typeof r.description === "string" && r.description.length > 0) {
    lines.push(`\n### Description\n${r.description}`);
  }
  return lines.join("\n");
}
