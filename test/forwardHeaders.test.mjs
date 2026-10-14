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
// Read once at import, so it has to be in place before the module loads.
const FDID = "11111111-2222-3333-4444-555555555555";
process.env.OCTEN_MCP_FRONT_DOOR_ID = FDID;

const { handleSearch } = await import("../dist/search.js");
const { _setFetchForTests, forwardableHeaders, FORWARDED_HEADERS, PEER_HEADER, CLIENT_IP_HEADER } =
  await import("../dist/http.js");

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
    "x-forwarded-for": "203.0.113.7",
    // Trusted by default in nginx and Express, and nothing on the path
    // rewrites it, so it is dropped rather than relayed.
    "x-real-ip": "198.51.100.1",
    "x-api-key": "someone-elses-key",
    cookie: "session=abc",
    "content-type": "application/json",
  });
  // No peer passed, so nothing is written on top and this is the relayed set
  // alone: the caller's own x-real-ip is simply gone.
  assert.deepEqual(got, { "user-agent": "Claude-Code/2.1", "x-forwarded-for": "203.0.113.7" });
});

test("joins a repeated header the way a proxy writes one list", () => {
  const got = forwardableHeaders({ "x-forwarded-for": ["203.0.113.7", "198.51.100.2"] });
  assert.equal(got["x-forwarded-for"], "203.0.113.7, 198.51.100.2");
});

test("drops an empty or absurdly long value rather than passing it on", () => {
  const got = forwardableHeaders({
    "x-azure-clientip": "   ",
    "user-agent": "u".repeat(513),
    "x-forwarded-for": "203.0.113.7",
  });
  assert.deepEqual(got, { "x-forwarded-for": "203.0.113.7" });
});

test("the allowlist is the four the API attributes on", () => {
  assert.deepEqual([...FORWARDED_HEADERS].sort(), [
    "user-agent", "x-azure-clientip", "x-azure-socketip", "x-forwarded-for",
  ].sort());
});

// ---- what reaches the API ------------------------------------------------

test("forwarded headers reach the outbound call", async () => {
  const attempts = scriptFetch();
  await handleSearch({ query: "q" }, {
    apiKey: "k",
    transport: "http",
    forward: { "user-agent": "Claude-Code/2.1", "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(attempts[0].headers["user-agent"], "Claude-Code/2.1");
  assert.equal(attempts[0].headers["x-forwarded-for"], "203.0.113.7");
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

// ---- the one address we observe rather than are told ---------------------

test("reports the address the connection was actually accepted from", () => {
  const got = forwardableHeaders({ "x-forwarded-for": "203.0.113.7" }, "198.51.100.42");
  assert.equal(got[PEER_HEADER], "198.51.100.42");
  // The claimed address still travels; the point is that both are present and
  // the API can see they disagree.
  assert.equal(got["x-forwarded-for"], "203.0.113.7");
});

test("a caller cannot forge the observed peer", () => {
  const got = forwardableHeaders(
    { [PEER_HEADER]: "10.0.0.1", "x-forwarded-for": "10.0.0.1" },
    "198.51.100.42",
  );
  assert.equal(got[PEER_HEADER], "198.51.100.42");
});

test("omits the peer when there is no connection to read it from", () => {
  assert.equal(PEER_HEADER in forwardableHeaders({ "x-forwarded-for": "203.0.113.7" }), false);
});

// ---- the end user's address, under a name no proxy rewrites ---------------

test("takes the client address from the socket IP Front Door established", () => {
  const got = forwardableHeaders({
    "x-azure-fdid": FDID,
    "x-azure-socketip": "203.0.113.7",
    // What the caller claimed. It travels, but it is not what gets trusted.
    "x-azure-clientip": "10.0.0.1",
    "x-forwarded-for": "10.0.0.1",
  }, "198.51.100.42");
  assert.equal(got[CLIENT_IP_HEADER], "203.0.113.7");
});

test("falls back to the observed peer with no front end in the path", () => {
  assert.equal(forwardableHeaders({}, "198.51.100.42")[CLIENT_IP_HEADER], "198.51.100.42");
});

test("a caller cannot forge the client address directly", () => {
  const got = forwardableHeaders(
    { "x-azure-fdid": FDID, [CLIENT_IP_HEADER]: "10.0.0.1", "x-azure-socketip": "203.0.113.7" },
    "198.51.100.42",
  );
  assert.equal(got[CLIENT_IP_HEADER], "203.0.113.7");
});

// ---- the front-door gate --------------------------------------------------

test("ignores a socket IP that did not arrive through the front door", () => {
  // Exactly what someone reaching the origin directly would send.
  const got = forwardableHeaders({ "x-azure-socketip": "10.0.0.1" }, "198.51.100.42");
  assert.equal(got[CLIENT_IP_HEADER], "198.51.100.42");
});

test("ignores a socket IP carrying someone else's front-door id", () => {
  const got = forwardableHeaders(
    { "x-azure-fdid": "99999999-9999-9999-9999-999999999999", "x-azure-socketip": "10.0.0.1" },
    "198.51.100.42",
  );
  assert.equal(got[CLIENT_IP_HEADER], "198.51.100.42");
});

test("sends x-real-ip, but never the caller's own value", () => {
  const got = forwardableHeaders({ "x-real-ip": "10.0.0.1" }, "198.51.100.42");
  assert.equal(got["x-real-ip"], "198.51.100.42");
});

test("x-real-ip agrees with the client address behind the front door", () => {
  const got = forwardableHeaders(
    { "x-azure-fdid": FDID, "x-azure-socketip": "203.0.113.7", "x-real-ip": "10.0.0.1" },
    "198.51.100.42",
  );
  assert.equal(got["x-real-ip"], "203.0.113.7");
  assert.equal(got[CLIENT_IP_HEADER], "203.0.113.7");
});
