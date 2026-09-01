/**
 * Unit tests for request-body assembly in the search tools (built output).
 *
 * Run with `npm test` (builds first, then `node --test test/`). The HTTP
 * layer's fetch is stubbed through its test seam so no network traffic
 * happens; we assert on the outgoing payload. (`globalThis.fetch` would be a
 * no-op to stub: the module fetches through the packaged undici.)
 */
import test from "node:test";
import assert from "node:assert/strict";

// The module reads OCTEN_API_KEY at import time — set it before importing.
process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { searchTool, newsSearchTool, broadSearchTool, handleSearch, handleNewsSearch, handleBroadSearch } =
  await import("../dist/search.js");
const { _setFetchForTests } = await import("../dist/http.js");

/** Stub the HTTP layer's fetch for one call; returns the captured {url, body}. */
function captureFetch(responseData = { code: 0, data: { results: [] } }) {
  const captured = {};
  _setFetchForTests(async (url, init) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return {
      status: 200,
      json: async () => responseData,
    };
  });
  return captured;
}

test("search: schema advertises `query` (required) and `count`", () => {
  const props = searchTool.inputSchema.properties;
  assert.ok(props.query, "query missing from search inputSchema");
  assert.ok(props.count, "count missing from search inputSchema");
  assert.equal(props.count.default, 5);
  assert.ok(searchTool.inputSchema.required.includes("query"));
});

test("news_search: schema inherits `count`, drops `topic`", () => {
  assert.ok(newsSearchTool.inputSchema.properties.count);
  assert.equal(newsSearchTool.inputSchema.properties.topic, undefined);
});

test("broad_search: schema inherits `count` and adds `max_queries`", () => {
  assert.ok(broadSearchTool.inputSchema.properties.count);
  assert.ok(broadSearchTool.inputSchema.properties.max_queries);
});

const LANGUAGE_ENUM = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pl", "pt", "ru", "th", "tr", "vi", "zh"];

test("search: schema advertises `language` as an enum array (ISO 639-1)", () => {
  const lang = searchTool.inputSchema.properties.language;
  assert.ok(lang, "language missing from search inputSchema");
  assert.equal(lang.type, "array");
  assert.equal(lang.items.type, "string");
  assert.deepEqual(lang.items.enum, LANGUAGE_ENUM);
  assert.deepEqual(lang.default, []);
});

test("news_search: schema inherits `language`", () => {
  const lang = newsSearchTool.inputSchema.properties.language;
  assert.ok(lang, "language missing from news_search inputSchema");
  assert.equal(lang.type, "array");
  assert.deepEqual(lang.items.enum, LANGUAGE_ENUM);
});

test("broad_search: schema inherits `language`", () => {
  const lang = broadSearchTool.inputSchema.properties.language;
  assert.ok(lang, "language missing from broad_search inputSchema");
  assert.equal(lang.type, "array");
  assert.deepEqual(lang.items.enum, LANGUAGE_ENUM);
});

test("search: `query` and `count` are sent top-level in the /search body", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "best local pizza", count: 2 });
  assert.ok(captured.url.endsWith("/search"));
  assert.equal(captured.body.query, "best local pizza");
  assert.equal(captured.body.count, 2);
});

test("search: optional `count` is omitted from the body when unset", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "best local pizza" });
  assert.equal(captured.body.query, "best local pizza");
  assert.equal("count" in captured.body, false);
});

test("search: `language` lands top-level in the /search body when set", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "climate change", language: ["ja", "en"] });
  assert.deepEqual(captured.body.language, ["ja", "en"]);
});

test("search: `language` omitted from the body when unset", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "climate change" });
  assert.equal("language" in captured.body, false);
});

test("news_search: `language` passes through top-level", async () => {
  const captured = captureFetch();
  await handleNewsSearch({ query: "chip news", language: ["de"] });
  assert.deepEqual(captured.body.language, ["de"]);
  assert.equal(captured.body.topic, "news");
});

