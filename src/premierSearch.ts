/**
 * `premier_search` tool — wraps Octen Web Search Premier
 * (https://docs.octen.ai/api-reference/search-premier).
 *
 * Documented as a drop-in for `/search`: the same request body and the same
 * response, with deeper retrieval and more careful reranking behind it. So
 * nothing about a call says which of the two it is except the path it is sent
 * to — and they are billed at separate rates, which is why this is a tool of
 * its own rather than a flag on `search`.
 *
 * That is a statement about the two endpoints, not about the two tools: this
 * one declares `result_type`, which the reference documents, and the `search`
 * tool does not offer it. So the description says "every parameter `search`
 * takes, plus `result_type`" rather than "the same parameters".
 *
 * Its parameters are named one by one rather than taken wholesale from
 * `search`'s schema. The two references match today; taking the schema
 * wholesale would make that a permanent assumption, and it is the assumption
 * that let `news_search` go on advertising a parameter its endpoint had
 * stopped taking.
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as search.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  formatResult, formatMeta, errorResult, renderEach, resultEntries, sharedSearchProperties,
} from "./search.js";
import {
  postJson, OctenHttpError, bodyReadFailure, nonEnvelopeFailure, isOctenEnvelope, missingKeyMessage,
  type HandlerContext,
} from "./http.js";

const API_KEY = process.env.OCTEN_API_KEY;

/**
 * The same client deadline as `search`. Measured against the API: a premier
 * call spends roughly 350-550ms server-side where `search` spends about 100ms
 * — slower, and nowhere near needing a longer budget.
 */
const PREMIER_SEARCH_TIMEOUT_SEC = 30;

export const premierSearchTool: Tool = {
  name: "premier_search",
  title: "Web Search Premier — deeper retrieval and reranking",
  annotations: {
    title: "Web Search Premier — deeper retrieval and reranking",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Search the live web with deeper retrieval and more careful reranking than \`search\`, and return ranked results (title, url, snippet). It reaches more sources — niche and long-tail pages included — and ranks the page that actually holds the answer higher. It takes every parameter \`search\` takes — \`highlight\`, \`full_content\`, the domain / text / language filters, the time window — plus \`result_type\`, and returns the same result shape.

USE FOR a lookup where finding the exact page decides the answer: a specific fact buried deep in a page, a niche document, a report or filing you can name but not locate — or a question \`search\` has just answered thinly or off-target. It takes longer than \`search\` and is billed separately at its own per-call rate, which a Search Plan's unlimited searches do not cover. So default to \`search\` for ordinary lookups, and reach for this one when ranking quality is what is missing. News still belongs in \`news_search\`, a company or a person in \`business_search\`, and a question spanning several independent subtopics in \`broad_search\`.

keywords: premier search, deeper search, higher accuracy, rerank, exact page, specific fact, hard to find, niche, long-tail, report, filing, document`,
  inputSchema: {
    type: "object",
    properties: {
      ...sharedSearchProperties("query"),
      result_type: {
        type: "string",
        enum: ["standard", "dynamic"],
        default: "standard",
        description:
          "How results are returned. `standard` returns them as the other " +
          "parameters specify; `dynamic` returns only the relevant ones — up " +
          "to `count` — and adjusts highlight length per result. Default standard.",
      },
      ...sharedSearchProperties(
        "count", "include_domains", "exclude_domains", "include_text", "exclude_text",
        "time_basis", "time_range", "start_time", "end_time",
        "format", "safesearch", "language", "highlight", "full_content",
        "include_images", "timeout",
      ),
    },
    required: ["query"],
  },
};

interface PremierSearchArgs {
  query: string;
  result_type?: "standard" | "dynamic";
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
  highlight?: { enable?: boolean; max_tokens?: number };
  full_content?: { enable?: boolean; max_tokens?: number };
  include_images?: boolean;
  timeout?: number;
}

/** Handler — POSTs to Octen Web Search Premier and reshapes the response for the LLM. */
export async function handlePremierSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as PremierSearchArgs;

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

  // Drop undefined fields so server defaults apply.
  const body: Record<string, unknown> = { query: payloadArgs.query };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (key !== "query" && value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      forward: ctx?.forward,
      path: "/search-premier",
      body,
      label: "Octen Web Search Premier",
      timeoutSec: timeout,
      defaultTimeoutSec: PREMIER_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen Web Search Premier", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim. Only on a response
  // that is Octen's — a gateway's own numeric `code` is not an Octen error,
  // and falls through to the check below with its message intact.
  if (isOctenEnvelope(data) && typeof data.code === "number" && data.code !== 0) {
    return errorResult(
      // `msg` is the envelope's own field. `message` is what a hop in front
      // of the API says when it passes the request id through but answers in
      // its own words; it is still the only explanation there is.
      `Octen Web Search Premier: code=${data.code} msg=${data.msg ?? data.message ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  // A failing status with no Octen code, or a body that is not Octen's at
  // all, is an outage or a routing mistake — not a search that found nothing.
  const outage = nonEnvelopeFailure("Octen Web Search Premier", resp, data);
  if (outage) return errorResult(outage);

  // `meta` is top-level (sibling of `data`), as it is on search.
  const results = resultEntries(data?.data?.results);
  const meta = data?.meta ?? {};
  const total = results.length;

  const metaLine = formatMeta(meta, data?.request_id);

  if (total === 0) {
    // The meta line travels with an empty result too: "nothing found" and
    // "nothing found, and here is the API's warning about why" are different
    // answers, and the request id is what a support request needs.
    const text = [`No results for "${args.query}".`, metaLine].filter(Boolean).join("\n\n");
    return { content: [{ type: "text", text }] };
  }

  const blocks = renderEach(results, "Result", formatResult);
  const text = [...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
