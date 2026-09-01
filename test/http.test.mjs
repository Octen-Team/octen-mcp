/**
 * Tests for the shared HTTP layer (built output).
 *
 * Every assertion here fails against 0.3.7, which sent no AbortSignal unless
 * the caller passed `timeout`, reported `err.message` ("fetch failed") while
 * discarding `err.cause`, never retried, and sent no correlation id.
 *
 * The HTTP layer's fetch is stubbed through its test seam, so no network
 * traffic happens. Stubbing `globalThis.fetch` would be a no-op: since the
 * undici-8 host incompatibility fix, the module fetches through the packaged
 * undici, never through the global.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { handleSearch, handleBroadSearch, broadSearchTool } = await import("../dist/search.js");
const { handleExtract } = await import("../dist/extract.js");
const { _setFetchForTests } = await import("../dist/http.js");

const OK_BODY = { code: 0, data: { results: [] } };

/** Stub fetch that records every attempt and replays a scripted outcome list. */
function scriptFetch(outcomes) {
  const attempts = [];
  let i = 0;
  _setFetchForTests(async (url, init) => {
    attempts.push({ url: String(url), init });
    const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    // Carry a real `headers` object: the debug path reads response headers, and
    // a stub without them hides breakage there behind a passing test.
    return { status: 200, headers: new Headers(), json: async () => outcome };
  });
  return attempts;
}

/** Build the `TypeError: fetch failed` shape Node actually throws. */
function fetchFailed(cause) {
  const e = new TypeError("fetch failed");
  e.cause = cause;
  return e;
}

function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

test("search: a default client timeout is applied when the caller omits `timeout`", async () => {
  const attempts = scriptFetch([OK_BODY]);
  await handleSearch({ query: "hi" });
  const { signal } = attempts[0].init;
  assert.ok(signal, "no AbortSignal was attached — a stalled request would hang on undici's 300s headersTimeout");
  assert.equal(typeof signal.aborted, "boolean");
});

test("extract: also gets a client timeout (its own `timeout` is a server-side, per-URL budget)", async () => {
  const attempts = scriptFetch([{ code: 0, data: { results: [] } }]);
  await handleExtract({ urls: ["https://example.com"], timeout: 45 });
  assert.ok(attempts[0].init.signal, "extract sent no AbortSignal");
  // The per-URL budget must still travel in the body, unchanged.
  assert.equal(JSON.parse(attempts[0].init.body).timeout, 45);
});

test("network errors report cause.code, not the useless `fetch failed`", async () => {
  scriptFetch([fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))]);
  const out = await handleSearch({ query: "hi" });
  assert.equal(out.isError, true);
  const text = textOf(out);
  assert.match(text, /ECONNRESET/, "cause.code was dropped — this is what made tickets undiagnosable");
  assert.doesNotMatch(text, /^Network error calling Octen Search: fetch failed$/);
});

test("AggregateError sub-errors are unwrapped (happy-eyeballs: all addresses failed)", async () => {
  const agg = new AggregateError(
    [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", address: "1.2.3.4", port: 443 })],
    "all attempts failed"
  );
  // Non-retryable at the top level so we assert on the final message, not a retry.
  scriptFetch([fetchFailed(agg), fetchFailed(agg)]);
  const out = await handleSearch({ query: "hi" });
  assert.match(textOf(out), /ETIMEDOUT/);
  assert.match(textOf(out), /1\.2\.3\.4:443/);
});

test("connection-level failures are retried once, then succeed", async () => {
  const attempts = scriptFetch([
    fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    OK_BODY,
  ]);
  const out = await handleSearch({ query: "hi" });
  assert.notEqual(out.isError, true, `expected success after retry, got: ${textOf(out)}`);
  assert.equal(attempts.length, 2, "the idle-keepalive ECONNRESET race was not retried");
});

test("non-connection failures are not retried", async () => {
  const attempts = scriptFetch([
    fetchFailed(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })),
  ]);
  const out = await handleSearch({ query: "hi" });
  assert.equal(out.isError, true);
  assert.equal(attempts.length, 1, "a permanent failure must not be retried");
  assert.match(textOf(out), /CERT_HAS_EXPIRED/);
});

test("one correlation id is sent, and stays stable across the retry", async () => {
  const attempts = scriptFetch([
    fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    OK_BODY,
  ]);
  await handleSearch({ query: "hi" });
  const ids = attempts.map((a) => a.init.headers["x-request-id"]);
  assert.ok(ids[0], "no x-request-id header — failed requests cannot be located in server logs");
  assert.equal(ids[0], ids[1], "retry used a different correlation id");
});

