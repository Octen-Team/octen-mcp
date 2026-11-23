/**
 * `design_search` tool — wraps Octen Design Search
 * (https://docs.octen.ai/api-reference/design-search).
 *
 * Searches screenshots of real web pages, page sections, mobile app screens
 * and slides, and returns each with the design values behind it — plus, for
 * page sections, the HTML.
 *
 * Design results used to be reachable only through `image_search` with
 * `topic: design`, which 0.7.0 withdrew pending an endpoint of its own. This
 * is the tool for that endpoint — a different request and a different
 * response, not the old parameters under a new name. `image_search` still
 * takes no `topic` and no `html_snippet`.
 *
 * Shaped like `place_search` rather than `search`: two result groups, each
 * with its own options — the designs under `images`, the pages written about
 * them under `web_search`. Both are on by default at the API.
 *
 * One thing no other tool here does: an image can belong to a group (the page
 * a section was cut from, the deck a slide came out of), and a second call
 * with `images.group_id` returns that whole group in order, with no query.
 *
 * Same envelope (`{code, msg, data, meta}`) and `x-api-key` auth as search.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatResult, formatMeta, errorResult, renderEach, resultEntries } from "./search.js";
import {
  postJson, OctenHttpError, bodyReadFailure, nonEnvelopeFailure, isOctenEnvelope, missingKeyMessage,
  type HandlerContext,
} from "./http.js";

const API_KEY = process.env.OCTEN_API_KEY;
const DESIGN_SEARCH_TIMEOUT_SEC = 30;

const LANGUAGES = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko",
                   "nl", "pl", "pt", "ru", "th", "tr", "vi", "zh"];

export const designSearchTool: Tool = {
  name: "design_search",
  title: "Design Search — real page, app screen and slide references",
  annotations: {
    title: "Design Search — real page, app screen and slide references",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description:
    `Find real designs to build from: screenshots of live web pages, single page sections, mobile app screens and presentation slides, each returned with the design values behind it — colours, fonts and font sizes, or the components of an app screen — and, for page sections, the HTML. Articles, guidelines and tutorials on the same query come back alongside as ranked web results.

USE FOR building or restyling an interface or a deck from real references instead of from memory: "pricing section for a SaaS landing page", "iOS onboarding screen", "seed round pitch deck", "dark analytics dashboard". Describe what is being built. For photos, diagrams and other general images use \`image_search\`; for ordinary web pages use \`search\`.

Each image comes back as a link to the screenshot and a thumbnail. The links are signed and time-limited — view or download them now rather than storing them.

A page section or a slide names the page or deck it belongs to: a \`group_id\`, its position, and how many images the group holds. To get the rest in order, call again with \`images.group_id\` set to that id and \`images.count\` set to the group's total, or to 100 if the group is larger — 100 is the most one call returns, and left at its default the call returns only the first 5. That call needs no \`query\`.

The response is large, so switch off what the task does not need: \`web_search.enable: false\` when only the designs matter, \`images.enable: false\` when only the writing does, \`images.snippet.enable: false\` to leave out the HTML, \`images.design_facts: false\` to leave out the values.

keywords: design reference, UI design, UX, web design, landing page, page section, hero, pricing section, dashboard, app screen, mobile UI, slide, pitch deck, presentation, design tokens, colors, fonts, typography, HTML snippet, inspiration, mockup`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description:
          "What is being designed, e.g. 'pricing section for a SaaS landing " +
          "page'. Max 500 chars. Required unless `images.group_id` is set.",
      },
      images: {
        type: "object",
        description:
          "The design references, and what comes with each. On by default — " +
          "omit to use the server defaults.",
        properties: {
          enable: { type: "boolean", default: true, description: "Whether to return image results." },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 5,
            description:
              "Image results to return (1-100). For a group lookup, set it to " +
              "the group's total to get the whole page or deck — or to 100 for " +
              "a larger group, which is the most one call returns.",
          },
          design_facts: {
            type: "boolean",
            default: true,
            description:
              "Return each image's design values — colours, fonts and font " +
              "sizes, or an app screen's components.",
          },
          snippet: {
            type: "object",
            description: "Reusable HTML, for the image results that have it (page sections).",
            properties: {
              enable: { type: "boolean", default: true, description: "Whether to return the code." },
              max_tokens: {
                type: "integer",
                minimum: 100,
                maximum: 100000,
                default: 5000,
                description: "Max tokens of code per image (100-100000).",
              },
            },
          },
          group_id: {
            type: "string",
            description:
              "Return the images of this group, in group order, instead of " +
              "searching by `query`. Takes the `group_id` returned with a page " +
              "section or a slide.",
          },
        },
      },
      web_search: {
        type: "object",
        description:
          "The web pages on the same query — articles, guidelines, tutorials. " +
          "On by default; these options never affect the image results.",
        properties: {
          enable: { type: "boolean", default: true, description: "Whether to return web results." },
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
    // No `required`: `query` is optional when `images.group_id` is set, a rule
    // spanning two fields that this schema vocabulary cannot state. Requiring
    // `query` would make the documented group lookup unreachable; the handler
    // enforces the real rule and names both fields.
  },
};

interface DesignSearchArgs {
  query?: string;
  images?: {
    enable?: boolean;
    count?: number;
    design_facts?: boolean;
    snippet?: { enable?: boolean; max_tokens?: number };
    group_id?: string;
  };
  web_search?: { enable?: boolean } & Record<string, unknown>;
  timeout?: number;
}

/** A non-empty plain object — the API sends `{}` where it has nothing to say. */
function hasContent(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
}

