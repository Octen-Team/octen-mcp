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
import { postJson, OctenHttpError, bodyReadFailure, missingKeyMessage, type HandlerContext } from "./http.js";

/** Client-side ceiling when the caller passes no `timeout`. */
const IMAGE_SEARCH_TIMEOUT_SEC = 30;

const API_KEY = process.env.OCTEN_API_KEY;

/** Tool advertisement — clients see this in the list-tools response. */
export const imageSearchTool: Tool = {
  name: "image_search",
  title: "Image Search",
  // Explicit MCP tool annotations: every Octen tool is a read-only query
  // against the open web — it fetches and never mutates external state.
  // Plugin-directory reviews require these three hints on every tool.
  annotations: {
    title: "Image Search",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Find images on the web by text query OR by a reference image — returns ranked results (title, source page, dimensions, thumbnail, description, summary). In Beta; contact us to request beta access. Pass exactly one of: a text \`query\`, an \`image_url\` (a picture already on the web), or \`image_data\` (base64, for a picture you hold). Never more than one. Set \`topic\` to \`design\` for UI design references — each result then carries a structured style \`summary\` and an \`html_snippet\` for building/restyling frontends. Use this when the user wants pictures, photos, diagrams, screenshots, or visual references — not for general text web search.

keywords: find images, image search, photos, pictures, screenshots, visual reference, diagram, icon, illustration, UI design, reference image`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description: "Text query describing the images to find. Exactly one of `query`, `image_url` or `image_data` — never more than one.",
      },
      image_url: {
        type: "string",
        description:
          "Public image URL to search by visual similarity. Exactly one of " +
          "`query`, `image_url` or `image_data` — never more than one.",
      },
      image_data: {
        type: "string",
        // 5 MiB is the encoded ceiling the API documents ("at most 5MB after
        // encoding"), so it is measured on this string, not on the picture it
        // decodes to.
        maxLength: 5 * 1024 * 1024,
        description:
          "Base64-encoded image to search by visual similarity, for an image " +
          "you hold rather than one already on the web. At most 5MB encoded; " +
          "JPEG, PNG, WEBP, BMP, TIFF, ICO, DIB, ICNS or SGI. A `data:` URI is " +
          "accepted — its payload is used. Exactly one of `query`, `image_url` " +
          "or `image_data` — never more than one.",
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
            maximum: 100000,
            default: 5000,
            description: "Max tokens per HTML snippet (100-100000). Default 5000.",
          },
        },
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        description: "Request timeout in seconds (1-60). Defaults to 30s if unset.",
      },
    },
    // No `required`: exactly one of `query` / `image_url` must be present, which
    // JSON Schema can only say with `oneOf`. Requiring `query` here made the
    // documented image-only search unreachable; the handler enforces the real
    // rule and says which one is missing.
  },
};

interface HtmlSnippetOptions {
  enable?: boolean;
  max_tokens?: number;
}

interface ImageSearchArgs {
  query: string;
  image_url?: string;
  image_data?: string;
  topic?: "general" | "design";
  count?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  safesearch?: "off" | "strict";
  html_snippet?: HtmlSnippetOptions;
  timeout?: number;
}

/** Handler — POSTs to Octen Image Search and reshapes the response for the LLM. */

/** `data:image/png;base64,AAAA` → `AAAA`; anything else is returned unchanged. */
function stripDataUri(v: string): string {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(v.trim());
  return m ? m[1] : v.trim();
}

export async function handleImageSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as ImageSearchArgs;

  // Exactly one input — text, image URL, or image bytes. The API's `inputs`
  // array is documented `maxItems: 1`, and sending two earns `Invalid params.
  // Inputs exceeds 1 entries` from upstream. This tool used to require `query`
  // and describe `image_url` as usable "in addition" to it, so the
  // documented-and-supported combination (a reference image on its own) was
  // unreachable while the unsupported one was the advertised path.
  //
  // The rule is enforced here rather than in the schema because expressing
  // "exactly one of" needs `oneOf`, which the validator deliberately does not
  // implement — see src/validate.ts.
  const filled = (["query", "image_url", "image_data"] as const)
    .filter((k) => typeof args[k] === "string" && (args[k] as string).trim() !== "");
  if (filled.length > 1) {
    return errorResult(
      `Pass exactly one of \`query\`, \`image_url\` or \`image_data\` — got ` +
      `${filled.map((k) => "`" + k + "`").join(" and ")}. This search takes a single input.`);
  }
  if (filled.length === 0) {
    return errorResult(
      "Pass one of `query` (text to search for), `image_url` (a public image URL to " +
      "match visually), or `image_data` (base64 of an image you hold).");
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

  // `timeout` is an HTTP-client concern; `query`/`image_url` are flattened into `inputs`.
  const { timeout, query, image_url, image_data, ...payloadArgs } = args;

  // Exactly one entry — the branch above has already established which.
  //
  // A `data:` URI is unwrapped rather than refused: its payload *is* the
  // base64 the API wants, and it is the form every browser and screenshot
  // tool produces. Rejecting it would be pedantry about a container.
  const inputs: Array<Record<string, unknown>> =
    filled[0] === "query"     ? [{ type: "text", data: query }]
  : filled[0] === "image_url" ? [{ type: "image", url: image_url }]
  :                             [{ type: "image", data: stripDataUri(image_data as string) }];

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { inputs };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      path: "/image-search",
      body,
      label: "Octen Image Search",
      timeoutSec: timeout,
      defaultTimeoutSec: IMAGE_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure(`Octen Image Search`, resp, e));
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
    // Names whichever input was actually used. Interpolating `query` here
    // printed `No image results for "undefined"` for an image search, which
    // reads like a bug in the caller's arguments rather than an empty result.
    const subject = filled[0] === "query" ? `"${args.query}"`
      : filled[0] === "image_url" ? `image ${args.image_url}`
      : "the supplied image";
    return { content: [{ type: "text", text: `No image results for ${subject}.` }] };
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