test("broad_search: `language` nests under search_options, never top-level", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ai news", language: ["en"], max_queries: 2 });
  assert.equal("language" in captured.body, false, "language must not be top-level on /broad-search");
  assert.deepEqual(captured.body.search_options.language, ["en"]);
});

test("broad_search: `language` absent from search_options when unset", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ai news", count: 2 });
  assert.equal("language" in captured.body.search_options, false);
});

test("news_search: options pass through top-level, topic forced to news", async () => {
  const captured = captureFetch();
  await handleNewsSearch({ query: "chip news", count: 3 });
  assert.equal(captured.body.count, 3);
  assert.equal(captured.body.topic, "news");
});

test("broad_search: search options are nested under search_options, not top-level", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ev charging networks", count: 2, max_queries: 2 });
  assert.ok(captured.url.endsWith("/broad-search"));
  assert.equal(captured.body.query, "ev charging networks");
  assert.equal(captured.body.max_queries, 2);
  assert.equal("count" in captured.body, false, "count must not be top-level on /broad-search");
  assert.equal(captured.body.search_options.count, 2);
});

test("broad_search: search_options omitted when no per-sub-query options set", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ev charging networks" });
  assert.equal("search_options" in captured.body, false);
});

// ---- Media fields in the rendered result -------------------------------------
//
// `include_images` costs the caller an upstream fetch and
// promise, in the tool's own description, to "return media URLs per result".
// Two ways that promise was broken, both measured against the live API:
// `cover_image` is `{url, description}` and was interpolated as an object, so
// every result carrying one printed `[object Object]`; and the `images` /
// `videos` arrays were rendered as a bare count, so a result with 101 image
// URLs produced the text "**Images:** 101" and not one usable link.

/** A result shaped like the API's, with `n` images. */
const resultWithMedia = (n) => ({
  code: 0,
  data: {
    results: [{
      title: "T", url: "https://example.com/page",
      cover_image: { url: "https://cdn.example.com/cover.jpg", description: "Cover" },
      images: Array.from({ length: n }, (_, i) => ({
        url: `https://cdn.example.com/img${i}.jpg`, description: `caption ${i}`,
      })),
      videos: [{ url: "https://cdn.example.com/clip.mp4", description: "clip" }],
    }],
  },
});

test("cover_image renders its URL, not the object it arrives as", async () => {
  captureFetch(resultWithMedia(2));
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  assert.doesNotMatch(out, /\[object Object\]/, "the object was interpolated instead of its url");
  assert.match(out, /\*\*Cover image:\*\* https:\/\/cdn\.example\.com\/cover\.jpg/);
});

test("image and video URLs are printed, not just counted", async () => {
  captureFetch(resultWithMedia(3));
  // No `include_videos` on search — the API reference documents none, so the
  // tool does not advertise one. The renderer is still exercised: a response
  // carrying `videos` must not have them dropped.
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  for (let i = 0; i < 3; i++) {
    assert.match(out, new RegExp(`- https://cdn\\.example\\.com/img${i}\\.jpg`),
      `image ${i}'s URL is missing — a count is not something a caller can act on`);
  }
  assert.match(out, /- https:\/\/cdn\.example\.com\/clip\.mp4/);
  // The count is still useful; it just cannot be the whole answer.
  assert.match(out, /\*\*Images:\*\* 3/);
});

test("a long media list is capped, and says how many were left out", async () => {
  // 101 was the real number from one search. Pasting them all into a model's
  // context costs more than the answer is worth — but dropping them silently
  // is how this got broken in the first place, so the total has to be stated.
  captureFetch(resultWithMedia(101));
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  const listed = (out.match(/^- https:\/\/cdn\.example\.com\/img\d+\.jpg —/gm) ?? []).length;
  assert.equal(listed, 10, `printed ${listed} of 101 URLs`);
  assert.match(out, /\*\*Images:\*\* 101 — first 10:/, "a cap the reader cannot see is a silent drop");
});

