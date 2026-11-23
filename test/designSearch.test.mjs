/**
 * `design_search` — request assembly, the refusals made before a call, and
 * rendering (built output).
 *
 * The fixtures mirror what the API returned on 2026-11-23, including the parts
 * the reference does not mention: `data.specs` arrives on every response, a
 * deck's `master` can be an empty object, and `design_facts` has a different
 * shape for a web page, a slide and an app screen.
 *
 * The HTTP layer's fetch is stubbed through its test seam; no network traffic
 * happens.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The module reads OCTEN_API_KEY at import time — set it before importing.
process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { designSearchTool, handleDesignSearch } = await import("../dist/designSearch.js");
const { validateArgs } = await import("../dist/validate.js");
const { _setFetchForTests } = await import("../dist/http.js");

/** Stub the HTTP layer's fetch; returns what the handler sent, and how often. */
function captureFetch(
  responseData = { code: 0, request_id: "req_default", data: { query: "", images: [], results: [], specs: [] } },
  status = 200,
) {
  const captured = { calls: 0 };
  _setFetchForTests(async (url, init) => {
    captured.calls += 1;
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return { status, json: async () => responseData };
  });
  return captured;
}

const text = (r) => r.content[0].text;

const SECTION = {
  type: "web_section",
  title: "Simple, transparent pricing",
  description: "A pricing section with three plan cards side by side.",
  url: "https://cdn.octen.ai/design/web_page/8d2e/s-004.png?se=2026-11-19T13%3A00%3A00Z&sig=abc",
  thumbnail: "https://cdn.octen.ai/design/thumb/4a1c/4a1c9e07.jpg?se=2026-11-19T13%3A00%3A00Z&sig=def",
  source_page: "https://www.example-saas.com/pricing",
  width: 1440,
  height: 860,
  group: {
    group_id: "pg_8d2e5c41a07b93f6e1d4c28a5b90f3e7c6a1d2b4",
    type: "web_page",
    name: "Pricing | Example SaaS",
    position: 4,
    total: 9,
  },
  design_facts: {
    color: { accent: { $type: "color", $value: { colorSpace: "srgb", hex: "#16a34a" } } },
    fontFamily: { heading: { $type: "fontFamily", $value: ["Inter"] } },
  },
  snippet: { format: "html", code: '<section class="pricing"><h2>Simple, transparent pricing</h2></section>' },
};

const SLIDE = {
  type: "slide",
  title: "Market opportunity",
  description: "Three nested circles labeled TAM, SAM and SOM.",
  url: "https://cdn.octen.ai/design/deck/3b7f/p-005.png?sig=ghi",
  thumbnail: "https://cdn.octen.ai/design/thumb/9e5b/9e5b2c18.jpg?sig=jkl",
  source_page: "https://www.example-startup.com/files/seed-deck.pptx",
  width: 1920,
  height: 1080,
  group: {
    group_id: "deck_3b7f0e92c4a1d85f6e2b9c07a3d4f1e8b5c26a9d0f7e3b1c4a8d2e6f9b0c5a7d",
    type: "deck",
    name: "Example Startup Seed Deck",
    position: 5,
    total: 14,
    master: { majorFont: "Calibri Light", palette: { accent1: "#156082" } },
  },
  design_facts: { styleFacts: { fontFamilies: ["Calibri"], foregroundColors: ["#0E2841"] } },
};

const APP_SCREEN = {
  type: "app_screen",
  title: "My Portal - Policy Manager",
  description: "A blue onboarding screen prompting the user to enable Touch ID.",
  url: "https://cdn.octen.ai/design/app_screen/app_mv_177221.jpg?sig=mno",
  thumbnail: "https://cdn.octen.ai/design/thumb/77aa/77aa0c1d.jpg?sig=pqr",
  width: 1080,
  height: 1920,
  design_facts: { layoutFacts: { components: ["ImageView", "TextView"], elementCount: 16 } },
};

const WEB_RESULT = {
  title: "Pricing Page Design: 12 Patterns That Convert",
  url: "https://www.example-design-blog.com/pricing-page-patterns",
  highlight: "Three plans side by side is the most common layout.",
  authors: "Example Design Blog",
};

