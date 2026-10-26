/**
 * `business_search` tool — wraps Octen Business Search
 * (https://docs.octen.ai/api-reference/business-search).
 *
 * Web search over business content that also returns the companies and people
 * behind the query as entity cards: profile, identifiers, financials, key
 * people, career history, recent announcements. The cards are the point — they
 * carry what the model would otherwise have to read a dozen pages to assemble,
 * so a company question costs a fraction of the context it used to.
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
const BUSINESS_SEARCH_TIMEOUT_SEC = 30;

export const businessSearchTool: Tool = {
  name: "business_search",
  title: "Business Search",
  annotations: {
    title: "Business Search",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Look up a company or a person and get a structured card back, plus the ranked sources behind it. A company card carries the profile, identifiers, financial and stock metrics, key people and recent announcements; a person card carries the current position, career history and recent activity. Name two companies in one query and you get a card for each, same fields, ready to compare. Set \`entities.enable\` to false for a plain ranked list instead.

USE FOR questions about a business or the people in one: "what does this company do", due diligence, who runs it, how two of them compare, what they have announced lately. The cards answer these from one call — reaching for \`search\` and reading a dozen pages costs far more context for the same facts.

NOT FOR breaking coverage of an event — use \`news_search\`, which returns articles and storylines. NOT FOR general web pages — use \`search\`.

Examples: "NVIDIA company overview", "Lisa Su AMD CEO", "compare Stripe and Adyen payment processing", "semiconductor supply chain outlook".

keywords: company, business, due diligence, competitor, executive, CEO, founder, funding, valuation, revenue, earnings, stock, profile, who is, what does company do, compare companies`,
  inputSchema: {
    type: "object",
    properties: {
      ...sharedSearchProperties(
        "query", "count", "include_domains", "exclude_domains",
        "time_basis", "time_range", "start_time", "end_time",
        "language", "highlight", "full_content", "timeout",
      ),
      entities: {
        type: "object",
        description:
          "The company and person cards. On by default — omit to use the " +
          "server default, or disable for a plain ranked list. The domain, " +
          "time and language filters apply to the ranked results only, never " +
          "to the cards.",
        properties: {
          enable: { type: "boolean", default: true, description: "Whether to return entity cards." },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 2,
            description: "How many entities to profile (1-20).",
          },
          max_activities: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Max recent posts/announcements per entity (1-20).",
          },
          max_news: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Max news items per entity (1-20).",
          },
        },
      },
    },
    required: ["query"],
  },
};

interface BusinessSearchArgs {
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
  entities?: { enable?: boolean; count?: number; max_activities?: number; max_news?: number };
  timeout?: number;
}

/**
 * Flatten one value onto a single line.
 *
 * The card fields are documented by name but not by inner shape, and they
 * differ between a company and a person, so this renders whatever arrives
 * rather than reaching for fields that may not be there. A field the API adds
 * later shows up on its own instead of being silently dropped.
 */
function flatten(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join("; ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => {
        const f = flatten(val);
        return f ? `${k}=${f}` : "";
      })
      .filter(Boolean)
      .join(", ");
  }
  return String(v);
}

/** `label: value`, or nothing when the value is absent or empty. */
function field(label: string, v: unknown): string {
  const f = flatten(v);
  return f ? `${label}: ${f}` : "";
}

/** A news item or activity, as one line. */
function itemLine(n: any): string {
  if (typeof n !== "object" || n == null) return flatten(n) ? `  - ${flatten(n)}` : "";
  const head = n.title || n.name || n.text || n.summary || "(untitled)";
  const when = n.time_published || n.time || n.date;
  return `  - ${head}${when ? ` (${when})` : ""}${n.url ? ` — ${n.url}` : ""}`;
}

/** An entity card: the part of the answer the ranked results would otherwise have to be read for. */
function formatEntity(e: any, idx: number, total: number): string {
  const kind = e?.linkedin_url || e?.current_position || e?.career ? "Person" : "Company";
  const lines = [`## ${kind} ${idx}/${total}: ${e?.name || "(unnamed)"}`];

  if (e?.summary) lines.push(e.summary);

  for (const [label, key] of [
    ["Also known as", "aliases"], ["Identifiers", "identifiers"],
    ["Attributes", "attributes"], ["Metrics", "metrics"],
    ["Key people", "key_people"], ["Position", "current_position"],
    ["Career", "career"], ["LinkedIn", "linkedin_url"],
  ] as const) {
    const line = field(label, e?.[key]);
    if (line) lines.push(line);
  }

  for (const [label, key] of [["Recent", "activities"], ["News", "news"]] as const) {
    const items = Array.isArray(e?.[key]) ? e[key] : [];
    if (items.length) lines.push(`${label}:`, ...items.map(itemLine).filter(Boolean));
  }

  return lines.join("\n");
}

/** Handler — POSTs to Octen Business Search and reshapes the response for the LLM. */
export async function handleBusinessSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as BusinessSearchArgs;

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

  // Drop undefined fields so server defaults apply — `entities` in particular
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
      path: "/business-search",
      body,
      label: "Octen Business Search",
      timeoutSec: timeout,
      defaultTimeoutSec: BUSINESS_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen Business Search", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Business Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const results = data?.data?.results ?? [];
  const entities = data?.data?.entities ?? [];
  const meta = data?.meta ?? {};

  if (results.length === 0 && entities.length === 0) {
    return { content: [{ type: "text", text: `No business results for "${args.query}".` }] };
  }

  // Cards first: they are what this tool is for, and a model that stops
  // reading after them should already have the answer.
  const blocks = [
    ...entities.map((e: any, i: number) => formatEntity(e, i + 1, entities.length)),
    ...results.map((r: any, i: number) => formatResult(r, i + 1, results.length)),
  ];
  const text = [...blocks, formatMeta(meta, data?.request_id)].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
