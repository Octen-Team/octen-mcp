/**
 * The declared limits must match the published API reference.
 *
 * This matters more since the schemas became a gate rather than advertising:
 * a limit stricter than the API's now *rejects calls the API would serve*, and
 * one looser lets a request through to fail upstream with a worse message.
 * Both were live — `exclude_domains` was declared at 150 against a documented
 * 1200, and every domain longer than 30 characters was refused against a
 * documented 60. Nothing failed, because nothing compared the two.
 *
 * The table below is transcribed from docs.octen.ai/api-reference/*. When the
 * API changes, this test is the thing that should fail — update the table, not
 * the schema, and the mismatch will point at what else needs to move.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { searchTool, broadSearchTool } = await import("../dist/search.js");
const { newsSearchTool } = await import("../dist/newsSearch.js");
const { businessSearchTool } = await import("../dist/businessSearch.js");
const { placeSearchTool } = await import("../dist/placeSearch.js");
const { pulseSearchTool } = await import("../dist/pulseSearch.js");
const { extractTool } = await import("../dist/extract.js");
const { imageSearchTool } = await import("../dist/imageSearch.js");
const { videoSearchTool } = await import("../dist/videoSearch.js");

/** docs.octen.ai/api-reference — verified 2026-08-31. */
const DOCUMENTED = {
  search: {
    tool: searchTool,
    fields: {
      "query": { maxLength: 500 },
      "count": { minimum: 1, maximum: 100 },
      "include_domains": { maxItems: 1200, itemMaxLength: 60 },
      "exclude_domains": { maxItems: 1200, itemMaxLength: 60 },
      "include_text": { maxItems: 5, itemMaxLength: 30 },
      "exclude_text": { maxItems: 5, itemMaxLength: 30 },
      "highlight.max_tokens": { minimum: 100, maximum: 20000 },
      "full_content.max_tokens": { minimum: 100, maximum: 100000 },
    },
  },
  // Its own endpoint since 2026-10-26, so its own table: it shares most of
  // search's parameters but not all, and adds `subjects`. This entry used to
  // carry two fields on the grounds that the schema was derived from search's
  // — which is how it went on advertising `topic` after /search stopped
  // documenting the parameter.
  news_search: {
    tool: newsSearchTool,
    fields: {
      "query": { maxLength: 500 },
      "count": { minimum: 1, maximum: 100 },
      "include_domains": { maxItems: 1200, itemMaxLength: 60 },
      "exclude_domains": { maxItems: 1200, itemMaxLength: 60 },
      "highlight.max_tokens": { minimum: 100, maximum: 20000 },
      "full_content.max_tokens": { minimum: 100, maximum: 100000 },
      "subjects.count": { minimum: 1, maximum: 5 },
      "subjects.max_sub_news": { minimum: 1, maximum: 20 },
    },
  },
  business_search: {
    tool: businessSearchTool,
    fields: {
      "query": { maxLength: 500 },
      "count": { minimum: 1, maximum: 100 },
      "include_domains": { maxItems: 1200, itemMaxLength: 60 },
      "exclude_domains": { maxItems: 1200, itemMaxLength: 60 },
      "highlight.max_tokens": { minimum: 100, maximum: 20000 },
      "full_content.max_tokens": { minimum: 100, maximum: 100000 },
      "entities.count": { minimum: 1, maximum: 20 },
      "entities.max_activities": { minimum: 1, maximum: 20 },
      "entities.max_news": { minimum: 1, maximum: 20 },
    },
  },
  // Not a search variant: the web filters nest under `web_search` instead of
  // sitting beside `query`, and the location parameters have no counterpart
  // anywhere else — which is why none of this is shared out of search's schema.
  place_search: {
    tool: placeSearchTool,
    fields: {
      "query": { maxLength: 500 },
      "latitude": { minimum: -90, maximum: 90 },
      "longitude": { minimum: -180, maximum: 180 },
      "radius": { minimum: 1, maximum: 50000 },
      "places.count": { minimum: 1, maximum: 20 },
      "places.max_reviews": { minimum: 0, maximum: 5 },
      "web_search.count": { minimum: 1, maximum: 100 },
      "web_search.include_domains": { maxItems: 1200, itemMaxLength: 60 },
      "web_search.exclude_domains": { maxItems: 1200, itemMaxLength: 60 },
      "web_search.highlight.max_tokens": { minimum: 100, maximum: 20000 },
      "web_search.full_content.max_tokens": { minimum: 100, maximum: 100000 },
    },
  },
  // Flat like the search family, but sharing almost none of it: a destination
  // predictor takes no domain, text, time or language filter, and `count` tops
  // out an order of magnitude lower.
  pulse_search: {
    tool: pulseSearchTool,
    fields: {
      "query": { maxLength: 500 },
      "count": { minimum: 1, maximum: 10 },
      "highlight.max_tokens": { minimum: 100, maximum: 20000 },
      "full_content.max_tokens": { minimum: 100, maximum: 100000 },
    },
  },
  broad_search: {
    tool: broadSearchTool,
    fields: {
      "query": { maxLength: 500 },
      "max_queries": { minimum: 1, maximum: 30 },
      "count": { minimum: 1, maximum: 100 },
      "include_domains": { maxItems: 1200, itemMaxLength: 60 },
      "exclude_domains": { maxItems: 1200, itemMaxLength: 60 },
    },
  },
  extract: {
    tool: extractTool,
    fields: {
      "urls": { maxItems: 20, itemMaxLength: 2048 },
      "query": { maxLength: 500 },
      "timeout": { minimum: 1, maximum: 60 },
      "max_age_seconds": { minimum: 300, maximum: 31536000 },
      // Verified 2026-09-28: out of range is a 400, not clamped.
      "include_links.max_links": { minimum: 1, maximum: 1000 },
    },
  },
  image_search: {
    tool: imageSearchTool,
    fields: {
      "count": { minimum: 1, maximum: 10 },
      },
  },
  video_search: {
    tool: videoSearchTool,
    fields: { "count": { minimum: 1, maximum: 10 } },
  },
};