const envelope = (data) => ({
  code: 0, msg: "success", request_id: "req_design_1",
  data: { specs: [], ...data },
  meta: { usage: { num_search_queries: 1 }, latency: 307 },
});

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

test("design_search: posts to /design-search with the query and nothing it was not given", async () => {
  // No client-side copy of the API's defaults: `images` and `web_search` are
  // both on by default there, and that default is the API's to move.
  const captured = captureFetch();
  await handleDesignSearch({ query: "pricing section for a SaaS landing page" });
  assert.equal(new URL(captured.url).pathname, "/design-search");
  assert.deepEqual(captured.body, { query: "pricing section for a SaaS landing page" });
});

test("design_search: image and web options nest under their own groups, unchanged", async () => {
  const captured = captureFetch();
  await handleDesignSearch({
    query: "dark mode color contrast",
    images: { count: 10, design_facts: false, snippet: { enable: true, max_tokens: 20000 } },
    web_search: {
      count: 10,
      language: ["en"],
      include_domains: ["material.io"],
      time_range: "year",
      highlight: { enable: true, max_tokens: 300 },
      full_content: { enable: true, max_tokens: 2048 },
    },
    timeout: 45,
  });
  assert.deepEqual(captured.body, {
    query: "dark mode color contrast",
    images: { count: 10, design_facts: false, snippet: { enable: true, max_tokens: 20000 } },
    web_search: {
      count: 10,
      language: ["en"],
      include_domains: ["material.io"],
      time_range: "year",
      highlight: { enable: true, max_tokens: 300 },
      full_content: { enable: true, max_tokens: 2048 },
    },
  }, "`timeout` is the local deadline and must not travel; everything else must, as given");
});

test("design_search: a group lookup needs no query, and sends none", async () => {
  const captured = captureFetch();
  const images = { group_id: "deck_3b7f0e92c4a1", count: 30 };
  for (const args of [{ images }, { query: "", images }, { query: "   ", images }]) {
    const r = await handleDesignSearch(args);
    assert.notEqual(r.isError, true, `${JSON.stringify(args)} was refused`);
    assert.deepEqual(captured.body, { images: { group_id: "deck_3b7f0e92c4a1", count: 30 } });
  }
});

test("design_search: the group id that is checked is the group id that is sent", async () => {
  // An id pasted with stray whitespace is trimmed to decide whether a group
  // was asked for and to name it in the result. Sending the untrimmed value
  // would let the API miss the group while the message shows an id that looks
  // right.
  const captured = captureFetch();
  const r = await handleDesignSearch({ images: { group_id: "  pg_3bdf\n", count: 30 } });
  assert.deepEqual(captured.body, { images: { group_id: "pg_3bdf", count: 30 } });
  assert.match(text(r), /^No images in group pg_3bdf\./);
});

test("design_search: a blank group id is no group, and is not sent", async () => {
  const captured = captureFetch();
  await handleDesignSearch({ query: "pricing section", images: { group_id: "   ", count: 2 } });
  assert.deepEqual(captured.body, { query: "pricing section", images: { count: 2 } });
});

test("design_search: the caller's own arguments are not rewritten in place", async () => {
  // The body is assembled from a copy; trimming the id on the object the
  // transport handed over would change what a caller sees after the call.
  captureFetch();
  const args = { images: { group_id: " pg_3bdf ", count: 30 } };
  await handleDesignSearch(args);
  assert.deepEqual(args, { images: { group_id: " pg_3bdf ", count: 30 } });
});

test("design_search: a query sent with a group travels alongside it", async () => {
  // The API then returns the group's images and web results for the query.
  const captured = captureFetch();
  await handleDesignSearch({ query: "dark hero", images: { group_id: "pg_3bdf" } });
  assert.deepEqual(captured.body, { query: "dark hero", images: { group_id: "pg_3bdf" } });
});

// ---------------------------------------------------------------------------
// Refused before the call
// ---------------------------------------------------------------------------

test("design_search: neither a query nor a group is refused before any request", async () => {
  // The API answers each of these with a bare `Invalid params.` after the
  // round trip; a blank group id is no group at all.
  const captured = captureFetch();
  for (const args of [
    {},
    { query: "   " },
    { images: { count: 3 } },
    { images: { group_id: "  " } },
  ]) {
    const r = await handleDesignSearch(args);
    assert.equal(r.isError, true, `${JSON.stringify(args)} was not refused`);
    assert.match(text(r), /`query`/);
    assert.match(text(r), /`images\.group_id`/);
  }
  assert.equal(captured.calls, 0, "a refused call still reached the API");
});

