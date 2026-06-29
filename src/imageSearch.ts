/**
 * `image_search` tool — wraps Octen Image Search API (POST /image-search).
 *
 * Invite-only beta. Surfaced to the LLM as an image-search tool: it takes a
 * text `query` (and an optional reference `image_url`) and returns ranked
 * images (title, source page, dimensions, thumbnail, description, summary).
 *
 * The underlying API accepts a multimodal `inputs` array of
 * `{type, url|data}` entries. We FLATTEN that for the LLM: a top-level
 * `query` string becomes `{type:"text", data:query}` and an optional
 * `image_url` becomes `{type:"image", url:image_url}`.
 *
 * Same envelope (`{code, msg, request_id, data, meta}`) and `x-api-key` auth
 * as search; `meta` sits at the top level (sibling of `data`).
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatMeta, errorResult } from "./search.js";

const DEFAULT_API_BASE = process.env.OCTEN_API_URL ?? "https://api.octen.ai";
const API_KEY = process.env.OCTEN_API_KEY;

/** Tool advertisement — clients see this in the list-tools response. */
export const imageSearchTool: Tool = {
  name: "image_search",
  description:
    "In Beta. Contact us to request beta access. Search the live web for " +
    "images with Octen and return ranked results (title, source page, " +
    "dimensions, thumbnail, description, summary). Pass a text `query`, and " +
    "optionally an `image_url` to search by reference image. Set `topic` to " +
    "`design` for design/illustration-oriented results. Use this when the " +
    "user wants to find pictures, photos, diagrams, or visual references — " +
    "not for general text web search.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text query describing the images to find.",
      },
      image_url: {
        type: "string",
        description:
          "Optional public image URL to search by reference image (visual " +
          "similarity), in addition to the text `query`.",
      },
      topic: {
        type: "string",
        enum: ["general", "design"],
        default: "general",
        description:
          "Image category: `general` for broad image search, `design` for " +
          "design / illustration oriented results. Default general.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Number of results to return (1-10). Default 5.",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only return results from these domains (e.g. 'unsplash.com').",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        description: "Drop results from these domains.",
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
      html_snippet: {
        type: "object",
        description:
          "Return an HTML snippet of the source context per result. Omit to use " +
          "the server default.",
        properties: {
          enable: { type: "boolean", description: "Whether to return HTML snippets." },
          max_tokens: {
            type: "integer",
            minimum: 100,
            default: 5000,
            description: "Max tokens per HTML snippet (min 100). Default 5000.",
          },
        },
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

interface HtmlSnippetOptions {
  enable?: boolean;
  max_tokens?: number;
}

interface ImageSearchArgs {
  query: string;
  image_url?: string;
  topic?: "general" | "design";
  count?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_time?: string;
  end_time?: string;
  safesearch?: "off" | "strict";
  html_snippet?: HtmlSnippetOptions;
  timeout?: number;
}

/** Handler — POSTs to Octen Image Search and reshapes the response for the LLM. */
export async function handleImageSearch(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const args = rawArgs as unknown as ImageSearchArgs;

  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return errorResult("`query` must be a non-empty string");
  }
  if (!API_KEY) {
    return errorResult(
      "OCTEN_API_KEY env var is not set. Get a key at https://octen.ai " +
      "and add it to your MCP client config (see README)."
    );
  }

  // `timeout` is an HTTP-client concern; `query`/`image_url` are flattened into `inputs`.
  const { timeout, query, image_url, ...payloadArgs } = args;

  // Build the multimodal inputs array from the flattened fields.
  const inputs: Array<Record<string, unknown>> = [{ type: "text", data: query }];
  if (typeof image_url === "string" && image_url.length > 0) {
    inputs.push({ type: "image", url: image_url });
  }

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { inputs };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await fetch(`${DEFAULT_API_BASE}/image-search`, {
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
      return errorResult(`Octen Image Search timed out after ${timeout}s`);
    }
    return errorResult(`Network error calling Octen Image Search: ${err.message}`);
  }

  // Octen returns the envelope even on errors (code: 401, 429, etc.),
  // so we read the body regardless of HTTP status.
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return errorResult(`Octen Image Search returned non-JSON (HTTP ${resp.status})`);
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Image Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const results = data?.data?.results ?? [];
  const meta = data?.meta ?? {};
  const total = results.length;

  if (total === 0) {
    return { content: [{ type: "text", text: `No image results for "${args.query}".` }] };
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
  if (typeof r.width === "number" && typeof r.height === "number") {
    lines.push(`**Dimensions:** ${r.width}x${r.height}`);
  }
  if (r.thumbnail) lines.push(`**Thumbnail:** ${r.thumbnail}`);
  if (r.time_published) lines.push(`**Published:** ${r.time_published}`);
  if (r.time_last_crawled) lines.push(`**Last crawled:** ${r.time_last_crawled}`);
  if (typeof r.description === "string" && r.description.length > 0) {
    lines.push(`\n### Description\n${r.description}`);
  }
  if (typeof r.summary === "string" && r.summary.length > 0) {
    lines.push(`\n### Summary\n${r.summary}`);
  }
  if (typeof r.html_snippet === "string" && r.html_snippet.length > 0) {
    lines.push(`**HTML snippet:** present (${r.html_snippet.length} chars)`);
  }
  return lines.join("\n");
}