/**
 * A fenced block that the code inside it cannot close.
 *
 * The snippet is HTML lifted from a real page, and a page that documents
 * Markdown or shows code samples carries backtick runs of its own. A fixed
 * three-backtick fence would end at the first of them and spill the rest of
 * the page into the surrounding result.
 */
function fenced(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

/**
 * One design reference.
 *
 * Every line is conditional, because what an image carries depends on what it
 * is: an app screen has no source page and belongs to no group, only page
 * sections come with code, and the caller can switch the values and the code
 * off. A missing part prints nothing rather than an empty label.
 */
function formatImage(im: any, idx: number, total: number): string {
  const lines = [`## Image ${idx}/${total}: ${im?.title || "(untitled)"}`];

  const size = typeof im?.width === "number" && typeof im?.height === "number"
    ? `${im.width}x${im.height}` : "";
  const kind = [im?.type, size].filter(Boolean).join(" · ");
  if (kind) lines.push(kind);

  if (im?.url) lines.push(im.url);
  if (im?.thumbnail) lines.push(`**Thumbnail:** ${im.thumbnail}`);
  if (im?.source_page) lines.push(`**Source page:** ${im.source_page}`);

  // Everything a follow-up call needs sits on one line: which group, where
  // this image is in it, and how many there are to ask for.
  const g = im?.group;
  if (g?.group_id) {
    const where = typeof g.position === "number" && typeof g.total === "number"
      ? ` — ${g.position} of ${g.total}` : "";
    const label = [g.name, g.type ? `(${g.type})` : ""].filter(Boolean).join(" ");
    lines.push(`**Group:** ${label}${where} · group_id: ${g.group_id}`);
    if (hasContent(g.master)) lines.push(`**Deck master:** ${JSON.stringify(g.master)}`);
  }

  if (typeof im?.description === "string" && im.description.length > 0) {
    lines.push(`\n### Description\n${im.description}`);
  }

  // Passed through as data, not picked apart. The reference says these fields
  // vary by image, and they do — a web page returns design tokens, a slide
  // returns font and colour lists, an app screen returns a component census —
  // so a renderer that named fields would silently drop whichever shape it
  // was not written for.
  if (hasContent(im?.design_facts)) {
    lines.push(`\n### Design values\n${JSON.stringify(im.design_facts)}`);
  }

  const code = im?.snippet?.code;
  if (typeof code === "string" && code.length > 0) {
    const format = typeof im.snippet.format === "string" && /^[a-z0-9]+$/i.test(im.snippet.format)
      ? im.snippet.format : "";
    lines.push(`\n### Code\n${fenced(code, format)}`);
  }

  return lines.join("\n");
}

/** Handler — POSTs to Octen Design Search and reshapes the response for the LLM. */
export async function handleDesignSearch(rawArgs: Record<string, unknown>, ctx?: HandlerContext): Promise<CallToolResult> {
  const args = rawArgs as unknown as DesignSearchArgs;

  const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
  const groupId = typeof args.images?.group_id === "string" ? args.images.group_id.trim() : "";
  const imagesOff = args.images?.enable === false;
  const webOff = args.web_search?.enable === false;

  // Each of these is refused here rather than sent. The API answers the first
  // and the second with a bare `Invalid params.`, which names neither field.
  if (!hasQuery && groupId === "") {
    return errorResult(
      "`query` must be a non-empty string, unless `images.group_id` names a group to fetch."
    );
  }
  if (groupId !== "" && imagesOff) {
    return errorResult(
      "`images.group_id` asks for a group's images, but `images.enable` is false — drop one of the two."
    );
  }
  // The third it does not refuse at all. Verified against the API: with both
  // groups off it answers with a success that carries no results and still
  // counts as a search, so the caller pays for a response that cannot contain
  // anything.
  if (imagesOff && webOff) {
    return errorResult(
      "`images.enable` and `web_search.enable` are both false, so nothing would be returned — leave at least one on."
    );
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
  const { timeout, query, images: imageArgs, ...payloadArgs } = args;

  // Drop undefined fields so server defaults apply — both groups are on by
  // default at the API, and that default is the API's to move. A blank `query`
  // is dropped too: on a group lookup there is nothing to search for.
  const body: Record<string, unknown> = {};
  if (hasQuery) body.query = query;
  if (imageArgs !== undefined) {
    // The id that was checked above is the id that is sent. It was trimmed to
    // decide whether a group was asked for and it is what the result names, so
    // sending the caller's untrimmed value would let the API miss the group
    // while the message shows an id that looks right. A blank one is no group.
    // Built as a copy: the caller's own object is not rewritten.
    const { group_id: _asGiven, ...imageOptions } = imageArgs;
    body.images = groupId !== "" ? { ...imageOptions, group_id: groupId } : imageOptions;
  }
  for (const [key, value] of Object.entries(payloadArgs)) {
    if (value !== undefined) body[key] = value;
  }

  let resp: Response;
  try {
    resp = await postJson({
      apiKey,
      forward: ctx?.forward,
      path: "/design-search",
      body,
      label: "Octen Design Search",
      timeoutSec: timeout,
      defaultTimeoutSec: DESIGN_SEARCH_TIMEOUT_SEC,
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
    return errorResult(bodyReadFailure("Octen Design Search", resp, e));
  }

  // Envelope-level error: surface code + msg verbatim. Only on a response
  // that is Octen's — a gateway's own numeric `code` is not an Octen error,
  // and falls through to the check below with its message intact.
  if (isOctenEnvelope(data) && typeof data.code === "number" && data.code !== 0) {
    return errorResult(
      // `msg` is the envelope's own field. `message` is what a hop in front
      // of the API says when it passes the request id through but answers in
      // its own words; it is still the only explanation there is.
      `Octen Design Search: code=${data.code} msg=${data.msg ?? data.message ?? "(no msg)"}` +
      (data.request_id ? ` request_id=${data.request_id}` : "")
    );
  }

  // A failing status with no Octen code, or a body that is not Octen's at
  // all, is an outage or a routing mistake — not a search that found nothing,
  // and not a group that is empty.
  const outage = nonEnvelopeFailure("Octen Design Search", resp, data);
  if (outage) return errorResult(outage);

  // Each key is present only when its group was enabled. `data.specs` also
  // arrives on every response; the reference does not document it, so it is
  // neither rendered nor counted as content.
  const images = resultEntries(data?.data?.images);
  const results = resultEntries(data?.data?.results);
  const meta = data?.meta ?? {};

  // The API answers a group id it does not know with a success and empty
  // arrays, not an error — so an empty group has to be said out loud, or the
  // caller cannot tell a wrong id from a search that found nothing.
  const emptyGroup = groupId !== "" && images.length === 0 ? `No images in group ${groupId}.` : "";

  const metaLine = formatMeta(meta, data?.request_id);

  if (images.length === 0 && results.length === 0) {
    // The meta line travels with an empty result too: "nothing found" and
    // "nothing found, and here is the API's warning about why" are different
    // answers, and the request id is what a support request needs.
    // With images switched off no design was searched for, so the empty
    // answer names the search that did run.
    const said = emptyGroup ||
      (imagesOff ? `No web results for "${args.query}".` : `No design references for "${args.query}".`);
    return { content: [{ type: "text", text: [said, metaLine].filter(Boolean).join("\n\n") }] };
  }

  // Images first: the designs are the answer, and the pages written about
  // them are context for it.
  const blocks = [
    emptyGroup,
    ...renderEach(images, "Image", formatImage),
    ...renderEach(results, "Result", formatResult),
  ];
  const text = [...blocks, metaLine].filter(Boolean).join("\n\n---\n\n");

  return { content: [{ type: "text", text }] };
}