test("malformed or absent media does not produce empty or broken lines", async () => {
  captureFetch({
    code: 0,
    data: {
      results: [{
        title: "T", url: "https://example.com/",
        cover_image: {},                       // present but no url
        images: [{ description: "no url" }],   // entries without urls
        videos: [],
      }],
    },
  });
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  assert.doesNotMatch(out, /Cover image/, "an object with no url must not render a label");
  assert.doesNotMatch(out, /\*\*Images:\*\*/, "entries with no url leave nothing to list");
  assert.doesNotMatch(out, /undefined|\[object Object\]/);
});

test("extract renders media the same way search does", async () => {
  // The two rendered media differently — extract handled `cover_image`
  // correctly while search did not, and both printed bare counts. They share
  // one renderer now; this fails if a second copy reappears.
  const { handleExtract } = await import("../dist/extract.js");
  captureFetch({
    code: 0,
    data: {
      results: [{
        url: "https://example.com/a", title: "T",
        cover_image: { url: "https://cdn.example.com/cover.jpg" },
        images: [{ url: "https://cdn.example.com/i0.jpg" }, { url: "https://cdn.example.com/i1.jpg" }],
        videos: [{ url: "https://cdn.example.com/v0.mp4" }],
        audio: [{ url: "https://cdn.example.com/a0.mp3" }],
      }],
    },
  });
  const out = (await handleExtract({
    urls: ["https://example.com/a"], include_images: true, include_videos: true, include_audio: true,
  })).content[0].text;
  for (const u of ["cover.jpg", "i0.jpg", "i1.jpg", "v0.mp4", "a0.mp3"]) {
    assert.match(out, new RegExp(u.replace(".", "\\.")), `${u} was dropped`);
  }
  assert.doesNotMatch(out, /\[object Object\]/);
});

test("each media entry carries its caption, not just its URL", async () => {
  // The caption is the point on news results: it carries what was
  // photographed, where, when, and the photographer's credit. A bare link
  // leaves the model with nothing it can say about the picture.
  captureFetch(resultWithMedia(2));
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  assert.match(out, /- https:\/\/cdn\.example\.com\/img0\.jpg — caption 0/);
  assert.match(out, /- https:\/\/cdn\.example\.com\/img1\.jpg — caption 1/);
  assert.match(out, /\*\*Cover image:\*\* https:\/\/cdn\.example\.com\/cover\.jpg — Cover/);
});

test("a media entry with no caption renders as a bare URL, with no dangling separator", async () => {
  captureFetch({
    code: 0,
    data: {
      results: [{
        title: "T", url: "https://example.com/",
        cover_image: { url: "https://cdn.example.com/c.jpg" },          // no description
        images: [{ url: "https://cdn.example.com/i.jpg", description: "   " }], // blank one
      }],
    },
  });
  const out = (await handleSearch({ query: "q", include_images: true })).content[0].text;
  assert.match(out, /\*\*Cover image:\*\* https:\/\/cdn\.example\.com\/c\.jpg$/m);
  assert.match(out, /- https:\/\/cdn\.example\.com\/i\.jpg$/m);
  assert.doesNotMatch(out, /—\s*$/m, "a missing caption must not leave a trailing dash");
});

// ---- image_search takes exactly one input ------------------------------------
//
// The API's `inputs` array is documented `maxItems: 1` — "Currently only a
// single input is supported: either one text input or one image input." The
// tool used to require `query` and describe `image_url` as usable "in addition"
// to it, which inverted both halves of that rule: the combination it advertised
// was refused upstream with `Invalid params. Inputs exceeds 1 entries`, while
// the documented image-only search could not be expressed at all.

test("image_search sends exactly one input, text or image", async () => {
  const { handleImageSearch } = await import("../dist/imageSearch.js");

  let cap = captureFetch();
  await handleImageSearch({ query: "dog" });
  assert.deepEqual(cap.body.inputs, [{ type: "text", data: "dog" }]);

  cap = captureFetch();
  await handleImageSearch({ image_url: "https://cdn.example.com/a.jpg" });
  assert.deepEqual(cap.body.inputs, [{ type: "image", url: "https://cdn.example.com/a.jpg" }],
    "an image-only search is documented and must be reachable");
});

