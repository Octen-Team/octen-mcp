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

test("search: schema advertises `country` (string, default auto)", () => {
  const prop = searchTool.inputSchema.properties.country;
  assert.ok(prop, "country missing from search inputSchema");
  assert.equal(prop.type, "string");
  assert.equal(prop.default, "auto");
});

test("news_search: schema inherits `country`, drops `topic`", () => {
  assert.ok(newsSearchTool.inputSchema.properties.country);
  assert.equal(newsSearchTool.inputSchema.properties.topic, undefined);
});

test("broad_search: schema inherits `country`", () => {
  assert.ok(broadSearchTool.inputSchema.properties.country);
});

test("search: `country` is sent top-level in the /search body", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "best local pizza", country: "US", count: 2 });
  assert.ok(captured.url.endsWith("/search"));
  assert.equal(captured.body.country, "US");
  assert.equal(captured.body.count, 2);
});

test("search: `country` is omitted from the body when unset", async () => {
  const captured = captureFetch();
  await handleSearch({ query: "best local pizza" });
  assert.equal("country" in captured.body, false);
});

test("news_search: `country` passes through top-level, topic forced to news", async () => {
  const captured = captureFetch();
  await handleNewsSearch({ query: "chip news", country: "JP" });
  assert.equal(captured.body.country, "JP");
  assert.equal(captured.body.topic, "news");
});

test("broad_search: `country` is nested under search_options, not top-level", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ev charging networks", country: "US", count: 2 });
  assert.ok(captured.url.endsWith("/broad-search"));
  assert.equal("country" in captured.body, false, "country must not be top-level on /broad-search");
  assert.equal(captured.body.search_options.country, "US");
  assert.equal(captured.body.search_options.count, 2);
});

test("broad_search: `country` (and search_options) omitted when unset", async () => {
  const captured = captureFetch({ code: 0, data: { search_results: [], queries: [] } });
  await handleBroadSearch({ query: "ev charging networks" });
  assert.equal("country" in captured.body, false);
  assert.equal("search_options" in captured.body, false);
});
