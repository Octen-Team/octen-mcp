/**
 * `extract` tool — wraps Octen Extract API (https://docs.octen.ai/api-reference/extract).
 *
 * Differentiators worth surfacing to the LLM so it picks this tool when
 * appropriate:
 *  - query-driven highlights (returns the most relevant snippet per URL)
 *  - page_structure ({primary, secondary}) — typology of the page itself
 *  - category ({primary, secondary})       — topical classification
 * None of these are in Firecrawl / Exa / Tavily today.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_API_BASE = process.env.OCTEN_API_URL ?? "https://api.octen.ai";
const API_KEY = process.env.OCTEN_API_KEY;

/** Tool advertisement — clients see this in the list-tools response. */
export const extractTool: Tool = {
  name: "extract",
  description:
    "Fetch one or more URLs and return LLM-ready content from Octen. " +
    "By default (no `query`) it returns each page's full content — this is " +
    "what you want in almost all cases. Only pass `query` when the user " +
    "explicitly asks to fetch relevance-ranked snippets for a specific topic; " +
    "doing so returns highlights INSTEAD of the full body, so the content " +
    "will be partial. Every result also includes a `category` (topical) and " +
    "`page_structure` (typology) classification, unique to Octen. Bare hosts " +
    "like 'octen.ai' are auto-normalized to https. Cached when fresh.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 20,
        description: "URLs to extract. 1-20 per call. Bare hosts ok.",
      },
      query: {
        type: "string",
        maxLength: 500,
        description:
          "Optional — leave UNSET in the normal case. When unset, each result " +
          "returns the page's `full_content` (the complete text). Only set this " +
          "when the user explicitly wants relevance-ranked snippets for a " +
          "specific query/topic: setting it makes each result return " +
          "`highlights` (ranked excerpts) and OMIT `full_content`, so the page " +
          "body will be incomplete. Do not pass it just to focus a normal fetch.",
      },
      max_age_seconds: {
        type: "integer",
        minimum: 300,
        default: 86400,
        description:
          "Maximum age of cached content in seconds. Default 24h. Lower this " +
          "for time-sensitive pages (news / prices).",
      },
      format: {
        type: "string",
        enum: ["markdown", "text"],
        default: "markdown",
        description: "Output format. Default markdown.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        default: 30,
        description: "Per-URL timeout in seconds (1-60).",
      },
      include_images: { type: "boolean", default: false, description: "Return image URLs found on each page." },
      include_videos: { type: "boolean", default: false, description: "Return video URLs found on each page." },
      include_audio:  { type: "boolean", default: false, description: "Return audio URLs found on each page." },
      include_favicon:{ type: "boolean", default: false, description: "Return each page's favicon URL." },
    },
    required: ["urls"],
  },
};

interface ExtractArgs {
  urls: string[];
  query?: string;
  max_age_seconds?: number;
  format?: "markdown" | "text";
  timeout?: number;
  include_images?: boolean;
  include_videos?: boolean;
  include_audio?: boolean;
  include_favicon?: boolean;
}

/** Handler — POSTs to Octen Extract and reshapes the response for the LLM. */
export async function handleExtract(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const args = rawArgs as unknown as ExtractArgs;

  if (!Array.isArray(args.urls) || args.urls.length === 0) {
    return errorResult("`urls` must be a non-empty array of strings");
  }
  if (!API_KEY) {
    return errorResult(
      "OCTEN_API_KEY env var is not set. Get a key at https://octen.ai " +
      "and add it to your MCP client config (see README)."
    );
  }

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { urls: args.urls };
  if (args.query !== undefined)           body.query = args.query;
  if (args.max_age_seconds !== undefined) body.max_age_seconds = args.max_age_seconds;
  if (args.format !== undefined)          body.format = args.format;
  if (args.timeout !== undefined)         body.timeout = args.timeout;
  if (args.include_images !== undefined)  body.include_images = args.include_images;
  if (args.include_videos !== undefined)  body.include_videos = args.include_videos;
  if (args.include_audio !== undefined)   body.include_audio = args.include_audio;
  if (args.include_favicon !== undefined) body.include_favicon = args.include_favicon;

  let resp: Response;
  try {
    resp = await fetch(`${DEFAULT_API_BASE}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return errorResult(`Network error calling Octen Extract: ${(e as Error).message}`);
  }

  // Octen returns the envelope even on errors (code: 401, 429, etc.),
  // so we read the body regardless of HTTP status.
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return errorResult(`Octen Extract returned non-JSON (HTTP ${resp.status})`);
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Extract: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  // Format each result as readable markdown so the LLM can use it directly,
  // without a separate huge JSON dump (which previously made models reach for
  // jq / file_search just to extract a title).
  const results = data?.data?.results ?? [];
  const meta = data?.data?.meta ?? {};
  const total = results.length;

  const blocks = results.map((r: any, i: number) => formatResult(r, i + 1, total));
  const metaLine = formatMeta(meta, data?.request_id);
  const text = [...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}

function formatResult(r: any, idx: number, total: number): string {
  const head = `## Result ${idx}/${total}: ${r.url}`;

  if (r.status === "failed") {
    return [
      head,
      `**Status:** failed`,
      `**Error:** ${r.error_message ?? "(no message)"}`,
    ].join("\n");
  }

  const lines: string[] = [head, `**Status:** success`];
  if (r.title) lines.push(`**Title:** ${r.title}`);
  const cat = r.category?.primary;
  if (cat) lines.push(`**Category:** ${cat}${r.category?.secondary ? " / " + r.category.secondary : ""}`);
  const ps = r.page_structure?.primary;
  if (ps) lines.push(`**Page structure:** ${ps}${r.page_structure?.secondary ? " / " + r.page_structure.secondary : ""}`);
  if (r.time_published) lines.push(`**Published:** ${r.time_published}`);
  if (r.time_last_crawled) lines.push(`**Last crawled:** ${r.time_last_crawled}`);
  if (r.favicon) lines.push(`**Favicon:** ${r.favicon}`);
  if (Array.isArray(r.images) && r.images.length) lines.push(`**Images:** ${r.images.length}`);
  if (Array.isArray(r.videos) && r.videos.length) lines.push(`**Videos:** ${r.videos.length}`);
  if (Array.isArray(r.audio)  && r.audio.length)  lines.push(`**Audio:** ${r.audio.length}`);

  // Content body: highlights (if query supplied) take precedence, else full_content.
  if (Array.isArray(r.highlights) && r.highlights.length) {
    const items = r.highlights.map((h: string, i: number) => `${i + 1}. ${h}`).join("\n\n");
    lines.push(`\n### Highlights\n${items}`);
  } else if (typeof r.full_content === "string" && r.full_content.length > 0) {
    lines.push(`\n### Content\n${r.full_content}`);
  }

  return lines.join("\n");
}

function formatMeta(meta: any, requestId: string | undefined): string {
  const parts: string[] = [];
  const u = meta?.usage;
  if (u) {
    if (typeof u.total_urls === "number") parts.push(`total_urls: ${u.total_urls}`);
    if (typeof u.successful_urls === "number") parts.push(`successful_urls: ${u.successful_urls}`);
  }
  if (typeof meta?.latency === "number") parts.push(`latency_ms: ${meta.latency}`);
  if (meta?.warning) parts.push(`warning: ${meta.warning}`);
  if (requestId) parts.push(`request_id: ${requestId}`);
  return parts.length ? `_${parts.join(" · ")}_` : "";
}

function errorResult(msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}