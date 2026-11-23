/**
 * `premier_search` — request assembly and rendering (built output).
 *
 * The endpoint takes the same body as `/search` and answers in the same shape,
 * so what can go wrong here is narrow and specific: the call lands on the
 * wrong path (and is billed at the wrong rate), a client-only field leaks into
 * the body, or the schema drifts from the parameter list its own reference
 * documents. Each test below is one of those.
 *
 * The HTTP layer's fetch is stubbed through its test seam; no network traffic
 * happens.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The module reads OCTEN_API_KEY at import time — set it before importing.
process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { premierSearchTool, handlePremierSearch } = await import("../dist/premierSearch.js");
const { searchTool } = await import("../dist/search.js");
const { validateArgs } = await import("../dist/validate.js");
const { _setFetchForTests } = await import("../dist/http.js");

/** Stub the HTTP layer's fetch; returns what the handler sent, and how often. */
function captureFetch(responseData = { code: 0, request_id: "req_default", data: { results: [] } }, status = 200) {
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

test("premier_search: posts to /search-premier, never /search", async () => {
  // The two endpoints take the same body, so nothing but the path separates a
  // premier call from an ordinary one — and they are billed at different rates.
  const captured = captureFetch();
  await handlePremierSearch({ query: "kafka default retention", count: 5 });
  assert.equal(new URL(captured.url).pathname, "/search-premier");
  assert.deepEqual(captured.body, { query: "kafka default retention", count: 5 });
});

test("premier_search: every documented option travels top-level, unchanged", async () => {
  const captured = captureFetch();
  await handlePremierSearch({
    query: "summary judgment",
    result_type: "dynamic",
    count: 10,
    include_domains: ["uscourts.gov"],
    exclude_domains: ["example.com"],
    include_text: ["motion"],
    exclude_text: ["draft"],
    time_basis: "published",
    time_range: "year",
    start_time: "2024-01-01T00:00:00+08:00",
    end_time: "2025-01-01T00:00:00+08:00",
    language: ["en"],
    highlight: { enable: true, max_tokens: 300 },
    full_content: { enable: false },
    format: "markdown",
    safesearch: "off",
    include_images: true,
  });
  assert.deepEqual(captured.body, {
    query: "summary judgment",
    result_type: "dynamic",
    count: 10,
    include_domains: ["uscourts.gov"],
    exclude_domains: ["example.com"],
    include_text: ["motion"],
    exclude_text: ["draft"],
    time_basis: "published",
    time_range: "year",
    start_time: "2024-01-01T00:00:00+08:00",
    end_time: "2025-01-01T00:00:00+08:00",
    language: ["en"],
    highlight: { enable: true, max_tokens: 300 },
    full_content: { enable: false },
    format: "markdown",
    safesearch: "off",
    include_images: true,
  });
});

test("premier_search: options left unset are omitted, so the API's defaults apply", async () => {
  const captured = captureFetch();
  await handlePremierSearch({ query: "x" });
  assert.deepEqual(captured.body, { query: "x" });
});

test("premier_search: `timeout` is the local deadline and never reaches the API", async () => {
  const captured = captureFetch();
  await handlePremierSearch({ query: "x", timeout: 45 });
  assert.deepEqual(captured.body, { query: "x" });
});

test("premier_search: a blank query is refused before any request is made", async () => {
  // The API answers this with a 400 — after the round trip.
  const captured = captureFetch();
  for (const query of ["", "   ", undefined]) {
    const r = await handlePremierSearch({ query });
    assert.equal(r.isError, true, `query=${JSON.stringify(query)} was not refused`);
    assert.match(text(r), /`query` must be a non-empty string/);
  }
  assert.equal(captured.calls, 0, "a refused call still reached the API");
});

test("premier_search: results render with their title, URL and highlight", async () => {
  captureFetch({
    code: 0,
    msg: "success",
    request_id: "req_abc",
    data: {
      query: "who guidance influenza",
      results: [{
        title: "Influenza (Seasonal)",
        url: "https://www.who.int/news-room/fact-sheets/detail/influenza-(seasonal)",
        highlight: "WHO recommends annual vaccination for high-risk groups",
        authors: "World Health Organization",
        time_published: "2024-10-15T00:00:00Z",
        full_content: "",
      }],
    },
    meta: {
      usage: { num_search_queries: 1, full_content_extra_count: 0 },
      result_type: "standard", latency: 451, warning: "",
    },
  });
  const r = await handlePremierSearch({ query: "who guidance influenza" });
  assert.notEqual(r.isError, true);
  const out = text(r);
  assert.match(out, /## Result 1\/1: Influenza \(Seasonal\)/);
  assert.ok(out.includes("https://www.who.int/news-room/fact-sheets/detail/influenza-(seasonal)"));
  assert.match(out, /### Highlight\nWHO recommends annual vaccination/);
  assert.match(out, /num_search_queries: 1/);
  assert.match(out, /request_id: req_abc/);
  // An empty `full_content` comes back on every result whether or not it was
  // asked for; it must not print an empty section.
  assert.doesNotMatch(out, /### Content/);
});

test("premier_search: an empty result says so, naming the query", async () => {
  captureFetch({ code: 0, request_id: "req_zzz", data: { query: "zzz", results: [] }, meta: {} });
  const r = await handlePremierSearch({ query: "zzz" });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /^No results for "zzz"\./);
  assert.doesNotMatch(text(r), /## Result/);
});

test("premier_search: an empty result still carries the API's warning and request id", async () => {
  // "Nothing found" and "nothing found, and here is why" are different
  // answers. Returning before the meta line drops the API's own caveat and the
  // one id a support request needs.
  captureFetch({
    code: 0, request_id: "req_empty_1",
    data: { query: "zzz", results: [] },
    meta: { usage: { num_search_queries: 1 }, warning: "time range adjusted" },
  });
  const r = await handlePremierSearch({ query: "zzz" });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /^No results for "zzz"\./);
  assert.match(text(r), /warning: time range adjusted/);
  assert.match(text(r), /request_id: req_empty_1/);
});

test("premier_search: an API error is passed on with its own code and message", async () => {
  captureFetch({ code: 403, msg: "Insufficient balance in account", request_id: "req_403" });
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /code=403 msg=Insufficient balance in account request_id=req_403/);
});

test("premier_search: a gateway's JSON error is an error, not an empty search", async () => {
  // Something in front of the API can answer for it: a 502 whose body is JSON
  // but not Octen's envelope carries no `code`, and without a look at the HTTP
  // status it reads as a search that completed and found nothing.
  captureFetch({ message: "Bad Gateway" }, 502);
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true, "an outage was reported as an empty result");
  assert.match(text(r), /HTTP 502/);
  assert.match(text(r), /Bad Gateway/);
  assert.doesNotMatch(text(r), /No results/);
});

test("premier_search: a gateway's own numeric `code` is not mistaken for an Octen error", async () => {
  // Plenty of gateways answer with `{"code": 502, "message": "Bad Gateway"}`.
  // Read as an Octen envelope that is `code=502 msg=(no msg)`: the status is
  // there by coincidence and the one sentence that says what happened is
  // gone. A numeric code counts as Octen's only on a response that is Octen's.
  captureFetch({ code: 502, message: "Bad Gateway" }, 502);
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 502/);
  assert.match(text(r), /Bad Gateway/);
  assert.doesNotMatch(text(r), /\(no msg\)/);
});