test("network errors carry NO client-generated request_id — support cannot look it up", async () => {
  // A UUID labelled request_id reads like something Octen support can search.
  // They cannot (the gateway does not record the x-request-id header), so a
  // ticket quoting it dead-ends — the exact mutual-unaccountability failure
  // the 0.4.0 incident was about. The UUID belongs to the debug trace only.
  scriptFetch([fetchFailed(Object.assign(new Error("nope"), { code: "CERT_HAS_EXPIRED" }))]);
  const text = textOf(await handleSearch({ query: "hi" }));
  assert.doesNotMatch(text, /request_id=[0-9a-f-]{36}/,
    "client UUID leaked into a user-facing message");
  assert.match(text, /CERT_HAS_EXPIRED/, "the actionable part (the code) must remain");
});

test("server envelope errors DO carry the server's request_id — the one support can search", async () => {
  scriptFetch([{ code: 401, msg: "Invalid API Key", request_id: "20260815SRVID0000001" }]);
  const text = textOf(await handleSearch({ query: "hi" }));
  assert.match(text, /request_id=20260815SRVID0000001/);
});

test("a timeout says so, and points at the knob when the caller set none", async () => {
  scriptFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
  const out = await handleSearch({ query: "hi" });
  assert.equal(out.isError, true);
  assert.match(textOf(out), /timed out after 30s/);
  assert.match(textOf(out), /raise this ceiling/);
});

test("extract's timeout hint is not called a `default` — it derives from the caller's own value", async () => {
  scriptFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
  const out = await handleExtract({ urls: ["https://example.com"], timeout: 45 });
  // 45s per-URL budget + 90s headroom.
  assert.match(textOf(out), /timed out after 135s/);
  assert.doesNotMatch(textOf(out), /default/, "135s is derived from timeout=45, not a default");
});

test("broad_search gets a longer default budget than search (server-side fan-out)", async () => {
  scriptFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
  assert.match(textOf(await handleBroadSearch({ query: "hi" })), /timed out after 120s/);
});

test("a caller-supplied `timeout` still wins over the default", async () => {
  scriptFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
  const out = await handleSearch({ query: "hi", timeout: 5 });
  assert.match(textOf(out), /timed out after 5s/);
  assert.doesNotMatch(textOf(out), /client default/);
});

test("the retry shares the first attempt's deadline instead of starting a fresh one", async () => {
  const attempts = scriptFetch([
    fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    OK_BODY,
  ]);
  await handleSearch({ query: "hi" });
  assert.equal(attempts.length, 2);
  // Same AbortSignal instance on both attempts. Building it per attempt would
  // give the retry a full fresh budget, so a 30s timeout could run for 60s —
  // the "tool call that never returns" failure this module exists to prevent.
  assert.strictEqual(
    attempts[0].init.signal,
    attempts[1].init.signal,
    "retry got a fresh timeout budget rather than the remainder of the original"
  );
});

test("requests go through the tuned dispatcher, not undici's 4s-keepalive global", async () => {
  const attempts = scriptFetch([OK_BODY]);
  await handleSearch({ query: "hi" });
  assert.ok(attempts[0].init.dispatcher, "no dispatcher — every call more than 4s apart re-pays the TLS handshake");
});

test("broad_search keeps a budget wider than the `timeout` parameter's own range", async () => {
  scriptFetch([Object.assign(new Error("aborted"), { name: "TimeoutError" })]);
  const out = await handleBroadSearch({ query: "hi" });
  // 0.3.7 left this call with undici's 300s and no client deadline. Capping the
  // default at the parameter's old 60s maximum would have failed surveys that
  // used to succeed, with nothing the caller could do about it.
  assert.match(textOf(out), /timed out after 120s/);
  assert.match(textOf(out), /raise this ceiling/, "there must be an escape hatch");
  assert.equal(broadSearchTool.inputSchema.properties.timeout.maximum, 300);
});

test("extract advises raising `timeout` only while it is below its own max", async () => {
  scriptFetch([Object.assign(new Error("aborted"), { name: "TimeoutError" })]);
  const raisable = textOf(await handleExtract({ urls: ["https://e.com"], timeout: 30 }));
  assert.match(raisable, /raise this ceiling/);

  scriptFetch([Object.assign(new Error("aborted"), { name: "TimeoutError" })]);
  const maxed = textOf(await handleExtract({ urls: ["https://e.com"], timeout: 60 }));
  assert.doesNotMatch(maxed, /raise this ceiling/, "timeout=60 is the schema max; cannot be raised");
});

