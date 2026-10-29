/**
 * `news_search` tool — wraps Octen News Search
 * (https://docs.octen.ai/api-reference/news-search).
 *
 * Its own endpoint, not `search` with a flag. It was the latter until the API
 * grew `POST /news-search`, and the two have since diverged: this one has no
 * `include_text`/`exclude_text`, `format`, `safesearch` or `include_images`,
 * and adds `subjects` — a clustering pass that groups the articles into
 * storylines, each with a summary and a time span, so the model can answer
 * "what happened" without reading every result.
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as search.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatResult, formatMeta, errorResult, sharedSearchProperties } from "./search.js";
import {
  postJson, OctenHttpError, bodyReadFailure, missingKeyMessage,
  type HandlerContext,
} from "./http.js";

const API_KEY = process.env.OCTEN_API_KEY;
const NEWS_SEARCH_TIMEOUT_SEC = 30;

export const newsSearchTool: Tool = {
  name: "news_search",
  title: "News Search",
  annotations: {
    title: "News Search",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Search recent news and return ranked articles (title, url, snippet) — current events, headlines, timely reporting. Alongside the articles it returns \`subjects\`: the coverage grouped into storylines, each with a summary and the span it covers, so a "what happened with X" question is answerable without reading every article. Narrow with domain filters, a \`language\` filter (ISO 639-1 codes), and a time window (published/crawled \`start_time\`/\`end_time\`, or a relative \`time_range\`). **\`include_domains\`/\`exclude_domains\` narrow the ranked articles only — the storylines are built from the open web either way.** When the question restricts its sources ("what is Reuters saying about X"), answer from the articles, not the storylines. Pass \`highlight\` for a ranked snippet per article, or \`full_content\` for the cleaned article body (heavier — costs more context).

USE FOR what is being reported right now: breaking events, announcements, coverage of a company or person over the last days or weeks. For a company or person *profile* — financials, key people, career history — use \`business_search\`, which returns that as structured cards instead of articles to read. For non-news web pages use \`search\`. For a multi-angle question spanning several independent subtopics, use \`broad_search\` rather than looping this tool.

keywords: news search, latest news, headlines, current events, breaking news, recent, today, this week, press coverage, storylines`,
  inputSchema: {
    type: "object",
    properties: {
      ...sharedSearchProperties(
        "query", "count", "include_domains", "exclude_domains",
        "time_basis", "time_range", "start_time", "end_time",
        "language", "highlight", "full_content", "timeout",
      ),
      subjects: {
        type: "object",
        description:
          "Group the articles into storylines, each with a summary and a time " +
          "span. On by default — omit to use the server default.",
        properties: {
          enable: { type: "boolean", default: true, description: "Whether to return storylines." },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            default: 2,
            description: "How many storylines to return (1-5).",
          },
          max_sub_news: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Max supporting articles per storyline (1-20).",
          },
        },
      },
    },
    required: ["query"],
  },
};

interface NewsSearchArgs {
  query: string;
  count?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  time_basis?: "auto" | "published" | "crawled";
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_time?: string;
  end_time?: string;
  language?: string[];
  highlight?: { enable?: boolean; max_tokens?: number };
  full_content?: { enable?: boolean; max_tokens?: number };
  subjects?: { enable?: boolean; count?: number; max_sub_news?: number };
  timeout?: number;
}

/**
 * Whatever content an article carries, indented under it.
 *
 * These are not duplicates of the ranked results: a storyline's articles need
 * not appear in `data.results` at all, so dropping their `highlight` and
 * `full_content` discarded content the caller had enabled and been billed
 * for, with nowhere else to find it.
 */
function articleContent(n: any, indent: string): string[] {
  const out: string[] = [];
  if (typeof n?.highlight === "string" && n.highlight) out.push(`${indent}${n.highlight}`);
  if (typeof n?.full_content === "string" && n.full_content) {
    out.push(`${indent}${n.full_content}`);
  }
  return out;
}

/** One article inside a storyline: a line, plus its content when it carries any. */
function newsLine(n: any): string[] {
  const title = n?.title || "(untitled)";
  const when = n?.time_published ? ` (${n.time_published})` : "";
  return [
    n?.url ? `  - ${title}${when} — ${n.url}` : `  - ${title}${when}`,
    ...articleContent(n, "    "),
  ];
}

/**
 * A storyline, rendered above the articles it draws on.
 *
 * Deliberately terse: this layer exists to save the model from reading every
 * article, so spending the tokens it saves on formatting defeats it.
 */
function formatSubject(s: any, idx: number, total: number): string {
  const lines = [`## Storyline ${idx}/${total}: ${s?.name || "(unnamed)"}`];

  const span = [s?.time_start, s?.time_latest].filter(Boolean);
  if (span.length) lines.push(span.join(" → "));
  if (s?.summary) lines.push(s.summary);

  const top = s?.top_news;
  if (top) {
    const when = top.time_published ? ` (${top.time_published})` : "";
    lines.push(`Top: ${top.title || "(untitled)"}${when}${top.url ? ` — ${top.url}` : ""}`);
    if (top.summary) lines.push(`  ${top.summary}`);
    lines.push(...articleContent(top, "  "));
  }

  const subs = Array.isArray(s?.sub_news) ? s.sub_news : [];
  if (subs.length) lines.push("Also:", ...subs.flatMap(newsLine));

  return lines.join("\n");
}

/** Handler — POSTs to Octen News Search and reshapes the response for the LLM. */
export async function handleNewsSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as NewsSearchArgs;

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

  // Drop undefined fields so server defaults apply — `subjects` in particular
  // is on by default at the API, and injecting our own copy of that default
  // would pin it here the next time the API moves it.
  const body: Record<string, unknown> = { query: payloadArgs.query };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (key !== "query" && value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      forward: ctx?.forward,
      path: "/news-search",
      body,
      label: "Octen News Search",
      timeoutSec: timeout,
      defaultTimeoutSec: NEWS_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen News Search", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen News Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const results = data?.data?.results ?? [];
  const subjects = data?.data?.subjects ?? [];
  const meta = data?.meta ?? {};

  if (results.length === 0 && subjects.length === 0) {
    return { content: [{ type: "text", text: `No news for "${args.query}".` }] };
  }

  // Storylines first: they are the summary of what follows, and a model that
  // stops reading after them should still have the answer — with one
  // exception the tool description carries, since only the model can act on
  // it: domain filters never reach `subjects`, so on a source-restricted
  // query the storylines may draw on outlets the caller excluded.
  const blocks = [
    ...subjects.map((s: any, i: number) => formatSubject(s, i + 1, subjects.length)),
    ...results.map((r: any, i: number) => formatResult(r, i + 1, results.length)),
  ];
  const text = [...blocks, formatMeta(meta, data?.request_id)].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
