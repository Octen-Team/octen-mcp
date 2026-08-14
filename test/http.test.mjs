/**
 * Tests for the shared HTTP layer (built output).
 *
 * Every assertion here fails against 0.3.7, which sent no AbortSignal unless
 * the caller passed `timeout`, reported `err.message` ("fetch failed") while
 * discarding `err.cause`, never retried, and sent no correlation id.
 *
 * Global `fetch` is stubbed, so no network traffic happens.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { handleSearch, handleBroadSearch } = await import("../dist/search.js");
const { handleExtract } = await import("../dist/extract.js");

const OK_BODY = { code: 0, data: { results: [] } };

/** Stub fetch that records every attempt and replays a scripted outcome list. */
function scriptFetch(outcomes) {
  const attempts = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    attempts.push({ url: String(url), init });
    const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return { status: 200, json: async () => outcome };
  };
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

test("failures surface the correlation id so a ticket maps to server logs", async () => {
  scriptFetch([fetchFailed(Object.assign(new Error("nope"), { code: "CERT_HAS_EXPIRED" }))]);
  assert.match(textOf(await handleSearch({ query: "hi" })), /request_id=[0-9a-f-]{36}/);
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

test("broad_search gets the longer default budget (server-side fan-out)", async () => {
  scriptFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
  assert.match(textOf(await handleBroadSearch({ query: "hi" })), /timed out after 60s/);
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

test("broad_search does not advise raising a `timeout` already at its schema max", async () => {
  scriptFetch([Object.assign(new Error("aborted"), { name: "TimeoutError" })]);
  const out = await handleBroadSearch({ query: "hi" });
  assert.match(textOf(out), /timed out after 60s/);
  assert.doesNotMatch(textOf(out), /raise this ceiling/,
    "60s is already the schema maximum — telling an agent to raise it is unactionable advice");
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
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 900));
    throw fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  };
  const out = await handleSearch({ query: "hi", timeout: 1 });
  assert.equal(calls, 1, "retried into a budget that could not fit it");
  assert.match(textOf(out), /ECONNRESET/, "lost the specific diagnosis to a generic timeout");
});
