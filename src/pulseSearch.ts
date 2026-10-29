/**
 * `pulse_search` tool — wraps Octen Pulse Search
 * (https://docs.octen.ai/api-reference/pulse-search).
 *
 * A destination predictor, not a search over fresh content: one inference
 * produces the URLs a query most likely means, in about 10ms. That buys speed
 * and price at the cost of everything `search` filters on — there are no
 * domain, text, time or language parameters here, and the docs point news and
 * fresh pages back at `search`.
 *
 * `mode` is the whole tool. In `lite` the result is a title and a URL **with
 * no scheme**, and `highlight`, `full_content` and `include_images` are
 * ignored; `standard` turns them on and costs about twice the latency.
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as search.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatResult, formatMeta, errorResult } from "./search.js";
import {
  postJson, OctenHttpError, bodyReadFailure, missingKeyMessage,
  type HandlerContext,
} from "./http.js";

const API_KEY = process.env.OCTEN_API_KEY;
const PULSE_SEARCH_TIMEOUT_SEC = 30;

export const pulseSearchTool: Tool = {
  name: "pulse_search",
  // The endpoint's product name says nothing about what the tool does, and
  // `name` is fixed — clients allowlist it. `title` is the display name, so
  // that is where the purpose goes.
  title: "Pulse Search — find a site's URL",
  annotations: {
    title: "Pulse Search — find a site's URL",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `**When what is wanted is a web address rather than what is written on the page, this is the tool.** It returns up to 10 ranked candidate URLs with titles — the single most likely one, the top three, or a shortlist to choose from, whichever the question calls for. Official docs and API references ("github docs", "uv documentation", "python list methods"), help centres ("how do I return an amazon order"), a site you know exists ("youtube").

Prefer it over \`search\` for those: one inference predicts the URLs instead of searching and ranking them, so it answers in about 10ms for a fraction of the cost. Reaching for \`search\` to look up an address is slower and costs more for the same answer.

NOT FOR news or anything needing freshness — use \`news_search\`. NOT FOR a question that needs real retrieval across the open web, domain or language filters, or a time window — pulse has none of those parameters, sees no fresh content, and is not a cheaper substitute for \`search\`.

\`mode\` decides what comes back. \`lite\` (the default) returns titles and URLs only. \`standard\` adds highlights, full page content and images at roughly twice the latency; \`highlight\`, \`full_content\` and \`include_images\` do nothing in \`lite\`.

keywords: url lookup, find the site, official docs, api reference, documentation, help centre, homepage, where is, which url, candidate urls, top urls, quick lookup, destination, autocomplete`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "What to find the destination for, e.g. 'github docs'. Max 500 chars.",
      },
      mode: {
        type: "string",
        enum: ["lite", "standard"],
        default: "lite",
        description:
          "`lite` returns titles and schemeless URLs only and ignores the " +
          "content options below. `standard` returns highlights, full " +
          "content and images, at about twice the latency. Default lite.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Number of results (1-10). Default 5.",
      },
      safesearch: {
        type: "string",
        enum: ["off", "strict"],
        default: "strict",
        description: "Adult-content filter. Default strict.",
      },
      include_images: {
        type: "boolean",
        default: false,
        description: "Return image URLs per result. No effect in `lite` mode.",
      },
      highlight: {
        type: "object",
        description:
          "Ranked snippet per result. No effect in `lite` mode. Omit to use " +
          "the server default.",
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
          "Cleaned page body per result. No effect in `lite` mode. The first " +
          "result's content is free; the rest are billed.",
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

interface PulseSearchArgs {
  query: string;
  mode?: "lite" | "standard";
  count?: number;
  safesearch?: "off" | "strict";
  include_images?: boolean;
  highlight?: { enable?: boolean; max_tokens?: number };
  full_content?: { enable?: boolean; max_tokens?: number };
  timeout?: number;
}

/**
 * Give a lite-mode URL its scheme back.
 *
 * `lite` returns `github.com/docs`, not `https://github.com/docs`. Handing
 * that to a model that will pass it to `extract` produces a URL nothing can
 * fetch, so the scheme goes on here rather than in a prompt instruction the
 * model may or may not follow. Anything already carrying a scheme is left
 * alone, which covers `standard` and any future mode.
 */
function withScheme(url: unknown): unknown {
  if (typeof url !== "string" || url === "") return url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  // `//host/path` already has the slashes and wants only the scheme; adding
  // the pair as well produced `https:////host/path`.
  return url.startsWith("//") ? `https:${url}` : `https://${url}`;
}

/** Handler — POSTs to Octen Pulse Search and reshapes the response for the LLM. */
export async function handlePulseSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as PulseSearchArgs;

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

  // `timeout` is an HTTP-client concern, not part of the search payload.
  const { timeout, ...payloadArgs } = args;

  // Drop undefined fields so server defaults apply — `mode` in particular,
  // whose default is the API's to move.
  const body: Record<string, unknown> = { query: payloadArgs.query };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (key !== "query" && value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      forward: ctx?.forward,
      path: "/pulse-search",
      body,
      label: "Octen Pulse Search",
      timeoutSec: timeout,
      defaultTimeoutSec: PULSE_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen Pulse Search", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Pulse Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const results = (data?.data?.results ?? []).map((r: any) =>
    r && typeof r === "object" ? { ...r, url: withScheme(r.url) } : r);
  const meta = data?.meta ?? {};

  if (results.length === 0) {
    return { content: [{ type: "text", text: `No results for "${args.query}".` }] };
  }

  const blocks = results.map((r: any, i: number) => formatResult(r, i + 1, results.length));
  const text = [...blocks, formatMeta(meta, data?.request_id)].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
