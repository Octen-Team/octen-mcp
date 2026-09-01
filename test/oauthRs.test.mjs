/**
 * Resource-server side of OAuth (spec §A3), against a real mini
 * authorization-server: an in-test RSA keypair served over a live JWKS
 * endpoint, RS256 tokens minted with node:crypto, and a resolve-key stub that
 * enforces the X-Octen-Service-Token header — the same contract the real AS
 * implements (read from its source, fosite v0.49 + grant_id claim).
 *
 * The failure split is the point under test (spec §A3.5): token problems must
 * be transport-level 401 + WWW-Authenticate (clients auto-refresh on it — an
 * isError tool result breaks that loop), while backend unavailability must be
 * 503 (the token may be fine; a client that burns its refresh flow on our
 * outage gets logged out for nothing).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { startHttp, startUpstream, call } from "./helpers.mjs";

// ---- mini authorization server ----------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function mint({ kid = KID, alg = "RS256", ...claims }) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iat: now, exp: now + 3600, jti: `jti-${Math.random()}`, ...claims,
  }));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

/** JWKS + resolve-key in one process, with hit counters the tests assert on. */
function startAs({ serviceToken = "svc-secret" } = {}) {
  const hits = { jwks: 0, resolve: 0 };
  const revoked = new Set(["revoked-grant"]);
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/oauth/jwks") {
      hits.jwks++;
      const jwk = publicKey.export({ format: "jwk" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/oauth/resolve-key") {
      hits.resolve++;
      if (req.headers["x-octen-service-token"] !== serviceToken) {
        res.writeHead(401); res.end(); return;
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { grant_id } = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(revoked.has(grant_id)
          ? JSON.stringify({ active: false })
          : JSON.stringify({ active: true, api_key: `resolved-key-for-${grant_id}`, account_type: "user", account_id: "u1" }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({
    port: srv.address().port, hits, close: () => srv.close(),
    issuer: `http://127.0.0.1:${srv.address().port}`,
  })));
}

const RESOURCE = "https://mcp.octen.example/mcp";

async function startStack(extraEnv = {}) {
  const as = await startAs();
  const up = await startUpstream();
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`,
    OCTEN_OAUTH_AUTHORIZATION_SERVER: as.issuer,
    OCTEN_MCP_RESOURCE: RESOURCE,
    OCTEN_OAUTH_RESOLVE_URL: `${as.issuer}/internal/oauth/resolve-key`,
    OCTEN_OAUTH_RESOLVE_TOKEN: "svc-secret",
    OCTEN_MCP_DEBUG: "1",
    ...extraEnv,
  });
  return { as, up, srv, stop: () => { srv.stop(); up.close(); as.close(); } };
}

/** POST a tool call with a Bearer token; return {status, headers, msg}. */
async function bearerCall(port, token, id = 2) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(call(id, "q")),
  });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
  return {
    status: res.status,
    wwwAuth: res.headers.get("www-authenticate"),
    msg: data ? JSON.parse(data.slice(6)) : (text ? JSON.parse(text) : undefined),
  };
}

function validClaims(as, grant = "grant-abc") {
  return { iss: as.issuer, aud: [RESOURCE], scp: ["mcp:tools"], sub: "u1", grant_id: grant };
}

// ------------------------------------------------------------------------------

test("a valid access token is exchanged for the grant's API key before dispatch", async () => {
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, mint(validClaims(stack.as)));
    assert.equal(r.status, 200);
    assert.notEqual(r.msg.result.isError, true, r.msg.result?.content?.[0]?.text);
    // The upstream must have been called with the RESOLVED key, not the JWT.
    assert.deepEqual(stack.up.seenKeys, ["resolved-key-for-grant-abc"]);
    assert.ok(stack.as.hits.resolve >= 1, "resolve-key endpoint was never consulted");
  } finally { stack.stop(); }
});

test("an expired token is a transport 401 with a challenge — never a tool-result error", async () => {
  const stack = await startStack();
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await bearerCall(stack.srv.port, mint({ ...validClaims(stack.as), exp: now - 120 }));
    assert.equal(r.status, 401, "clients auto-refresh on 401; an isError breaks that loop");
    assert.match(r.wwwAuth ?? "", /invalid_token/);
    assert.match(r.wwwAuth ?? "", /resource_metadata="https:\/\/mcp\.octen\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal(stack.up.seenKeys.length, 0, "an invalid token must never reach the upstream");
  } finally { stack.stop(); }
});

test("exp within the 60s clock tolerance still passes", async () => {
  const stack = await startStack();
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await bearerCall(stack.srv.port, mint({ ...validClaims(stack.as), exp: now - 30 }));
    assert.equal(r.status, 200, "AS/RS clock skew below tolerance must not log users out");
  } finally { stack.stop(); }
});

test("audience, issuer, and scope are each enforced byte-for-byte", async () => {
  const stack = await startStack();
  try {
    const cases = [
      { ...validClaims(stack.as), aud: ["https://mcp.octen.example/mcp/"] }, // trailing slash
      { ...validClaims(stack.as), iss: `${stack.as.issuer}/` },
      { ...validClaims(stack.as), scp: ["something:else"] },
      { ...validClaims(stack.as), grant_id: undefined },
    ];
    for (const claims of cases) {
      const r = await bearerCall(stack.srv.port, mint(claims));
      assert.equal(r.status, 401, `claims ${JSON.stringify(claims).slice(0, 90)} must be rejected`);
    }
    assert.equal(stack.up.seenKeys.length, 0);
  } finally { stack.stop(); }
});

test("an unknown kid triggers exactly one JWKS refetch before rejecting (rotation path)", async () => {
  // A short window rather than the 10s default: the point under test is that
  // the refetch still happens once the window passes, not how long it is.
  const stack = await startStack({ OCTEN_JWKS_REFETCH_COOLDOWN_MS: "50" });
  try {
    await bearerCall(stack.srv.port, mint(validClaims(stack.as))); // primes the JWKS cache
    await new Promise((r) => setTimeout(r, 80));
    const before = stack.as.hits.jwks;
    const r = await bearerCall(stack.srv.port, mint({ ...validClaims(stack.as), kid: "freshly-rotated" }));
    assert.equal(r.status, 401);
    assert.equal(stack.as.hits.jwks, before + 1,
      "a just-published kid must get one refetch — zero breaks rotation, unbounded is a DoS lever");
  } finally { stack.stop(); }
});

test("a revoked grant is a 401 (re-authorize), not a 503", async () => {
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, mint(validClaims(stack.as, "revoked-grant")));
    assert.equal(r.status, 401, "revocation means the client must re-authorize — 503 would make it retry forever");
    assert.equal(stack.up.seenKeys.length, 0);
  } finally { stack.stop(); }
});

test("resolve-key backend down is a 503, not a 401 — the token may be fine", async () => {
  const as = await startAs();
  const up = await startUpstream();
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`,
    OCTEN_OAUTH_AUTHORIZATION_SERVER: as.issuer,
    OCTEN_MCP_RESOURCE: RESOURCE,
    OCTEN_OAUTH_RESOLVE_URL: "http://127.0.0.1:45996/internal/oauth/resolve-key", // nothing there
    OCTEN_OAUTH_RESOLVE_TOKEN: "svc-secret",
  });
  try {
    const r = await bearerCall(srv.port, mint(validClaims(as)));
    assert.equal(r.status, 503, "a 401 here would make clients burn their refresh flow on our outage");
    // Says which dependency and why. "temporarily unavailable" on its own fits
    // every cause equally and is what made the earlier reports unactionable.
    assert.match(r.msg.error.message, /grant-resolution service/);
    assert.match(r.msg.error.message, /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|no response within/);
    assert.match(r.msg.error.message, /retry shortly rather than re-authorizing/);
  } finally { srv.stop(); up.close(); as.close(); }
});

test("the resolved key is cached: two calls on one grant hit resolve-key once", async () => {
  const stack = await startStack();
  try {
    await bearerCall(stack.srv.port, mint(validClaims(stack.as)), 2);
    await bearerCall(stack.srv.port, mint(validClaims(stack.as)), 3);
    assert.equal(stack.as.hits.resolve, 1, "resolve-key sits on the hot path; the 60s cache is the SLA backstop");
    assert.equal(stack.up.seenKeys.length, 2);
  } finally { stack.stop(); }
});

test("bare API keys never enter the OAuth path even with it fully configured", async () => {
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, "octen-plain-api-key-123");
    assert.equal(r.status, 200);
    assert.deepEqual(stack.up.seenKeys, ["octen-plain-api-key-123"],
      "a bare key must pass through verbatim — the two credential forms share one header");
    assert.equal(stack.as.hits.jwks + stack.as.hits.resolve, 0,
      "no OAuth endpoint may be consulted for a non-JWT credential");
  } finally { stack.stop(); }
});
