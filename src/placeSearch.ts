/**
 * `place_search` tool — wraps Octen Place Search
 * (https://docs.octen.ai/api-reference/place-search).
 *
 * Not a web-search variant, which is why it shares nothing with `search`'s
 * schema. Three things differ. Places are the output and web pages are opt-in
 * (`web_search.enable` defaults to false, the inverse of every other search
 * here). The web filters nest under `web_search` rather than sitting beside
 * `query`. And it takes a location — coordinates with an optional radius, or
 * an approximate city — which nothing else does.
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
const PLACE_SEARCH_TIMEOUT_SEC = 30;

const LANGUAGES = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko",
                   "nl", "pl", "pt", "ru", "th", "tr", "vi", "zh"];

export const placeSearchTool: Tool = {
  name: "place_search",
  title: "Place Search",
  annotations: {
    title: "Place Search",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Find real-world places and get each one back as a card: name, category, address, coordinates, phone, website, opening hours, status (open / closed / permanently closed), rating and review count. Pass \`latitude\` and \`longitude\` to search around a point — each card then carries its \`distance\` in metres — and \`radius\` to cap how far. When you only know the city, pass \`user_location\` instead. A query that names its own area ("ramen in Shinjuku") works without either.

USE FOR anything with a location: "coffee shops near me", "family-friendly restaurants", "museums in Lisbon", "is this place open on Sunday", "what's their phone number". The cards answer these directly — \`search\` would return pages *about* places that then have to be read.

Set \`places.max_reviews\` (0-5) when what reviewers actually wrote is the question — "is it good for groups", "do people complain about the wait". Off by default: review text is long, and \`rating\` plus \`review_count\` already come on every card.

Set \`web_search.enable\` to true when the pages discussing these places matter too (round-ups, articles). It is off by default: the places are the answer here, and the pages cost context.

ALWAYS pass the caller's location when you have it. Without it a query that names no area is not limited to one, and "near me" means nothing.

keywords: places, near me, nearby, restaurant, cafe, coffee shop, bar, hotel, museum, shop, store, address, directions, opening hours, phone number, rating, reviews, local, map`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "What to look for, e.g. 'coffee shops' or 'ramen in Shinjuku'. Max 500 chars.",
      },
      latitude: {
        type: "number",
        minimum: -90,
        maximum: 90,
        description: "WGS84 latitude to search around. Must be sent with `longitude`.",
      },
      longitude: {
        type: "number",
        minimum: -180,
        maximum: 180,
        description: "WGS84 longitude to search around. Must be sent with `latitude`.",
      },
      radius: {
        type: "integer",
        minimum: 1,
        maximum: 50000,
        description:
          "Keep only places within this many metres of the point. Requires " +
          "`latitude` and `longitude`. Omit for no distance limit.",
      },
      user_location: {
        type: "object",
        description:
          "Approximate location, for when coordinates are unknown. No " +
          "`distance` is returned without coordinates.",
        properties: {
          type: { type: "string", enum: ["approximate"], description: "Only `approximate` is accepted." },
          city: { type: "string", description: "City name." },
          region: { type: "string", description: "State, province or region." },
          country: { type: "string", description: "Country name or code." },
          timezone: { type: "string", description: "IANA timezone, e.g. 'Asia/Tokyo'." },
        },
      },
      places: {
        type: "object",
        description: "What to return per place. Omit to use the server defaults.",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Places to return (1-20).",
          },
          max_reviews: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Review excerpts to return per place (0-5). Defaults to 0 — " +
              "review text runs long, so ask for it only when what people " +
              "actually said is the question. `rating` and `review_count` " +
              "come back either way.",
          },
        },
      },
      web_search: {
        type: "object",
        description:
          "Also return web pages about these places. Off by default — turn it " +
          "on only when the pages themselves matter, since they cost context.",
        properties: {
          enable: { type: "boolean", default: false, description: "Whether to return web results." },
          count: { type: "integer", minimum: 1, maximum: 100, default: 5, description: "Web results (1-100)." },
          highlight: {
            type: "object",
            description: "Ranked snippet per web result.",
            properties: {
              enable: { type: "boolean", default: true, description: "Whether to return highlights." },
              max_tokens: { type: "integer", minimum: 100, maximum: 20000, default: 512, description: "Max tokens per highlight." },
            },
          },
          full_content: {
            type: "object",
            description: "Cleaned page body per web result. Heavier than `highlight`.",
            properties: {
              enable: { type: "boolean", default: false, description: "Whether to return full content." },
              max_tokens: { type: "integer", minimum: 100, maximum: 100000, default: 2048, description: "Max tokens per page." },
            },
          },
          include_domains: {
            type: "array",
            items: { type: "string", maxLength: 60 },
            maxItems: 1200,
            description: "Only return web results from these domains. Max 1200, each ≤60 chars.",
          },
          exclude_domains: {
            type: "array",
            items: { type: "string", maxLength: 60 },
            maxItems: 1200,
            description: "Drop web results from these domains. Max 1200, each ≤60 chars.",
          },
          language: {
            type: "array",
            items: { type: "string", enum: LANGUAGES },
            default: [],
            description: "Languages to filter web results by, as ISO 639-1 codes.",
          },
          time_basis: {
            type: "string",
            enum: ["auto", "published", "crawled"],
            default: "auto",
            description: "Which timestamp the web-result time window filters against.",
          },
          time_range: {
            type: "string",
            enum: ["day", "week", "month", "year", "d", "w", "m", "y"],
            description: "Relative time window for web results. The absolute range wins if both are given.",
          },
          start_time: { type: "string", description: "Lower bound for web results, ISO 8601." },
          end_time: { type: "string", description: "Upper bound for web results, ISO 8601." },
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

interface PlaceSearchArgs {
  query: string;
  latitude?: number;
  longitude?: number;
  radius?: number;
  user_location?: Record<string, unknown>;
  places?: { count?: number; max_reviews?: number };
  web_search?: Record<string, unknown>;
  timeout?: number;
}

/** `1.2 km` / `450 m` — metres are what the API returns, km is what a reader wants past a point. */
function distance(m: unknown): string {
  if (typeof m !== "number" || !Number.isFinite(m)) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/**
 * One place card.
 *
 * The API omits whatever it could not resolve, so every line here is
 * conditional — a card with no phone should not print an empty `Phone:`.
 */
function formatPlace(p: any, idx: number, total: number): string {
  const head = [`## Place ${idx}/${total}: ${p?.name || "(unnamed)"}`];
  const sub = [p?.category, distance(p?.distance)].filter(Boolean).join(" · ");
  if (sub) head.push(sub);
  if (p?.address) head.push(p.address);

  // Rating and status are what decides whether a place is worth going to, so
  // they sit above the contact details rather than in a trailing dump.
  const rating = typeof p?.rating === "number"
    ? `${p.rating}/5${typeof p.review_count === "number" ? ` (${p.review_count} reviews)` : ""}`
    : "";
  const line = [rating, p?.status].filter(Boolean).join(" · ");
  if (line) head.push(line);

  if (p?.phone) head.push(`Phone: ${p.phone}`);
  if (p?.website) head.push(`Website: ${p.website}`);

  const hours = Array.isArray(p?.opening_hours) ? p.opening_hours.filter(Boolean) : [];
  if (hours.length) head.push("Hours:", ...hours.map((h: string) => `  ${h}`));

  if (p?.attributes && typeof p.attributes === "object") {
    // `false` is rendered, not dropped: "not wheelchair accessible" is the
    // kind of fact someone chooses a place on, and dropping it would make a
    // definite no read the same as an unknown.
    const attrs = Object.entries(p.attributes)
      .map(([k, v]) => (v === true ? k : v === false ? `no ${k}` : v == null ? "" : `${k}=${v}`))
      .filter(Boolean)
      .join(", ");
    if (attrs) head.push(`Attributes: ${attrs}`);
  }

  if (typeof p?.latitude === "number" && typeof p?.longitude === "number") {
    head.push(`Coordinates: ${p.latitude}, ${p.longitude}`);
  }

  // Last, because review text is the longest thing on the card and the
  // structured facts above are what most questions turn on. Only present when
  // the caller asked for it via `places.max_reviews`, so nothing is rendered
  // that was not paid for — and nothing that was paid for is dropped.
  const reviews = Array.isArray(p?.reviews) ? p.reviews.filter(Boolean) : [];
  if (reviews.length) {
    head.push("Reviews:");
    for (const r of reviews) {
      const stamp = [
        typeof r?.rating === "number" ? `${r.rating}/5` : "",
        r?.time_published || "",
      ].filter(Boolean).join(" · ");
      if (stamp) head.push(`  ${stamp}`);
      // The text carries the reviewer's own line breaks; indenting each line
      // keeps a multi-paragraph review from reading as new card fields.
      const text = typeof r?.text === "string" ? r.text.trim() : "";
      if (text) head.push(...text.split("\n").map((l: string) => `  ${l}`));
    }
  }

  return head.join("\n");
}

/** Handler — POSTs to Octen Place Search and reshapes the response for the LLM. */
export async function handlePlaceSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as PlaceSearchArgs;

  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return errorResult("`query` must be a non-empty string");
  }

  // The API answers these with a 400. Catching them here costs a round trip
  // less and names the missing half, which the status code cannot.
  const hasLat = args.latitude !== undefined;
  const hasLon = args.longitude !== undefined;
  if (hasLat !== hasLon) {
    return errorResult(
      `\`${hasLat ? "latitude" : "longitude"}\` was given without \`${hasLat ? "longitude" : "latitude"}\` — a point needs both.`
    );
  }
  if (args.radius !== undefined && !hasLat) {
    return errorResult("`radius` needs `latitude` and `longitude` — it measures from that point.");
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

  // Drop undefined fields so server defaults apply — `places` and
  // `web_search` in particular, whose defaults are the API's to move.
  const body: Record<string, unknown> = { query: payloadArgs.query };
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (key !== "query" && value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      forward: ctx?.forward,
      path: "/place-search",
      body,
      label: "Octen Place Search",
      timeoutSec: timeout,
      defaultTimeoutSec: PLACE_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen Place Search", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim.
  if (typeof data?.code === "number" && data.code !== 0) {
    return errorResult(
      `Octen Place Search: code=${data.code} msg=${data.msg ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  const places = data?.data?.places ?? [];
  // Only present when web_search.enable was true.
  const results = data?.data?.results ?? [];
  const meta = data?.meta ?? {};

  if (places.length === 0 && results.length === 0) {
    return { content: [{ type: "text", text: `No places for "${args.query}".` }] };
  }

  const blocks = [
    ...places.map((p: any, i: number) => formatPlace(p, i + 1, places.length)),
    ...results.map((r: any, i: number) => formatResult(r, i + 1, results.length)),
  ];
  const text = [...blocks, formatMeta(meta, data?.request_id)].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
