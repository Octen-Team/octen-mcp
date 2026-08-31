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

const { searchTool, newsSearchTool, broadSearchTool } = await import("../dist/search.js");
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
  // Same engine, so the same options table applies — and it is derived from
  // searchTool's, which is exactly why a drift there would go unnoticed here.
  news_search: {
    tool: newsSearchTool,
    fields: {
      "count": { minimum: 1, maximum: 100 },
      "include_domains": { maxItems: 1200, itemMaxLength: 60 },
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
    },
  },
  image_search: {
    tool: imageSearchTool,
    fields: {
      "count": { minimum: 1, maximum: 10 },
      "html_snippet.max_tokens": { minimum: 100, maximum: 100000 },
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

test("enum values match the published API reference", () => {
  const enums = [
    [searchTool, "topic", ["general", "news"]],
    [searchTool, "time_basis", ["auto", "published", "crawled"]],
    [searchTool, "time_range", ["day", "week", "month", "year", "d", "w", "m", "y"]],
    [searchTool, "format", ["text", "markdown"]],
    [searchTool, "safesearch", ["off", "strict"]],
    [extractTool, "format", ["markdown", "text"]],
    [imageSearchTool, "safesearch", ["off", "strict"]],
    [videoSearchTool, "safesearch", ["off", "strict"]],
  ];
  for (const [tool, field, want] of enums) {
    const s = at(tool.inputSchema, field);
    assert.ok(s, `${tool.name} does not declare \`${field}\``);
    assert.deepEqual([...s.enum].sort(), [...want].sort(),
      `${tool.name}.${field} enum drifted from the API reference`);
  }
});

/**
 * `timeout` is ours, not the API's: it is the client-side HTTP deadline and is
 * stripped from every request body before sending. It is the only name allowed
 * to appear in a schema without appearing in the API reference.
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
            "include_images", "include_videos", "include_audio"],
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
  // capability the caller simply cannot reach.
  for (const [name, documented] of Object.entries(DOCUMENTED_PARAMS)) {
    const declared = Object.keys(byName[name].inputSchema.properties);
    const missing = documented.filter((p) => !declared.includes(p));
    assert.deepEqual(missing, [], `${name} does not offer documented ${missing.join(", ")}`);
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