test("no retry when the remaining budget cannot fit one", async () => {
  // `timeout: 1` — attempt 1 burns most of it, so retrying would abort instantly
  // and replace a real ECONNRESET diagnosis with a generic timeout.
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 900));
    throw fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  });
  const out = await handleSearch({ query: "hi", timeout: 1 });
  assert.equal(calls, 1, "retried into a budget that could not fit it");
  assert.match(textOf(out), /ECONNRESET/, "lost the specific diagnosis to a generic timeout");
});

// ---------------------------------------------------------------------------
// Branch-completeness: every tool × every body-read failure shape.
// The real-socket suite proves the shapes are real (bodyTimeout.test.mjs) but
// only exercises `search`; this pins the shared classifier's wiring — label
// and branch — for all five handlers, in-process where coverage can see it.
// ---------------------------------------------------------------------------
const { handleImageSearch } = await import("../dist/imageSearch.js");
const { handleVideoSearch } = await import("../dist/videoSearch.js");

const ALL_TOOLS = [
  ["Octen Search", () => handleSearch({ query: "x" })],
  ["Octen Broad Search", () => handleBroadSearch({ query: "x" })],
  ["Octen Extract", () => handleExtract({ urls: ["https://e.com"] })],
  ["Octen Image Search", () => handleImageSearch({ query: "x" })],
  ["Octen Video Search", () => handleVideoSearch({ query: "x" })],
];

function stubJsonReject(err) {
  _setFetchForTests(async () => ({ status: 200, headers: new Headers(), json: async () => { throw err; } }));
}

test("every tool classifies all three body-read failure shapes under its own label", async () => {
  const SHAPES = [
    [Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      (label) => new RegExp(`^${label} timed out while reading the response body \\(HTTP 200\\)$`)],
    [Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } }),
      (label) => new RegExp(`^${label}: connection lost while reading the response body \\(HTTP 200, code=ECONNRESET\\)$`)],
    [new SyntaxError("Unexpected token"),
      (label) => new RegExp(`^${label} returned non-JSON \\(HTTP 200\\)$`)],
  ];
  for (const [label, invoke] of ALL_TOOLS) {
    for (const [err, expect] of SHAPES) {
      stubJsonReject(err);
      const out = await invoke();
      assert.equal(out.isError, true, `${label}: expected error for ${err.name}`);
      const text = textOf(out);
      assert.match(text, expect(label), `${label} / ${err.name}: got "${text}"`);
    }
  }
});

test("every tool relays a server envelope error verbatim with the server's request_id", async () => {
  for (const [label, invoke] of ALL_TOOLS) {
    _setFetchForTests(async () => ({
      status: 200, headers: new Headers(),
      json: async () => ({ code: 403, msg: "Beta access required", request_id: "20260815SRVENV000001" }),
    }));
    const out = await invoke();
    assert.equal(out.isError, true, label);
    const text = textOf(out);
    assert.match(text, new RegExp(`^${label}: code=403 msg=Beta access required`), `${label}: got "${text}"`);
    assert.match(text, /request_id=20260815SRVENV000001/, `${label}: server request_id missing`);
  }
});

test("every tool rejects empty input before touching the network", async () => {
  let fetched = false;
  _setFetchForTests(async () => { fetched = true; throw new Error("must not be called"); });
  // Each tool states its own rule, so each gets its own expected wording — a
  // shared pattern would have to be so loose it stopped checking anything.
  // `image_search` takes exactly one of two inputs rather than one required
  // one, so "must be a non-empty query" is not what it should say.
  const EMPTY = [
    [() => handleSearch({ query: "  " }), /must be a non-empty/],
    [() => handleBroadSearch({ query: "" }), /must be a non-empty/],
    [() => handleExtract({ urls: [] }), /must be a non-empty/],
    [() => handleImageSearch({}), /`query`.*`image_url`|`image_url`.*`query`/],
    [() => handleVideoSearch({ query: "" }), /must be a non-empty/],
  ];
  for (const [invoke, expected] of EMPTY) {
    const out = await invoke();
    assert.equal(out.isError, true);
    assert.match(textOf(out), expected);
  }
  assert.equal(fetched, false, "validation failures must not reach the network");
});

test("happy-eyeballs failures report every distinct address family's code, not just the first", async () => {
  // IPv6 blackholed + IPv4 refused fail with different codes; reporting only
  // errors[0] hides half the diagnosis.
  const agg = new AggregateError([
    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", address: "2001:db8::1", port: 443 }),
    Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH", address: "192.0.2.9", port: 443 }),
  ], "all attempts failed");
  scriptFetch([fetchFailed(agg), fetchFailed(agg)]);
  const text = textOf(await handleSearch({ query: "x" }));
  assert.match(text, /code=ETIMEDOUT/);
  assert.match(text, /also=ENETUNREACH/, `second family's code dropped: "${text}"`);
});
