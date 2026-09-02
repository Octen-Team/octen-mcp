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
import { postJson, OctenHttpError, bodyReadFailure, missingKeyMessage, type HandlerContext } from "./http.js";
import { formatMediaList, formatMediaItem } from "./search.js";

const API_KEY = process.env.OCTEN_API_KEY;

/**
 * `timeout` here is the *server-side, per-URL* fetch budget (it travels in the
 * request body), so it cannot double as the client ceiling: a 20-URL call can
 * legitimately outlast it. We allow the per-URL budget plus headroom for the
 * server's own fan-out, bounded so a wedged request still fails eventually.
 */
const EXTRACT_SERVER_TIMEOUT_DEFAULT_SEC = 30;
const EXTRACT_TIMEOUT_MAX_SEC = 60;   // schema maximum for `timeout`
const EXTRACT_CLIENT_HEADROOM_SEC = 90;
const EXTRACT_CLIENT_TIMEOUT_CAP_SEC = 180;

/** Tool advertisement — clients see this in the list-tools response. */
export const extractTool: Tool = {
  name: "extract",
  title: "URL Extract",
  // Explicit MCP tool annotations: every Octen tool is a read-only query
  // against the open web — it fetches and never mutates external state.
  // Plugin-directory reviews require these three hints on every tool.
  annotations: {
    title: "URL Extract",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Read one or more web pages by URL and return clean, LLM-ready content (markdown or text). By default (no \`query\`) it returns each page's full content — this is what you want in almost all cases. Only pass \`query\` when the user explicitly asks to fetch relevance-ranked snippets for a specific topic; doing so returns highlights INSTEAD of the full body, so the content will be partial. Every result also includes a \`category\` (topical) and \`page_structure\` (typology) classification. Bare hosts like 'octen.ai' are auto-normalized to https. Cached when fresh.

Use this when you already have the URL(s). To find pages first, use \`search\` or \`broad_search\`.

keywords: read page, fetch url, scrape, page content, article text, parse webpage, extract, read article, url content, open link`,
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string", maxLength: 2048 },
        minItems: 1,
        maxItems: 20,
        description: "URLs to extract. 1-20 per call, each ≤2048 chars. Bare hosts ok.",
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
        maximum: 31536000,
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
      include_images: { type: "boolean", default: false, description: "Return image resources found on each page (also enables `cover_image` when the page has one)." },
      include_videos: { type: "boolean", default: false, description: "Return video URLs found on each page." },
      include_audio:  { type: "boolean", default: false, description: "Return audio URLs found on each page." },
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
}

/** Handler — POSTs to Octen Extract and reshapes the response for the LLM. */
export async function handleExtract(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as ExtractArgs;

  if (!Array.isArray(args.urls) || args.urls.length === 0) {
    return errorResult("`urls` must be a non-empty array of strings");
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

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { urls: args.urls };
  if (args.query !== undefined)           body.query = args.query;
  if (args.max_age_seconds !== undefined) body.max_age_seconds = args.max_age_seconds;
  if (args.format !== undefined)          body.format = args.format;
  if (args.timeout !== undefined)         body.timeout = args.timeout;
  if (args.include_images !== undefined)  body.include_images = args.include_images;
  if (args.include_videos !== undefined)  body.include_videos = args.include_videos;
  if (args.include_audio !== undefined)   body.include_audio = args.include_audio;

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      path: "/extract",
      body,
      label: "Octen Extract",
      defaultTimeoutSec: Math.min(
        EXTRACT_CLIENT_TIMEOUT_CAP_SEC,
        (args.timeout ?? EXTRACT_SERVER_TIMEOUT_DEFAULT_SEC) + EXTRACT_CLIENT_HEADROOM_SEC
      ),
      // The ceiling derives from the per-URL budget, so raising `timeout` does
      // raise it — but only while `timeout` is below its own schema maximum.
      canRaiseTimeout: (args.timeout ?? EXTRACT_SERVER_TIMEOUT_DEFAULT_SEC) < EXTRACT_TIMEOUT_MAX_SEC,
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
    return errorResult(bodyReadFailure(`Octen Extract`, resp, e));
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
  if (r.cover_image?.url) lines.push(`**Cover image:** ${formatMediaItem(r.cover_image)}`);
  // Same renderer as search, imported rather than reimplemented: this whole
  // defect began as two copies of the media block drifting apart — the copy
  // here handled `cover_image` correctly while the one in search did not.
  lines.push(...formatMediaList("Images", r.images));
  lines.push(...formatMediaList("Videos", r.videos));
  lines.push(...formatMediaList("Audio", r.audio));

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