test("image_search refuses both inputs, and refuses neither", async () => {
  const { handleImageSearch } = await import("../dist/imageSearch.js");

  // Every pair, and the triple: the rule is "exactly one", so each way of
  // breaking it has to be caught, and the message has to name what was sent.
  for (const args of [
    { query: "dog", image_url: "https://cdn.example.com/a.jpg" },
    { query: "dog", image_data: "AAAA" },
    { image_url: "https://cdn.example.com/a.jpg", image_data: "AAAA" },
    { query: "dog", image_url: "https://cdn.example.com/a.jpg", image_data: "AAAA" },
  ]) {
    const cap = captureFetch();
    const out = await handleImageSearch(args);
    assert.equal(out.isError, true, `${Object.keys(args).join("+")} must be refused`);
    assert.match(out.content[0].text, /exactly one of/);
    for (const k of Object.keys(args)) {
      assert.match(out.content[0].text, new RegExp("`" + k + "`"),
        `the refusal must name ${k}, which the caller actually sent`);
    }
    assert.equal(cap.body, undefined, "a refused call must not reach the API");
  }

  const neither = await handleImageSearch({ count: 3 });
  assert.equal(neither.isError, true);
  for (const k of ["query", "image_url", "image_data"]) {
    assert.match(neither.content[0].text, new RegExp("`" + k + "`"),
      "with nothing given, the message must name every way to satisfy it");
  }
});

test("image_search's schema stops requiring query", async () => {
  const { imageSearchTool } = await import("../dist/imageSearch.js");
  assert.equal(imageSearchTool.inputSchema.required, undefined,
    "requiring `query` made the documented image-only search unreachable");
  for (const f of ["query", "image_url", "image_data"]) {
    assert.match(imageSearchTool.inputSchema.properties[f].description, /[Ee]xactly one of/,
      `${f} must say it cannot be combined with the others`);
  }
  // The documented ceiling is on the encoded string, not on the picture.
  assert.equal(imageSearchTool.inputSchema.properties.image_data.maxLength, 5 * 1024 * 1024);
  assert.doesNotMatch(imageSearchTool.description, /optionally (an|by a) .?image/i,
    "the description must not suggest a reference image can be added to a text query");
});

test("image_data accepts a data: URI by using its payload", async () => {
  // What every browser and screenshot tool produces. The payload *is* the
  // base64 the API wants, so refusing the container would be pedantry — but it
  // must be unwrapped, or the API sees `data:image/png;base64,…` as the image.
  const { handleImageSearch } = await import("../dist/imageSearch.js");
  const B64 = "iVBORw0KGgoAAAANSUhEUg==";
  for (const given of [B64, `data:image/png;base64,${B64}`, `  ${B64}  `]) {
    const cap = captureFetch();
    await handleImageSearch({ image_data: given });
    assert.deepEqual(cap.body.inputs, [{ type: "image", data: B64 }],
      `the API must receive the payload alone, got it from ${JSON.stringify(given.slice(0, 30))}`);
  }
});

test("an empty image_search result names the input that was actually used", async () => {
  // `No image results for "undefined"` reads like the caller passed a broken
  // argument, when in fact the search ran and found nothing. It appeared the
  // moment `query` stopped being required.
  const { handleImageSearch } = await import("../dist/imageSearch.js");
  const cases = [
    [{ query: "dog" }, /"dog"/],
    [{ image_url: "https://cdn.example.com/a.jpg" }, /https:\/\/cdn\.example\.com\/a\.jpg/],
    [{ image_data: "AAAA" }, /the supplied image/],
  ];
  for (const [args, expected] of cases) {
    captureFetch({ code: 0, data: { results: [] } });
    const out = await handleImageSearch(args);
    assert.match(out.content[0].text, expected);
    assert.doesNotMatch(out.content[0].text, /undefined/,
      `${Object.keys(args)[0]} produced an undefined in the empty-result message`);
  }
});