const at = (schema, path) =>
  path.split(".").reduce((s, k) => s?.properties?.[k], schema);

for (const [name, { tool, fields }] of Object.entries(DOCUMENTED)) {
  test(`${name}'s declared limits match the published API reference`, () => {
    for (const [field, want] of Object.entries(fields)) {
      const s = at(tool.inputSchema, field);
      assert.ok(s, `${name} does not declare \`${field}\`, which the API documents`);
      const got = {
        minimum: s.minimum, maximum: s.maximum, maxLength: s.maxLength,
        maxItems: s.maxItems, itemMaxLength: s.items?.maxLength,
      };
      for (const [k, v] of Object.entries(want)) {
        assert.equal(got[k], v,
          `${name}.${field}.${k} is ${got[k]}, the API documents ${v} — ` +
          `too strict rejects valid calls, too loose defers the error upstream`);
      }
    }
  });
}

/**
 * A semantic rule of ours, not a published limit — which is why it is asserted
 * here rather than added to DOCUMENTED above. The reference documents
 * `query` max 500; it does not say "at least 1". An empty query is still
 * nonsense, and letting it through means the caller learns that from an
 * upstream 400 (or, worse, from a handler error after dispatch) instead of
 * from the schema they read. Only a rule the reference states may go in
 * DOCUMENTED, or that table stops meaning anything.
 */
test("a search query must be declared non-empty", () => {
  for (const tool of [searchTool, newsSearchTool, broadSearchTool]) {
    const query = tool.inputSchema.properties.query;
    assert.ok(query, `${tool.name} must declare query`);
    assert.equal(query.minLength, 1,
      `${tool.name}.query must declare minLength 1 so an empty query is refused ` +
      `before dispatch, not by the handler or the API`);
  }
});

test("extract's optional query is not given an unpublished minimum", () => {
  // extract's `query` is optional and drives highlight extraction. Nothing
  // documents a minimum for it, so we must not invent one.
  assert.equal(extractTool.inputSchema.properties.query.minLength, undefined);
});

test("enum values match the published API reference", () => {
  const enums = [
    [searchTool, "time_basis", ["auto", "published", "crawled"]],
    [searchTool, "time_range", ["day", "week", "month", "year", "d", "w", "m", "y"]],
    [searchTool, "format", ["text", "markdown"]],
    [searchTool, "safesearch", ["off", "strict"]],
    [extractTool, "format", ["markdown", "text"]],
    [extractTool, "mode", ["standard", "advanced", "auto"]],
    [extractTool, "include_links.scope", ["prefer_internal", "prefer_external"]],
    [imageSearchTool, "safesearch", ["off", "strict"]],
    [videoSearchTool, "safesearch", ["off", "strict"]],
    // Shared out of search's schema rather than restated, so these assert the
    // sharing held — not that someone typed the same list three times.
    [newsSearchTool, "time_basis", ["auto", "published", "crawled"]],
    [newsSearchTool, "time_range", ["day", "week", "month", "year", "d", "w", "m", "y"]],
    [businessSearchTool, "time_basis", ["auto", "published", "crawled"]],
    [businessSearchTool, "time_range", ["day", "week", "month", "year", "d", "w", "m", "y"]],
    // Nested, not shared: place_search declares these inside `web_search`.
    [placeSearchTool, "web_search.time_basis", ["auto", "published", "crawled"]],
    [placeSearchTool, "web_search.time_range", ["day", "week", "month", "year", "d", "w", "m", "y"]],
    [placeSearchTool, "user_location.type", ["approximate"]],
    [pulseSearchTool, "mode", ["lite", "standard"]],
    [pulseSearchTool, "safesearch", ["off", "strict"]],
  ];
  for (const [tool, field, want] of enums) {
    const s = at(tool.inputSchema, field);
    assert.ok(s, `${tool.name} does not declare \`${field}\``);
    assert.deepEqual([...s.enum].sort(), [...want].sort(),
      `${tool.name}.${field} enum drifted from the API reference`);
  }
});

