/**
 * Unit tests for request-body assembly in the search tools (built output).
 *
 * Run with `npm test` (builds first, then `node --test test/`). Global `fetch`
 * is stubbed so no network traffic happens; we assert on the outgoing payload.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The module reads OCTEN_API_KEY at import time — set it before importing.
process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { searchTool, newsSearchTool, broadSearchTool, handleSearch, handleNewsSearch, handleBroadSearch } =
  await import("../dist/search.js");

/** Stub global fetch for one call; returns the captured {url, body}. */
function captureFetch(responseData = { code: 0, data: { results: [] } }) {
  const captured = {};
  globalThis.fetch = async (url, init) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return {
      status: 200,
      json: async () => responseData,
    };
  };
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