test("design_search: images and web results both switched off is refused before any request", async () => {
  // Verified against the API on 2026-11-23: this is answered with a success
  // that carries no results and still counts as a search. Nothing documented
  // can come back from it, so it is not worth sending.
  const captured = captureFetch();
  const r = await handleDesignSearch({
    query: "pricing page",
    images: { enable: false },
    web_search: { enable: false },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /`images\.enable`/);
  assert.match(text(r), /`web_search\.enable`/);
  assert.equal(captured.calls, 0, "a refused call still reached the API");
});

test("design_search: one group switched off is an ordinary call", async () => {
  const captured = captureFetch();
  for (const args of [
    { query: "dark mode contrast guidelines", images: { enable: false } },
    { query: "iOS onboarding screen", web_search: { enable: false } },
  ]) {
    const r = await handleDesignSearch(args);
    assert.notEqual(r.isError, true, `${JSON.stringify(args)} was refused`);
    assert.deepEqual(captured.body, args);
  }
  assert.equal(captured.calls, 2);
});

test("design_search: a group lookup with images switched off is refused before any request", async () => {
  // A group is a set of images; the API answers this with `Invalid params.`
  const captured = captureFetch();
  const r = await handleDesignSearch({ images: { enable: false, group_id: "pg_3bdf" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /`images\.group_id`/);
  assert.match(text(r), /`images\.enable`/);
  assert.equal(captured.calls, 0, "a refused call still reached the API");
});

// ---------------------------------------------------------------------------
// The schema gate
// ---------------------------------------------------------------------------

test("design_search: the schema gate lets a group lookup through without a query", () => {
  // `query` is optional when `images.group_id` is set, so the schema must not
  // require it or give it a minimum length — the handler decides, because only
  // it can see both fields.
  const schema = designSearchTool.inputSchema;
  assert.equal(validateArgs(schema, { images: { group_id: "pg_3bdf", count: 30 } }), null);
  assert.equal(validateArgs(schema, { query: "", images: { group_id: "pg_3bdf" } }), null);
});

test("design_search: the schema gate refuses `specs`, which the reference does not document", () => {
  // The API accepts a third group and returns `data.specs`; neither appears in
  // the published reference, so there is no contract behind it to offer.
  const err = validateArgs(designSearchTool.inputSchema, { query: "x", specs: { enable: true } });
  assert.match(err ?? "", /Unknown parameter `specs`/);
});

test("design_search: the schema gate enforces the documented ranges inside each group", () => {
  const schema = designSearchTool.inputSchema;
  assert.match(validateArgs(schema, { query: "x", images: { count: 101 } }) ?? "",
    /`images\.count` must be at most 100/);
  assert.match(validateArgs(schema, { query: "x", images: { snippet: { max_tokens: 99 } } }) ?? "",
    /`images\.snippet\.max_tokens` must be at least 100/);
  assert.match(validateArgs(schema, { query: "x", web_search: { count: 0 } }) ?? "",
    /`web_search\.count` must be at least 1/);
  assert.match(validateArgs(schema, { query: "x", web_search: { time_range: "decade" } }) ?? "",
    /Invalid value for `web_search\.time_range`/);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("design_search: a page section renders its image, its group, its design values and its code", async () => {
  captureFetch(envelope({ query: "pricing section", images: [SECTION] }));
  const r = await handleDesignSearch({ query: "pricing section", web_search: { enable: false } });
  assert.notEqual(r.isError, true);
  const out = text(r);

  assert.match(out, /## Image 1\/1: Simple, transparent pricing/);
  assert.match(out, /web_section/);
  assert.ok(out.includes(SECTION.url), "the image URL is what a vision model fetches");
  assert.ok(out.includes(SECTION.thumbnail));
  assert.ok(out.includes("https://www.example-saas.com/pricing"));
  assert.match(out, /1440x860/);
  assert.ok(out.includes("A pricing section with three plan cards side by side."));

  // The group line carries everything a follow-up call needs: which group,
  // where this image sits in it, and how many there are to ask for.
  assert.ok(out.includes("Pricing | Example SaaS"));
  assert.match(out, /4 of 9/);
  assert.ok(out.includes("pg_8d2e5c41a07b93f6e1d4c28a5b90f3e7c6a1d2b4"));

  // Design values vary by image, so they are passed through as data rather
  // than picked apart by field name.
  assert.ok(out.includes('"hex":"#16a34a"'));
  assert.ok(out.includes('"$value":["Inter"]'));

  assert.ok(out.includes('```html\n<section class="pricing"><h2>Simple, transparent pricing</h2></section>\n```'));
  assert.match(out, /num_search_queries: 1/);
  assert.match(out, /request_id: req_design_1/);
});

test("design_search: a slide renders its deck's master", async () => {
  captureFetch(envelope({ query: "seed deck", images: [SLIDE] }));
  const out = text(await handleDesignSearch({ query: "seed deck" }));
  assert.match(out, /## Image 1\/1: Market opportunity/);
  assert.ok(out.includes("Example Startup Seed Deck"));
  assert.match(out, /5 of 14/);
  assert.ok(out.includes('"majorFont":"Calibri Light"'));
  assert.ok(out.includes('"accent1":"#156082"'));
  assert.ok(out.includes('"fontFamilies":["Calibri"]'));
});

test("design_search: an empty deck master prints nothing", async () => {
  // The reference says `master` "may be empty", and it is, often.
  const slide = { ...SLIDE, group: { ...SLIDE.group, master: {} } };
  captureFetch(envelope({ query: "seed deck", images: [slide] }));
  const out = text(await handleDesignSearch({ query: "seed deck" }));
  assert.doesNotMatch(out, /master/i);
  assert.match(out, /5 of 14/, "the rest of the group line must survive");
});

test("design_search: an app screen has no source page or group, and prints no empty labels", async () => {
  captureFetch(envelope({ query: "iOS onboarding screen", images: [APP_SCREEN] }));
  const out = text(await handleDesignSearch({ query: "iOS onboarding screen" }));
  assert.match(out, /## Image 1\/1: My Portal - Policy Manager/);
  assert.match(out, /app_screen/);
  assert.match(out, /1080x1920/);
  assert.ok(out.includes('"components":["ImageView","TextView"]'));
  assert.doesNotMatch(out, /Source page/);
  assert.doesNotMatch(out, /Group/);
  assert.doesNotMatch(out, /Code/);
  assert.doesNotMatch(out, /undefined|\[object Object\]/);
});

test("design_search: an image without design values or code prints neither section", async () => {
  // What comes back with `images.design_facts: false` and the snippet off.
  const { design_facts: _f, snippet: _s, ...bare } = SECTION;
  captureFetch(envelope({ query: "pricing section", images: [bare] }));
  const out = text(await handleDesignSearch({ query: "pricing section" }));
  assert.match(out, /## Image 1\/1: Simple, transparent pricing/);
  assert.doesNotMatch(out, /Design values/);
  assert.doesNotMatch(out, /```/);
});

test("design_search: code containing a fence cannot close its own block early", async () => {
  const code = "<pre>```js\nconsole.log(1)\n```</pre>";
  captureFetch(envelope({ query: "docs page", images: [{ ...SECTION, snippet: { format: "html", code } }] }));
  const out = text(await handleDesignSearch({ query: "docs page" }));
  assert.ok(out.includes("````html\n" + code + "\n````"),
    "the block must be fenced with more backticks than the code contains");
});

test("design_search: images come first and the web results follow", async () => {
  captureFetch(envelope({ query: "pricing section", images: [SECTION, SLIDE], results: [WEB_RESULT] }));
  const out = text(await handleDesignSearch({ query: "pricing section" }));
  assert.match(out, /## Image 1\/2: Simple, transparent pricing/);
  assert.match(out, /## Image 2\/2: Market opportunity/);
  assert.match(out, /## Result 1\/1: Pricing Page Design: 12 Patterns That Convert/);
  assert.ok(out.includes("https://www.example-design-blog.com/pricing-page-patterns"));
  assert.match(out, /### Highlight\nThree plans side by side is the most common layout\./);
  assert.ok(out.indexOf("## Image 2/2") < out.indexOf("## Result 1/1"),
    "the designs are the answer; the articles about them come after");
});

test("design_search: web results alone render without an image section", async () => {
  // What comes back with `images.enable: false`: no `images` key at all.
  captureFetch(envelope({ query: "dark mode contrast", results: [WEB_RESULT] }));
  const out = text(await handleDesignSearch({ query: "dark mode contrast", images: { enable: false } }));
  assert.match(out, /## Result 1\/1: Pricing Page Design/);
  assert.doesNotMatch(out, /## Image/);
});

test("design_search: an empty search says so, and the undocumented `specs` is not mistaken for content", async () => {
  captureFetch(envelope({ query: "zzzz", images: [], results: [] }));
  const r = await handleDesignSearch({ query: "zzzz" });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /^No design references for "zzzz"\./);
  assert.doesNotMatch(text(r), /## (Image|Result)/);
});

test("design_search: an empty result still carries the API's warning and request id", async () => {
  // "Nothing found" and "nothing found, and here is why" are different
  // answers, for a search and for a group lookup alike.
  const empty = {
    code: 0, request_id: "req_empty_2",
    data: { query: "", images: [], results: [], specs: [] },
    meta: { usage: { num_search_queries: 1 }, warning: "index partially unavailable" },
  };
  for (const [args, said] of [
    [{ query: "zzzz" }, /^No design references for "zzzz"\./],
    [{ images: { group_id: "pg_x" } }, /^No images in group pg_x\./],
  ]) {
    captureFetch(empty);
    const out = text(await handleDesignSearch(args));
    assert.match(out, said);
    assert.match(out, /warning: index partially unavailable/);
    assert.match(out, /request_id: req_empty_2/);
  }
});

test("design_search: an unknown group says which group came back empty", async () => {
  // Verified against the API: a group id it does not know is a success with
  // empty arrays, not an error — so the caller needs to be told it was the id.
  captureFetch(envelope({ query: "", images: [], results: [] }));
  const r = await handleDesignSearch({ images: { group_id: "pg_doesnotexist" } });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /^No images in group pg_doesnotexist\./);
  assert.doesNotMatch(text(r), /No design references/);
});

test("design_search: an unknown group is named even when the query's web results fill the response", async () => {
  // A query sent with a group still returns web results, so an empty group
  // would otherwise be invisible: the caller asked for a deck, got articles,
  // and nothing says the id matched no images.
  captureFetch(envelope({ query: "dark hero", images: [], results: [WEB_RESULT] }));
  const out = text(await handleDesignSearch({ query: "dark hero", images: { group_id: "pg_doesnotexist" } }));
  assert.match(out, /No images in group pg_doesnotexist\./);
  assert.match(out, /## Result 1\/1: Pricing Page Design/);
  assert.ok(out.indexOf("No images in group") < out.indexOf("## Result 1/1"),
    "say what is missing before what did come back");
});

test("design_search: a malformed entry does not cost the caller the valid results", async () => {
  captureFetch(envelope({
    query: "pricing section",
    images: [null, SECTION, 42, "junk"],
    results: [null, WEB_RESULT, 7],
  }));
  const r = await handleDesignSearch({ query: "pricing section" });
  assert.notEqual(r.isError, true);
  const out = text(r);
  assert.match(out, /## Image 1\/1: Simple, transparent pricing/);
  assert.match(out, /## Result 1\/1: Pricing Page Design/);
});

test("design_search: an entry that cannot be rendered is named, and the rest still come back", async () => {
  // An object where a string belongs can throw when it is converted; without
  // a guard per entry, one such image or result discards every valid one.
  const unprintable = { toString: 1 };
  captureFetch(envelope({
    query: "pricing section",
    images: [{ ...SECTION, title: unprintable }, SLIDE],
    results: [{ ...WEB_RESULT, title: unprintable }, WEB_RESULT],
  }));
  const r = await handleDesignSearch({ query: "pricing section" });
  assert.notEqual(r.isError, true);
  const out = text(r);
  assert.match(out, /## Image 2\/2: Market opportunity/);
  assert.match(out, /## Result 2\/2: Pricing Page Design/);
  assert.match(out, /## Image 1\/2: .*could not be rendered/);
  assert.match(out, /## Result 1\/2: .*could not be rendered/);
});

test("design_search: any non-2xx answer without an Octen code is an error", async () => {
  for (const status of [302, 404, 503]) {
    captureFetch({}, status);
    const r = await handleDesignSearch({ query: "pricing section" });
    assert.equal(r.isError, true, `HTTP ${status} was reported as an empty result`);
    assert.match(text(r), new RegExp(`HTTP ${status}`));
  }
});

test("design_search: a 200 that is not an Octen response is an error, not an empty search", async () => {
  // A base URL pointed at the wrong service can answer 200 with JSON of its
  // own; it holds no designs because it is not a design search at all.
  // `request_id` is what marks a response as Octen's; `data` alone does not.
  for (const body of [
    {}, { status: "ok" }, [], null,
    { data: [] }, { data: { status: "unavailable" } }, { code: 0, data: { images: [], results: [] } },
  ]) {
    captureFetch(body, 200);
    for (const args of [{ query: "pricing section" }, { images: { group_id: "pg_3bdf" } }]) {
      const r = await handleDesignSearch(args);
      assert.equal(r.isError, true, `${JSON.stringify(body)} was reported as an empty result`);
      assert.match(text(r), /not an Octen response/);
      assert.doesNotMatch(text(r), /No design references|No images in group/);
    }
  }
});

test("design_search: a gateway's own numeric `code` is not mistaken for an Octen error", async () => {
  // `{"code": 502, "message": "Bad Gateway"}` read as an Octen envelope is
  // `code=502 msg=(no msg)` — the gateway's own sentence is lost.
  captureFetch({ code: 502, message: "Bad Gateway" }, 502);
  const r = await handleDesignSearch({ query: "pricing section" });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 502/);
  assert.match(text(r), /Bad Gateway/);
  assert.doesNotMatch(text(r), /\(no msg\)/);
});

test("design_search: an empty web-only search says it was the web results that came back empty", async () => {
  // With images switched off no design was searched for, so "No design
  // references" would name a search that never ran.
  captureFetch(envelope({ query: "dark mode contrast", results: [] }));
  const r = await handleDesignSearch({ query: "dark mode contrast", images: { enable: false } });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /^No web results for "dark mode contrast"\./);
  assert.doesNotMatch(text(r), /design references/);
});

test("design_search: an empty search with images on still says no design references", async () => {
  // Images only, and images plus web results: either way designs were asked for.
  for (const args of [
    { query: "zzzz", web_search: { enable: false } },
    { query: "zzzz" },
  ]) {
    captureFetch(envelope({ query: "zzzz", images: [], results: [] }));
    assert.match(text(await handleDesignSearch(args)), /^No design references for "zzzz"\./);
  }
});

test("design_search: a failing response keeps the request id it came with", async () => {
  captureFetch({ request_id: "req_gw_2", message: "upstream unavailable" }, 503);
  const r = await handleDesignSearch({ query: "pricing section" });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 503/);
  assert.match(text(r), /upstream unavailable/);
  assert.match(text(r), /request_id=req_gw_2/);
  assert.doesNotMatch(text(r), /no `request_id`/);
});

test("design_search: a gateway's JSON error is an error, not an empty search", async () => {
  // A 502 whose body is JSON but not Octen's envelope carries no `code`;
  // without a look at the HTTP status it reads as a search that found nothing.
  captureFetch({ message: "Bad Gateway" }, 502);
  for (const args of [{ query: "pricing section" }, { images: { group_id: "pg_3bdf" } }]) {
    const r = await handleDesignSearch(args);
    assert.equal(r.isError, true, "an outage was reported as an empty result");
    assert.match(text(r), /HTTP 502/);
    assert.match(text(r), /Bad Gateway/);
    assert.doesNotMatch(text(r), /No design references|No images in group/);
  }
});

test("design_search: an API error is passed on with its own code and message", async () => {
  captureFetch({ code: 400, msg: "Invalid params. Param images.count must be at most 100", request_id: "req_400" });
  const r = await handleDesignSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /code=400 msg=Invalid params\. Param images\.count must be at most 100 request_id=req_400/);
});
