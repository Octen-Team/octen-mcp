/**
 * Client-identifying headers copied from the inbound request onto the outbound
 * API call, and the marker that tells API traffic arriving through this server
 * apart from a customer calling the API directly.
 *
 * The marker exists because the forwarded set includes `user-agent`: once the
 * caller's own value is relayed, that header no longer identifies this server.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { handleSearch } = await import("../dist/search.js");
const { _setFetchForTests, forwardableHeaders, FORWARDED_HEADERS } = await import("../dist/http.js");

function scriptFetch() {
  const attempts = [];
  _setFetchForTests(async (url, init) => {
    attempts.push({ url: String(url), headers: init.headers });
    return { status: 200, headers: new Headers(), json: async () => ({ code: 0, data: { results: [] } }) };
  });
  return attempts;
}

// ---- picking them out of an inbound request ------------------------------

test("picks exactly the allowlisted headers and ignores the rest", () => {
  const got = forwardableHeaders({
    "user-agent": "Claude-Code/2.1",
    "x-real-ip": "203.0.113.7",
    "x-api-key": "someone-elses-key",
    cookie: "session=abc",
    "content-type": "application/json",
  });
  assert.deepEqual(got, { "user-agent": "Claude-Code/2.1", "x-real-ip": "203.0.113.7" });
});

test("joins a repeated header the way a proxy writes one list", () => {
  const got = forwardableHeaders({ "x-forwarded-for": ["203.0.113.7", "198.51.100.2"] });
  assert.equal(got["x-forwarded-for"], "203.0.113.7, 198.51.100.2");
});

test("drops an empty or absurdly long value rather than passing it on", () => {
  const got = forwardableHeaders({
    "x-real-ip": "   ",
    "user-agent": "u".repeat(513),
    "x-forwarded-for": "203.0.113.7",
  });
  assert.deepEqual(got, { "x-forwarded-for": "203.0.113.7" });
});

test("the allowlist is the five the API attributes on", () => {
  assert.deepEqual([...FORWARDED_HEADERS].sort(), [
    "user-agent", "x-azure-clientip", "x-azure-socketip", "x-forwarded-for", "x-real-ip",
  ].sort());
});

// ---- what reaches the API ------------------------------------------------

test("forwarded headers reach the outbound call", async () => {
  const attempts = scriptFetch();
  await handleSearch({ query: "q" }, {
    apiKey: "k",
    transport: "http",
    forward: { "user-agent": "Claude-Code/2.1", "x-real-ip": "203.0.113.7" },
  });
  assert.equal(attempts[0].headers["user-agent"], "Claude-Code/2.1");
  assert.equal(attempts[0].headers["x-real-ip"], "203.0.113.7");
});

test("the source marker is sent even with nothing to forward", async () => {
  const attempts = scriptFetch();
  await handleSearch({ query: "q" }, { apiKey: "k", transport: "stdio" });
  assert.equal(attempts[0].headers["x-octen-source"], "mcp");
  assert.match(attempts[0].headers["x-octen-mcp-version"], /^\d+\.\d+\.\d+/);
});

test("a forwarded header cannot displace the credential or the marker", async () => {
  const attempts = scriptFetch();
  await handleSearch({ query: "q" }, {
    apiKey: "real-key",
    transport: "http",
    forward: { "x-api-key": "spoofed", "x-octen-source": "direct", "user-agent": "ua" },
  });
  assert.equal(attempts[0].headers["x-api-key"], "real-key");
  assert.equal(attempts[0].headers["x-octen-source"], "mcp");
  assert.equal(attempts[0].headers["user-agent"], "ua");
});
