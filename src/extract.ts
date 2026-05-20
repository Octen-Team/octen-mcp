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
    "Unique to Octen: pass a `query` to get the most relevant highlights " +
    "per page instead of the full body; every result includes a `category` " +
    "(topical) and `page_structure` (typology) classification. Bare hosts " +
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
          "Optional intent-focused keywords. When set, each result returns " +
          "`highlights` (most relevant snippets, ranked) instead of `full_content`.",
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

  // Build a compact summary block for the LLM, then the full JSON for the rest.
  const results = data?.data?.results ?? [];
  const summary = results
    .map((r: any, i: number) => {
      const head = `[${i + 1}] ${r.url}  →  ${r.status}`;
      if (r.status === "success") {
        const cat = r.category?.primary ?? "-";
        const struct = r.page_structure?.primary ?? "-";
        const lines = [
          head,
          `    title: ${r.title ?? "-"}`,
          `    category: ${cat}    page_structure: ${struct}`,
        ];
        if (Array.isArray(r.highlights) && r.highlights.length > 0) {
          lines.push(`    highlights (${r.highlights.length}): ${r.highlights[0].slice(0, 120)}…`);
        } else if (typeof r.full_content === "string") {
          lines.push(`    full_content bytes: ${r.full_content.length}`);
        }
        return lines.join("\n");
      }
      return `${head}\n    error: ${r.error_message ?? "-"}`;
    })
    .join("\n");

  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}