/**
 * `timeout` means two different things depending on the tool, and conflating
 * them is how a published field could have been dropped without notice.
 *
 * On search / news_search / broad_search / image_search / video_search it is
 * ours: the client-side HTTP deadline, stripped from the request body before
 * sending. Those references do not document a `timeout`, which is why the name
 * needs an allowance here at all.
 *
 * On `extract` it is the API's own per-URL fetch budget (1-60s) and travels in
 * the body — the reference documents it, `DOCUMENTED_PARAMS.extract` lists it,
 * and the allowance below must not be read as permission to strip it.
 * test/http.test.mjs asserts both bodies exactly.
 */
const CLIENT_ONLY = new Set(["timeout"]);

/** Parameter names each endpoint's reference documents, after our flattening. */
const DOCUMENTED_PARAMS = {
  // `inputs[]` is flattened into `query` / `image_url`; `search_options` is
  // flattened to the top level. Those are presentation choices — the request
  // bodies we build are asserted against the documented shapes elsewhere.
  // `inputs[]` flattens to three: `query` is `inputs.data` for a text input,
  // `image_url` is `inputs.url`, `image_data` is `inputs.data` for an image.
  image_search: ["query", "image_url", "image_data", "topic", "count",
                 "include_domains", "exclude_domains", "safesearch", "html_snippet"],
  video_search: ["query", "count", "time_range", "start_time", "end_time", "safesearch"],
  extract: ["urls", "query", "max_age_seconds", "format", "timeout",
            "include_images", "include_videos", "include_audio", "mode", "include_links"],
};

/**
 * Documented parameters a tool deliberately does not offer, each with a reason.
 *
 * Not the same as a gap: the table above stays a transcript of the published
 * reference, and this records where we knowingly offer less. Both entries are
 * the design corpus, withdrawn from the public surface pending an endpoint of
 * its own — `topic: design` is the only way to reach it, and `html_snippet`
 * only carries anything there.
 */
const WITHDRAWN = {
  image_search: {
    topic: "general is the only value left; design is withdrawn pending its own endpoint",
    html_snippet: "only populated for topic=design, which is withdrawn",
  },
};

test("no tool advertises a parameter the API reference does not document", () => {
  const byName = { image_search: imageSearchTool, video_search: videoSearchTool, extract: extractTool };
  for (const [name, documented] of Object.entries(DOCUMENTED_PARAMS)) {
    const declared = Object.keys(byName[name].inputSchema.properties);
    const extra = declared.filter((p) => !documented.includes(p) && !CLIENT_ONLY.has(p));
    assert.deepEqual(extra, [],
      `${name} advertises ${extra.join(", ")}, which its API reference does not document`);
  }
  // And the other direction: a documented parameter we do not offer is a
  // capability the caller simply cannot reach — unless it was withdrawn on
  // purpose, which WITHDRAWN records.
  for (const [name, documented] of Object.entries(DOCUMENTED_PARAMS)) {
    const declared = Object.keys(byName[name].inputSchema.properties);
    const withdrawn = WITHDRAWN[name] ?? {};
    const missing = documented.filter((p) => !declared.includes(p) && !(p in withdrawn));
    assert.deepEqual(missing, [], `${name} does not offer documented ${missing.join(", ")}`);
  }
});

test("a withdrawal is dropped once the tool offers the parameter again", () => {
  // Otherwise the list only grows, and a parameter that came back stays
  // outside the check that should now cover it.
  const byName = { image_search: imageSearchTool, video_search: videoSearchTool, extract: extractTool };
  for (const [name, params] of Object.entries(WITHDRAWN)) {
    const declared = Object.keys(byName[name].inputSchema.properties);
    for (const p of Object.keys(params)) {
      assert.equal(declared.includes(p), false, `${name} offers ${p} now — drop it from WITHDRAWN`);
    }
  }
});

test("time filtering is offered where documented and nowhere else", () => {
  // video-search documents time_range / start_time / end_time; image-search
  // does not. They were declared on both, and image_search really did send
  // them — the API accepted them, but a parameter we advertise and the API
  // does not document is one nobody has committed to keeping.
  for (const f of ["time_range", "start_time", "end_time"]) {
    assert.ok(f in videoSearchTool.inputSchema.properties, `video_search must keep ${f}`);
    assert.ok(!(f in imageSearchTool.inputSchema.properties),
      `image_search must not advertise ${f}: its API reference does not document it`);
  }
});

test("legacy: no tool advertises include_videos outside extract", () => {
  // `include_videos` was declared on search and does not appear in that
  // endpoint's parameter table. It did have an effect when sent — but a
  // parameter we advertise and the API does not document is one we cannot
  // promise, and the schemas are a gate now, not a suggestion.
  assert.ok(!("include_videos" in searchTool.inputSchema.properties),
    "search must not advertise include_videos: the API reference does not document it");
  assert.ok(!("include_videos" in broadSearchTool.inputSchema.properties),
    "broad_search derives its options from search — it inherits the same rule");
  assert.ok(!("include_videos" in newsSearchTool.inputSchema.properties));

  // extract's three media flags *are* documented, and must stay.
  for (const f of ["include_images", "include_videos", "include_audio"]) {
    assert.ok(f in extractTool.inputSchema.properties,
      `extract documents ${f} — removing it would be the opposite error`);
  }
});