test("premier_search: a failing response keeps the request id it came with", async () => {
  // A non-2xx answer can carry a `request_id` and still have no error code to
  // pass on. The id is the one thing that lets someone trace the failure, so
  // it must survive — and the message must not claim the response had none.
  captureFetch({ request_id: "req_gw_1", message: "upstream unavailable" }, 502);
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 502/);
  assert.match(text(r), /upstream unavailable/);
  assert.match(text(r), /request_id=req_gw_1/);
  assert.doesNotMatch(text(r), /no `request_id`/);
});

test("premier_search: Octen's own error envelope still wins over the bare HTTP status", async () => {
  // The envelope's code and message are the API's words; the status alone
  // would say less.
  captureFetch({ code: 429, msg: "Exceeding the rate limit", request_id: "req_429" }, 429);
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /code=429 msg=Exceeding the rate limit request_id=req_429/);
});

test("premier_search: a malformed entry does not cost the caller the valid results", async () => {
  captureFetch({
    code: 0, request_id: "req_mixed",
    data: { results: [null, { title: "The good one", url: "https://example.com/good" }, "junk", 7] },
    meta: {},
  });
  const r = await handlePremierSearch({ query: "x" });
  assert.notEqual(r.isError, true);
  assert.match(text(r), /## Result 1\/1: The good one/);
  assert.ok(text(r).includes("https://example.com/good"));
});

test("premier_search: an entry that cannot be rendered is named, and the rest still come back", async () => {
  // An object where a string belongs is not always harmless: one that cannot
  // be converted to a string throws inside the renderer, and without a guard
  // per entry that one throw discards every valid result beside it.
  captureFetch({
    code: 0, request_id: "req_unprintable",
    data: {
      results: [
        { title: { toString: 1 }, url: "https://example.com/bad" },
        { title: "The good one", url: "https://example.com/good", highlight: "kept" },
      ],
    },
    meta: {},
  });
  const r = await handlePremierSearch({ query: "x" });
  assert.notEqual(r.isError, true);
  const out = text(r);
  assert.match(out, /## Result 2\/2: The good one/);
  assert.ok(out.includes("https://example.com/good"));
  assert.match(out, /## Result 1\/2: .*could not be rendered/,
    "the caller should be told an entry was dropped, not left to count");
});

test("premier_search: any non-2xx answer without an Octen code is an error", async () => {
  // Not only 4xx and 5xx: a proxy's 302 with no Location header is handed
  // back as-is rather than followed, and its JSON body has no results either.
  for (const status of [302, 404, 503]) {
    captureFetch({}, status);
    const r = await handlePremierSearch({ query: "x" });
    assert.equal(r.isError, true, `HTTP ${status} was reported as an empty result`);
    assert.match(text(r), new RegExp(`HTTP ${status}`));
  }
});

test("premier_search: a 200 that is not an Octen response is an error, not an empty search", async () => {
  // A base URL pointed at the wrong service, or a proxy answering in the
  // API's place, can return 200 with JSON of its own. It has no results
  // because it is not a search response at all — reporting "No results"
  // would hide a routing mistake behind a plausible answer.
  // What marks a response as Octen's is its `request_id`, which the reference
  // requires on every answer. `data` and `code` are not enough on their own:
  // plenty of unrelated services return both.
  for (const body of [
    {}, { status: "ok" }, [], "ok", null,
    { data: [] }, { data: { status: "unavailable" } }, { code: 0, data: { results: [] } },
    { request_id: "" }, { request_id: 42 },
  ]) {
    captureFetch(body, 200);
    const r = await handlePremierSearch({ query: "x" });
    assert.equal(r.isError, true, `${JSON.stringify(body)} was reported as an empty result`);
    assert.match(text(r), /not an Octen response/);
    assert.doesNotMatch(text(r), /No results/);
  }
});

test("premier_search: a genuine empty result is still an empty result", async () => {
  // The other side of the check above: `request_id` is the only field the
  // reference requires, so a response that carries it and nothing else is
  // still Octen's — a real zero-result answer is never mistaken for a
  // foreign one for leaving out a field it was allowed to leave out.
  for (const body of [
    { request_id: "req_1" },
    { request_id: "req_2", code: 0, msg: "success", data: { query: "zzz", results: [] }, meta: {} },
  ]) {
    captureFetch(body, 200);
    const r = await handlePremierSearch({ query: "zzz" });
    assert.notEqual(r.isError, true, `${JSON.stringify(body)} was refused as foreign`);
    assert.match(text(r), /^No results for "zzz"\./);
  }
});

test("premier_search: `results` that is not a list is an empty result, not a crash", async () => {
  for (const results of [{}, "none", 3, null]) {
    captureFetch({ code: 0, request_id: "req_shape", data: { results }, meta: {} });
    const r = await handlePremierSearch({ query: "zzz" });
    assert.notEqual(r.isError, true);
    assert.match(text(r), /^No results for "zzz"\./);
  }
});

test("premier_search: declares exactly the parameters /search-premier documents", () => {
  // Transcribed from docs.octen.ai/api-reference/search-premier (2026-11-23),
  // plus `timeout`, which is this server's own deadline. Most of these are
  // shared out of `search`'s schema; this list is what stops a parameter that
  // `search` grows later from arriving here without the reference saying so.
  assert.deepEqual(Object.keys(premierSearchTool.inputSchema.properties).sort(), [
    "count", "end_time", "exclude_domains", "exclude_text", "format", "full_content",
    "highlight", "include_domains", "include_images", "include_text", "language",
    "query", "result_type", "safesearch", "start_time", "time_basis", "time_range",
    "timeout",
  ]);
  assert.deepEqual(premierSearchTool.inputSchema.required, ["query"]);
});

test("premier_search: `result_type` is the very definition `search` advertises", () => {
  // Both tools take it from one place; if they ever diverge it should be a
  // decision, and this is where it shows. The enum assertions in
  // apiContract.test.mjs keep `premier_search` pinned to the reference alone.
  assert.deepEqual(premierSearchTool.inputSchema.properties.result_type,
    searchTool.inputSchema.properties.result_type);
});

test("premier_search: the schema gate refuses an undocumented result_type", () => {
  const schema = premierSearchTool.inputSchema;
  assert.equal(validateArgs(schema, { query: "x", result_type: "dynamic" }), null);
  assert.match(validateArgs(schema, { query: "x", result_type: "deep" }) ?? "",
    /Invalid value for `result_type`/);
});

test("premier_search: a call that arrives without a key is refused, never served on the process's own", async () => {
  // The transport hands the handler the caller's credential. When there is
  // none, falling back to OCTEN_API_KEY from the environment would let an
  // unauthenticated caller ride the deployment's own key — and this process
  // has one set, so a fallback would show up here as a request.
  const captured = captureFetch();
  const http = await handlePremierSearch({ query: "x" }, { apiKey: undefined, transport: "http" });
  assert.equal(http.isError, true);
  assert.match(text(http), /No API key on this request/);
  const stdio = await handlePremierSearch({ query: "x" }, { apiKey: undefined, transport: "stdio" });
  assert.equal(stdio.isError, true);
  assert.match(text(stdio), /OCTEN_API_KEY env var is not set/);
  assert.equal(captured.calls, 0, "a call with no credential still reached the API");
});

test("premier_search: a connection failure is a tool error naming the API, not a thrown exception", async () => {
  let calls = 0;
  _setFetchForTests(async () => {
    calls += 1;
    const e = new TypeError("fetch failed");
    e.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    throw e;
  });
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /^Network error calling Octen Web Search Premier: /);
  assert.match(text(r), /ECONNREFUSED/);
  assert.ok(calls >= 1);
});

test("premier_search: an error that says `message` instead of `msg` keeps what it said", async () => {
  // Octen's envelope says `msg`. A hop in front of it that passes the request
  // id through but answers in its own words says `message`; printing
  // `(no msg)` would throw away the only explanation there is.
  captureFetch({ code: 503, message: "upstream connect error", request_id: "req_hop" }, 503);
  const r = await handlePremierSearch({ query: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /upstream connect error/);
  assert.match(text(r), /request_id=req_hop/);
  assert.doesNotMatch(text(r), /\(no msg\)/);
});
