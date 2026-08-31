/**
 * Adversarial suite: hostile input and mid-flight network faults against the
 * remote HTTP transport.
 *
 * The distinction that organises this file is *who* can reach a code path.
 * `initialize` and `tools/list` are unauthenticated by design, and the OAuth
 * path parses an unverified token header before any signature check — so a
 * large amount of logic runs for anyone who can open a socket. Every test here
 * therefore ends the same way: the process must still be alive and serving.
 * A wrong answer is one failed request; a dead process is the whole
 * deployment, and with `replicas: 1` in pre that is a total outage from a
 * single curl.
 *
 * These are regressions for real defects, each reproduced against the built
 * server before the fix:
 *
 *  - a `kid` containing CRLF reached `res.writeHead` through the
 *    `WWW-Authenticate` challenge and killed the process (`ERR_INVALID_CHAR`
 *    thrown out of an async handler = unhandled rejection = exit);
 *  - 10 unauthenticated requests with made-up `kid`s produced 11 JWKS fetches
 *    against our own authorization server;
 *  - a malformed `OCTEN_MCP_RESOURCE` passed startup and every health probe,
 *    then killed the process on the first `?login` — a pod that is healthy
 *    until someone uses it.
 *
 * The network-fault half exists because the OAuth path adds two synchronous
 * dependencies (JWKS, resolve-key) to what used to be a single upstream call.
 * Each can fail at a different stage — connect, headers, mid-body — and the
 * required behaviour differs per stage: a token problem is 401 so clients
 * refresh, an infrastructure problem is 503 so they retry instead of burning
 * their refresh flow on our outage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { startHttp, SERVER, waitForStderr } from "./helpers.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const RESOURCE = "https://mcp.octen.example/mcp";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function mint({ kid = KID, alg = "RS256", sig: forcedSig, ...claims }) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iat: now, exp: now + 3600, ...claims }));
  if (forcedSig !== undefined) return `${header}.${payload}.${forcedSig}`;
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * Authorization server with a fault switch per endpoint.
 *
 * `mode` values map to the stages a real dependency fails at, which is the
 * axis that matters: `hang` never answers (dead peer holding the socket),
 * `reset` sends headers then tears the connection down mid-body (the shape
 * undici reports as a bare `TypeError: terminated`), `garbage` and `http500`
 * answer promptly but unusably.
 */
function startAs({ serviceToken = "svc-secret", jwks = "ok", resolve = "ok", jwksDelayMs = 0 } = {}) {
  const hits = { jwks: 0, resolve: 0 };
  const held = [];

  const respond = (res, mode, okBody) => {
    switch (mode) {
      case "hang":
        held.push(res); // never answered; socket stays open
        return;
      case "garbage":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("<html>not json at all</html>");
        return;
      case "http500":
        res.writeHead(500);
        res.end("boom");
        return;
      case "reset":
        // Headers promise far more body than we send, then the socket dies.
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "5000" });
        res.write('{"keys":[');
        res.socket.destroy();
        return;
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(okBody));
    }
  };

  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/oauth/jwks") {
      hits.jwks++;
      const jwk = publicKey.export({ format: "jwk" });
      const usable = jwks === "no-rsa"
        ? [{ kty: "EC", kid: KID, crv: "P-256", x: "a", y: "b" }]   // parseable JSON, unusable key
        : [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }];
      const send = () => respond(res, jwks === "no-rsa" ? "ok" : jwks, { keys: usable });
      if (jwksDelayMs) setTimeout(send, jwksDelayMs); else send();
      return;
    }
    if (req.method === "POST" && req.url === "/internal/oauth/resolve-key") {
      hits.resolve++;
      if (req.headers["x-octen-service-token"] !== serviceToken) { res.writeHead(401); res.end(); return; }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { grant_id } = JSON.parse(body);
        respond(res, resolve, { active: true, api_key: `resolved-${grant_id}`, account_type: "user", account_id: "u1" });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, () => r({
    port: srv.address().port, hits,
    issuer: `http://127.0.0.1:${srv.address().port}`,
    close: () => { for (const res of held) res.socket?.destroy(); srv.close(); },
  })));
}

/** Upstream Octen API with the same fault switch, for post-auth stages. */
function startFaultyUpstream(mode = "ok") {
  // Records the credential it was handed. Several tests turn on *what* reached
  // the upstream, not merely whether the call succeeded — forwarding a bearer
  // token here as if it were an API key is itself the defect.
  const seenKeys = [];
  const srv = http.createServer((req, res) => {
    seenKeys.push(req.headers["x-api-key"]);
    if (mode === "reset") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "9999" });
      res.write('{"code":0,"data":{"resu');
      res.socket.destroy();
      return;
    }
    if (mode === "garbage") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>gateway error page</html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { results: [] }, meta: {} }));
  });
  return new Promise((r) => srv.listen(0, () =>
    r({ port: srv.address().port, seenKeys, close: () => srv.close() })));
}

async function startStack({ as: asOpts = {}, upstream = "ok", env = {} } = {}) {
  const as = await startAs(asOpts);
  const up = await startFaultyUpstream(upstream);
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`,
    OCTEN_OAUTH_AUTHORIZATION_SERVER: as.issuer,
    OCTEN_MCP_RESOURCE: RESOURCE,
    OCTEN_OAUTH_RESOLVE_URL: `${as.issuer}/internal/oauth/resolve-key`,
    OCTEN_OAUTH_RESOLVE_TOKEN: "svc-secret",
    ...env,
  });
  return { as, up, srv, stop: () => { srv.stop(); up.close(); as.close(); } };
}

function claims(as, extra = {}) {
  return { iss: as.issuer, aud: [RESOURCE], scp: ["mcp:tools"], sub: "u1", grant_id: "g1", ...extra };
}

async function bearerCall(port, token, { id = 2, timeoutMs = 20000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search", arguments: { query: "q" } } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
  return {
    status: res.status,
    wwwAuth: res.headers.get("www-authenticate"),
    msg: data ? JSON.parse(data.slice(6)) : (text ? JSON.parse(text) : undefined),
  };
}

/**
 * The assertion every test in this file ends with. Checks the process directly
 * rather than only the response: a handler that crashes *after* writing its
 * response still takes the deployment down, and a status-code-only assertion
 * would pass right through it.
 */
async function assertAlive(srv, note) {
  assert.equal(srv.child.exitCode, null,
    `the server process died — ${note}. One request must never be able to do this.\n${srv.stderr()}`);
  const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { signal: AbortSignal.timeout(3000) });
  assert.equal(h.status, 200, `server stopped serving after ${note}`);
}

// ---- Hostile token headers reaching response headers -------------------------

test("a kid carrying CRLF cannot inject a header or kill the process", async () => {
  const stack = await startStack();
  try {
    // Reproduces the original kill exactly: unknown kid → TokenInvalidError
    // whose message was interpolated verbatim into WWW-Authenticate, where the
    // CRLF made `res.writeHead` throw ERR_INVALID_CHAR out of the handler.
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${mint({ kid: "x\r\nInjected-Header: pwned", ...claims(stack.as) })}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "q" } } }),
    });
    await res.text();
    assert.equal(res.status, 401);
    // The header must exist as ONE inert value. Asserting the text is absent
    // would be the wrong bar: sanitising keeps the characters and drops the
    // line break, which is what makes the payload inert — a smuggled header
    // needs the CRLF, not the words.
    assert.equal(res.headers.get("injected-header"), null, "the payload became a real header");
    assert.doesNotMatch(res.headers.get("www-authenticate"), /[\r\n]/,
      "no line break may survive into a header value");
    assert.match(res.headers.get("www-authenticate"), /^Bearer error="invalid_token"/);
    await assertAlive(stack.srv, "kid with CRLF");
  } finally { stack.stop(); }
});

test("a kid carrying quotes and backslashes leaves the challenge parseable", async () => {
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, mint({ kid: 'a"b\\c"', ...claims(stack.as) }));
    assert.equal(r.status, 401);
    // Exactly the quotes RFC 6750 puts there: error=, error_description=,
    // resource_metadata=. An unescaped quote from the kid would add more and
    // truncate the challenge where a client stops parsing.
    assert.equal((r.wwwAuth.match(/"/g) ?? []).length, 6,
      `challenge has unbalanced quoting: ${r.wwwAuth}`);
    assert.match(r.wwwAuth, /resource_metadata="https:\/\/mcp\.octen\.example\/\.well-known\/oauth-protected-resource\/mcp"$/);
    await assertAlive(stack.srv, "kid with quotes");
  } finally { stack.stop(); }
});

test("an oversized kid is truncated rather than echoed into the header", async () => {
  const stack = await startStack();
  try {
    // 2KB: large enough that echoing it would bloat every challenge, small
    // enough to get past Node's own request-header ceiling and actually reach
    // the sanitiser. Without truncation the response header mirrors whatever
    // the attacker sent, on a path that needs no credential.
    const r = await bearerCall(stack.srv.port, mint({ kid: "A".repeat(2_000), ...claims(stack.as) }));
    assert.equal(r.status, 401);
    assert.ok(r.wwwAuth.length < 500, `challenge grew to ${r.wwwAuth.length} bytes from a hostile kid`);

    // Past Node's ceiling the request never reaches our code at all — 431
    // rather than a crash, which is the outcome that matters here.
    const huge = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${mint({ kid: "A".repeat(40_000), ...claims(stack.as) })}`,
      },
      body: "{}",
    }).then((r) => r.status, () => "refused");
    assert.ok(huge === 431 || huge === "refused", `unexpected answer to a 40KB header: ${huge}`);
    await assertAlive(stack.srv, "oversized kid");
  } finally { stack.stop(); }
});

test("hostile kids do not poison later legitimate calls", async () => {
  const stack = await startStack();
  try {
    for (const kid of ["\r\n\r\n", '"', "\u0000\u0007", " ", "../../etc/passwd", "🙂".repeat(100)]) {
      const r = await bearerCall(stack.srv.port, mint({ kid, ...claims(stack.as) }));
      assert.equal(r.status, 401, `kid ${JSON.stringify(kid).slice(0, 40)} should be a clean 401`);
    }
    // The point of the loop: the process survived all of it AND still works.
    const ok = await bearerCall(stack.srv.port, mint(claims(stack.as)), { id: 99 });
    assert.equal(ok.status, 200, "a valid token must still work after the hostile ones");
    await assertAlive(stack.srv, "a burst of hostile kids");
  } finally { stack.stop(); }
});

// ---- Amplification against our own authorization server ----------------------

test("unknown kids cannot be used to amplify requests against the JWKS endpoint", async () => {
  const stack = await startStack();
  try {
    await bearerCall(stack.srv.port, mint(claims(stack.as))); // prime
    const before = stack.as.hits.jwks;
    for (let i = 0; i < 10; i++) {
      const r = await bearerCall(stack.srv.port, mint({ kid: `made-up-${i}`, ...claims(stack.as) }));
      assert.equal(r.status, 401);
    }
    // Measured at 10 extra fetches before the cooldown existed — one per
    // unauthenticated request, straight through to our own AS.
    assert.ok(stack.as.hits.jwks - before <= 1,
      `10 unauthenticated requests caused ${stack.as.hits.jwks - before} JWKS fetches`);
    await assertAlive(stack.srv, "unknown-kid burst");
  } finally { stack.stop(); }
});

test("a concurrent burst of unknown kids collapses into one JWKS fetch", async () => {
  // Cooldown at 0 so the rate limiter cannot be what passes this test — the
  // in-flight coalescing has to carry it alone. The AS is also made slow on
  // purpose: against a localhost JWKS answering in ~2ms the twelve requests
  // never actually overlap, so they each start their own fetch and the test
  // passes or fails on scheduling luck rather than on the behaviour.
  const stack = await startStack({
    as: { jwksDelayMs: 300 },
    env: { OCTEN_JWKS_REFETCH_COOLDOWN_MS: "0" },
  });
  try {
    await bearerCall(stack.srv.port, mint(claims(stack.as))); // prime
    const before = stack.as.hits.jwks;
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      bearerCall(stack.srv.port, mint({ kid: `concurrent-${i}`, ...claims(stack.as) }), { id: 100 + i })));
    assert.equal(stack.as.hits.jwks - before, 1,
      `12 simultaneous misses caused ${stack.as.hits.jwks - before} JWKS fetches`);
    await assertAlive(stack.srv, "concurrent unknown-kid burst");
  } finally { stack.stop(); }
});

// ---- Signature and algorithm attacks ----------------------------------------

test("alg=none and HS256 confusion are rejected without consulting the AS", async () => {
  const stack = await startStack();
  try {
    await bearerCall(stack.srv.port, mint(claims(stack.as))); // prime, so a fetch below is visible
    const before = stack.as.hits.jwks + stack.as.hits.resolve;
    for (const alg of ["none", "HS256", "RS512", ""]) {
      const r = await bearerCall(stack.srv.port, mint({ alg, sig: "", ...claims(stack.as) }));
      assert.notEqual(r.status, 503, `alg=${alg} must not be treated as a backend problem`);
      assert.notEqual(stack.up, undefined);
    }
    assert.equal(stack.as.hits.jwks + stack.as.hits.resolve, before,
      "a token pinned to an unsupported algorithm must not reach any AS endpoint");
    await assertAlive(stack.srv, "algorithm confusion attempts");
  } finally { stack.stop(); }
});

test("anything token-shaped is judged as a token, not retried as an API key", async () => {
  // The credential forms share one header, so something has to decide which
  // path a value takes. Deciding on "can we verify it" put every JWT this
  // server cannot verify into the API key path: measured, `alg: none`, an
  // HS256 token and one missing `kid` were each forwarded verbatim to the
  // upstream as a key and answered 200 with a tool-level "Invalid API Key".
  //
  // Two failures in one. A client holding a bearer token needs 401 + challenge
  // to know it must re-authorize — a tool error reads as a backend fault to
  // retry, so it never does. And a whole bearer token, possibly minted for a
  // different audience, ends up in our gateway's logs as if it were a key.
  const stack = await startStack();
  try {
    const now = Math.floor(Date.now() / 1000);
    const tokenShaped = {
      "forged signature": mint({ ...claims(stack.as), sig: b64url(Buffer.alloc(256, 9)) }),
      "expired": mint({ ...claims(stack.as), exp: now - 7200 }),
      // Built by hand: passing `kid: undefined` to mint() just triggers its
      // default parameter, which silently puts the kid back.
      "no kid in header": (() => {
        const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const pl = b64url(JSON.stringify({ ...claims(stack.as), exp: now + 3600 }));
        return `${h}.${pl}.${b64url(cryptoSign("sha256", Buffer.from(`${h}.${pl}`), privateKey))}`;
      })(),
      "alg=HS256": `${b64url(JSON.stringify({ alg: "HS256", kid: KID }))}.${b64url(JSON.stringify(claims(stack.as)))}.AAAA`,
      "alg=none": `${b64url(JSON.stringify({ alg: "none", kid: KID }))}.${b64url(JSON.stringify(claims(stack.as)))}.`,
    };
    for (const [label, token] of Object.entries(tokenShaped)) {
      const before = stack.up.seenKeys.length;
      const r = await bearerCall(stack.srv.port, token);
      assert.equal(r.status, 401, `${label} was not judged as a token`);
      assert.match(r.wwwAuth ?? "", /^Bearer /, `${label} carried no challenge to act on`);
      assert.equal(stack.up.seenKeys.length, before,
        `${label} was forwarded upstream as an API key`);
    }

    // The other side of the line: a value that is not token-shaped stays a
    // key, and a wrong key still earns the tool-level "check your key" error.
    const r = await bearerCall(stack.srv.port, "sk-octen-not-a-jwt-at-all");
    assert.equal(r.status, 200, "a bare key must not be answered with an OAuth challenge");
    assert.deepEqual(stack.up.seenKeys, ["sk-octen-not-a-jwt-at-all"]);
    await assertAlive(stack.srv, "credential routing");
  } finally { stack.stop(); }
});

test("a token with a valid header but a forged signature never reaches resolve-key", async () => {
  const stack = await startStack();
  try {
    const before = stack.as.hits.resolve;
    const r = await bearerCall(stack.srv.port, mint({ sig: b64url(Buffer.alloc(256, 7)), ...claims(stack.as) }));
    assert.equal(r.status, 401);
    assert.equal(stack.as.hits.resolve, before,
      "signature verification must gate the grant exchange, not follow it");
    await assertAlive(stack.srv, "forged signature");
  } finally { stack.stop(); }
});

// ---- Network faults, by stage ------------------------------------------------

test("JWKS endpoint answering 500 is a 503, not a 401", async () => {
  const stack = await startStack({ as: { jwks: "http500" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503, "the token may be perfectly valid — a 401 would log the user out over our outage");
    await assertAlive(stack.srv, "JWKS 500");
  } finally { stack.stop(); }
});

test("JWKS endpoint returning non-JSON is a 503", async () => {
  const stack = await startStack({ as: { jwks: "garbage" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503);
    await assertAlive(stack.srv, "JWKS garbage body");
  } finally { stack.stop(); }
});

test("JWKS connection dying mid-body is a 503, not a crash", async () => {
  const stack = await startStack({ as: { jwks: "reset" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503);
    await assertAlive(stack.srv, "JWKS reset mid-body");
  } finally { stack.stop(); }
});

test("a JWKS endpoint that never answers is bounded, not a hung request", async () => {
  const stack = await startStack({ as: { jwks: "hang" } });
  try {
    const started = Date.now();
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)), { timeoutMs: 15000 });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - started < 12_000,
      "a dead AS must fail fast; an unbounded wait is how one dependency takes every worker with it");
    await assertAlive(stack.srv, "JWKS hang");
  } finally { stack.stop(); }
});

test("resolve-key dying mid-body is a 503, and the bad answer is not cached", async () => {
  const stack = await startStack({ as: { resolve: "reset" } });
  try {
    const r1 = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r1.status, 503);
    const after = stack.as.hits.resolve;
    const r2 = await bearerCall(stack.srv.port, mint(claims(stack.as)), { id: 3 });
    assert.equal(r2.status, 503);
    assert.ok(stack.as.hits.resolve > after,
      "a failed resolve must be retried, not cached — caching it would extend one blip into a 60s outage");
    await assertAlive(stack.srv, "resolve-key reset");
  } finally { stack.stop(); }
});

test("a resolve-key endpoint that never answers is bounded", async () => {
  const stack = await startStack({ as: { resolve: "hang" } });
  try {
    const started = Date.now();
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)), { timeoutMs: 15000 });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - started < 10_000, "resolve-key sits on the hot path; its timeout must be tight");
    await assertAlive(stack.srv, "resolve-key hang");
  } finally { stack.stop(); }
});

test("the upstream API dying mid-body after a valid token is a tool error, not a 5xx or a crash", async () => {
  const stack = await startStack({ upstream: "reset" });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    // Authorization succeeded, so this is a tool-level failure: the transport
    // must stay 200 and the error travel inside the result, or clients read it
    // as an auth problem and re-authorize into the same wall.
    assert.equal(r.status, 200);
    assert.equal(r.msg.result.isError, true);
    const text = r.msg.result.content[0].text;
    // The named cause is the whole point of the shared HTTP layer: bare
    // `fetch failed` / `code=UNKNOWN` is what made these tickets undiagnosable.
    assert.match(text, /code=(UND_ERR_SOCKET|ECONNRESET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH)|connection lost while reading the response body/,
      `the failure must name a cause, got: ${text}`);
    assert.doesNotMatch(text, /code=UNKNOWN|^Network error calling Octen Search: $/);
    await assertAlive(stack.srv, "upstream reset mid-body");
  } finally { stack.stop(); }
});

test("an upstream that answers 200 with an HTML error page is reported as non-JSON", async () => {
  const stack = await startStack({ upstream: "garbage" });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 200);
    assert.equal(r.msg.result.isError, true);
    // The gateway-returns-HTML case: a JSON parse error here used to surface as
    // an unexplained failure, which reads as our bug rather than the edge's.
    assert.match(r.msg.result.content[0].text, /non-JSON|HTML/i);
    await assertAlive(stack.srv, "upstream HTML body");
  } finally { stack.stop(); }
});

// ---- Malformed requests ------------------------------------------------------

test("malformed and hostile request bodies are answered, never fatal", async () => {
  const stack = await startStack();
  try {
    const bodies = [
      "not json at all",
      "",
      "[]",
      "null",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } }), // no arguments
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "../../admin" }),
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${"[".repeat(2000)}${"]".repeat(2000)}}`,
    ];
    for (const body of bodies) {
      const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body,
        signal: AbortSignal.timeout(10000),
      });
      assert.ok(res.status < 600, "some HTTP answer is required");
      await res.text();
    }
    await assertAlive(stack.srv, "malformed bodies");
  } finally { stack.stop(); }
});

test("a chunked body cannot slip past the size cap by declaring no length", async () => {
  // The cap used to read Content-Length, which a chunked request simply does
  // not send — so it applied only to clients that volunteered their size.
  // Measured against the unfixed build: 75 MB accepted against a 1 MiB cap,
  // resident memory 88 MB → 246 MB, on an endpoint that needs no credential
  // and a container limited to 512 MiB.
  const stack = await startStack({ env: { OCTEN_MCP_MAX_BODY: "65536", OCTEN_MCP_LOG: "json" } });
  try {
    const chunk = "x".repeat(16 * 1024);
    const { status, sent, destroyed, sawReset } = await new Promise((resolve, reject) => {
      const sock = net.connect(stack.srv.port, "127.0.0.1");
      let resp = "", written = 0, settled = false, status = NaN, sawReset = false;
      // The status line is read as soon as it arrives, but the verdict waits
      // for `close` — the two facts under test are "413" and "the server hung
      // up", and the second one is only observable once the peer's FIN lands.
      // Reading `sock.destroyed` at the instant the response arrives reports
      // false against a server that is closing correctly; an earlier version
      // of this test failed exactly that way.
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ status, sent: written, destroyed: sock.destroyed, sawReset });
      };
      sock.on("data", (d) => {
        resp += d;
        const m = resp.match(/^HTTP\/1\.1 (\d+)/);
        if (m && Number.isNaN(status)) {
          status = Number(m[1]);
          // Bounded: if the server answers but leaves the socket open, that is
          // the defect this asserts against, and it must not hang the suite.
          setTimeout(finish, 1500);
        }
      });
      // EPIPE/ECONNRESET here is the fix working — the server answered and hung
      // up while we were still writing. Only an unexpected error fails.
      sock.on("error", (e) => {
        // A reset is the failure mode under test, not an incidental error: the
        // server must drain the rest of the body and close gracefully, because
        // resetting discards the 413 that was already written. Recorded rather
        // than thrown so the assertion names it.
        if (e.code === "ECONNRESET") { sawReset = true; return; }
        if (e.code === "EPIPE") return;
        reject(e);
      });
      sock.on("close", finish);
      sock.on("connect", async () => {
        // Credential present on purpose: without one the OAuth challenge
        // answers first and the body cap is never exercised.
        sock.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" +
          "x-api-key: bare-key\r\n" +
          "Accept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
        // Stops once the server answers, which is what any real client does:
        // it reads its socket. A client that instead floods without ever
        // reading may miss the 413 no matter what the server does — the drain
        // budget is finite, and closing while the peer is still sending resets
        // the connection, which discards the response. That case is covered
        // below by what it can actually promise: the server stays healthy.
        // Just past the cap, not a flood. Writing megabytes from the test's
        // own event loop starves its socket reads, and the test then fails for
        // its own reasons rather than the server's — this spent several runs
        // measuring that. The flooding case is covered separately below, by
        // the only thing it can promise: the server survives it.
        for (let i = 0; i < 24 && !sock.destroyed && resp === ""; i++) {
          sock.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
          written += chunk.length;
          if (i % 5 === 0) await new Promise((r) => setImmediate(r));
        }
        // Terminate the request properly. Without this the server never sees
        // `end`, falls back to its drain cutoff, and closes with a reset — and
        // a reset drops whatever the client has not read yet, which under a
        // loaded event loop is the response itself. A real client finishes its
        // request; a test that does not was measuring its own impatience.
        if (!sock.destroyed) sock.write("0\r\n\r\n");
        setTimeout(finish, 2500);
      });
    });
    assert.equal(status, 413, `chunked body was not capped (sent ${sent} bytes)`);
    assert.ok(destroyed, "the connection must not be left open after a 413");
    // Deterministic counterpart to the reset check below: whether the client
    // wins the race to read the 413 before a reset is up to the kernel, but
    // whether the server drained at all is not.
    // Either drain outcome counts: the client's chunked terminator often
    // cannot be delivered at all, because `Connection: close` makes Node
    // half-close as soon as the 413 goes out — so the drain usually ends at
    // its cutoff rather than at `end`. What must not happen is no drain.
    // Waited for, not sampled: the drain finishes once the peer stops sending,
    // which is strictly after the 413 this test already has in hand. Reading
    // stderr at that instant asks for a line the server has no reason to have
    // written yet — green locally, red on every CI runner.
    const drainLog = await waitForStderr(stack.srv, /"event":"body_drain(ed|_cutoff)"/);
    assert.match(drainLog, /"event":"body_drain(ed|_cutoff)"/,
      `the server never drained the rejected body:\n${drainLog}`);
    assert.equal(sawReset, false,
      "the connection was reset — a reset discards the 413 that was already written, " +
      "which is how an oversized request turns back into an unexplained failure");
    // And the server is unharmed: still serving, still correct.
    const after = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "x-api-key": "bare-key",   // OAuth is on here; an anonymous probe is a 401 by design
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(after.status, 200);
    await after.text();
    await assertAlive(stack.srv, "oversized chunked body");

    // The flooder: writes without ever reading, and is abandoned. Nothing can
    // promise it a 413, but it must not cost the server anything either.
    await new Promise((resolve) => {
      const flood = net.connect(stack.srv.port, "127.0.0.1");
      flood.on("error", () => {});
      flood.on("connect", async () => {
        flood.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" +
          "x-api-key: bare-key\r\nAccept: application/json, text/event-stream\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n");
        for (let i = 0; i < 600 && !flood.destroyed; i++) {
          flood.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
          if (i % 20 === 0) await new Promise((r) => setImmediate(r));
        }
        flood.destroy();
        resolve();
      });
    });
    const healthy = await fetch(`http://127.0.0.1:${stack.srv.port}/healthz`);
    assert.equal(healthy.status, 200, "a flooding client took the server with it");
    await healthy.text();
    await assertAlive(stack.srv, "abandoned flood");
  } finally { stack.stop(); }
});

test("an unparseable body is a JSON-RPC parse error that quotes the parser", async () => {
  const stack = await startStack();
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "x-api-key": "bare-key",   // else the OAuth challenge answers before the parser
      },
      body: "{ definitely not json",
    });
    const body = await res.json();
    assert.equal(body.error.code, -32700, "JSON-RPC reserves -32700 for parse errors");
    assertDiagnostic(body.error.message, /JSON/);
    await assertAlive(stack.srv, "unparseable body");
  } finally { stack.stop(); }
});

test("a client that disconnects mid-request does not leak the drain counter", async () => {
  const stack = await startStack({ as: { resolve: "hang" } });
  try {
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
        signal: ac.signal,
      }).catch(() => {});
      setTimeout(() => ac.abort(), 20);
      await p;
    }
    // If aborted requests left inFlight above zero, SIGTERM would sit through
    // the whole drain budget and be SIGKILLed instead of exiting cleanly.
    stack.srv.child.kill("SIGTERM");
    const code = await Promise.race([
      stack.srv.exited,
      new Promise((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    assert.equal(code, 0, "drain did not complete after aborted requests — in-flight accounting leaked");
  } finally { stack.up.close(); stack.as.close(); }
});

test("many ordinary bodies cannot exhaust memory the way one huge one cannot", async () => {
  // The per-request cap and this budget answer different attacks. With the
  // per-request cap at 6 MiB and no aggregate, forty concurrent 5 MB bodies
  // measured 772 MB resident against a 768 MiB container — an OOM reachable
  // by anyone holding a key, with no single request breaking a rule.
  const stack = await startStack({ env: { OCTEN_MCP_MAX_INFLIGHT_BODY: "2097152", OCTEN_MCP_LOG: "json" } });
  try {
    // Padded through `image_data` rather than a stray top-level field: this is
    // the payload the budget exists for, and it is a *valid* call, so the
    // recovery leg below can actually succeed. An earlier version padded a
    // field the SDK rejects, so every request 400'd — the 503 assertion still
    // passed, while the "budget was released" leg could never have.
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "image_search", arguments: { image_data: "y".repeat(900 * 1024) } },
    });
    const codes = {};
    const rs = await Promise.allSettled(Array.from({ length: 12 }, () =>
      fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
        body, signal: AbortSignal.timeout(20000),
      }).then((r) => r.status)));
    for (const r of rs) { const k = r.status === "fulfilled" ? r.value : "err"; codes[k] = (codes[k] ?? 0) + 1; }

    assert.ok((codes[503] ?? 0) > 0,
      `no request was shed under a 2 MiB budget with 12 concurrent ~0.9 MiB bodies: ${JSON.stringify(codes)}`);
    const budgetLog = await waitForStderr(stack.srv, /"event":"body_budget_exceeded"/);
    assert.match(budgetLog, /"event":"body_budget_exceeded"/,
      `no budget-exceeded event was logged:\n${budgetLog}`);

    // Shedding, not failing: the refusal must be retryable and say so, because
    // the caller has nothing to fix.
    const shed = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body,
    }).then(async (r) => ({ status: r.status, retry: r.headers.get("retry-after"), text: await r.text() }))
      .catch(() => null);
    if (shed?.status === 503) {
      assert.equal(shed.retry, "1");
      assert.match(shed.text, /at capacity/);
      assert.match(shed.text, /OCTEN_MCP_MAX_INFLIGHT_BODY/, "name the knob that raises it");
    }

    // And the budget is released, not leaked. The follow-up has to be the same
    // size as the burst: a small one fits in whatever the leak left over, so
    // it passes either way and proves nothing.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body, signal: AbortSignal.timeout(20000),
    });
    await after.text();
    assert.equal(after.status, 200,
      "a body the same size as the burst was refused after it drained — the budget leaked");
    await assertAlive(stack.srv, "in-flight body budget");
  } finally { stack.stop(); }
});

// ---- Configuration that must fail loudly, at startup -------------------------

/** Spawn the server directly; resolve { code, stderr } once it exits. */
function spawnServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", HTTPS_PROXY: "", https_proxy: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, stderr: err }));
    setTimeout(() => { child.kill(); resolve({ code: "still-running", stderr: err }); }, 4000);
  });
}

test("a malformed resource URL stops the process at startup, not at first use", async () => {
  for (const bad of ["mcp.octen.ai/mcp", "://nope", "ftp://mcp.octen.ai/mcp", "  "]) {
    const { code, stderr } = await spawnServer({
      OCTEN_OAUTH_AUTHORIZATION_SERVER: "https://auth.octen.example",
      OCTEN_MCP_RESOURCE: bad,
    });
    if (bad.trim() === "") {
      // Blank simply leaves the OAuth surface off — that is a valid self-hosted
      // configuration, not an error.
      assert.equal(code, "still-running", `blank resource should start with OAuth disabled\n${stderr}`);
      continue;
    }
    assert.equal(code, 1,
      `${JSON.stringify(bad)} started anyway — it would pass every health probe and die on the first ?login\n${stderr}`);
    assert.match(stderr, /OCTEN_MCP_RESOURCE/, "the log line must name the variable to fix");
  }
});

test("a trailing slash on the authorization server stops at startup", async () => {
  // Measured before this guard: the process started, every health probe
  // passed, and then refused 100% of tokens — the JWKS URL became
  // `…//api/oauth/jwks` and `iss` never matched, because no authorization
  // server emits its issuer with a trailing slash. The rejection message did
  // print both strings, but they differ by the one character nobody sees.
  const { code, stderr } = await spawnServer({
    OCTEN_OAUTH_AUTHORIZATION_SERVER: "https://auth.octen.example/",
    OCTEN_MCP_RESOURCE: RESOURCE,
  });
  assert.equal(code, 1, `started anyway, and would refuse every token:\n${stderr}`);
  assert.match(stderr, /OCTEN_OAUTH_AUTHORIZATION_SERVER/);
  assert.match(stderr, /trailing slash|must not end with/);
});

test("a malformed authorization-server URL also stops at startup", async () => {
  const { code, stderr } = await spawnServer({
    OCTEN_OAUTH_AUTHORIZATION_SERVER: "auth.octen.ai",
    OCTEN_MCP_RESOURCE: RESOURCE,
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /OCTEN_OAUTH_AUTHORIZATION_SERVER/);
});

// ---- Limits that must not be disableable by a typo ---------------------------

test("a garbage body-size limit falls back instead of removing the limit", async () => {
  const stack = await startStack({ env: { OCTEN_MCP_MAX_BODY: "one megabyte please" } });
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      // Must exceed the *fallback*, which is 6 MiB — that is the value under
      // test. A payload sized against the old 1 MiB default would sail through
      // and the assertion would silently stop checking anything.
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(7 * 1024 * 1024) }),
      signal: AbortSignal.timeout(15000),
    });
    // NaN would have made every `>` comparison false and silently uncapped it.
    assert.equal(res.status, 413, "the cap must survive an unparseable override");
    // And it must fall back to *the* default, not merely to some cap: asserting
    // only "413" passes against any value, so this stopped checking the
    // fallback the moment the default changed.
    assert.match(await res.text(), /exceeds 6291456 bytes/,
      "the fallback must be the documented default, 6 MiB");
    await assertAlive(stack.srv, "garbage OCTEN_MCP_MAX_BODY");
  } finally { stack.stop(); }
});

test("the drain deadline is enforced when work is still in flight", async () => {
  // With nothing in flight the loop exits on its first tick, so a broken
  // deadline is invisible — an earlier version of this test killed an idle
  // server and passed against a NaN budget. The hung upstream is what forces
  // the deadline to be the thing that ends the drain.
  const stack = await startStack({ as: { resolve: "hang" }, env: { OCTEN_DRAIN_TIMEOUT_MS: "600" } });
  try {
    const inflight = bearerCall(stack.srv.port, mint(claims(stack.as)), { timeoutMs: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const started = Date.now();
    stack.srv.child.kill("SIGTERM");
    const code = await Promise.race([
      stack.srv.exited,
      new Promise((r) => setTimeout(() => r("hung"), 8000)),
    ]);
    assert.equal(code, 1, "a drain that hits its deadline must exit non-zero, so the event is visible");
    assert.ok(Date.now() - started < 5000, "the deadline was not honoured");
    await inflight;
  } finally { stack.up.close(); stack.as.close(); }
});

test("a garbage drain timeout falls back to the default budget, not to NaN", async () => {
  // NaN makes `Date.now() > deadline` permanently false, so a drain with work
  // in flight never ends and the pod is SIGKILLed at the end of its grace
  // period instead of exiting. The effective budget is asserted from the log
  // because it cannot be observed any other way — and observing it is the
  // point: it must stay below terminationGracePeriodSeconds.
  const stack = await startStack({
    env: { OCTEN_DRAIN_TIMEOUT_MS: "soon", OCTEN_MCP_LOG: "json" },
  });
  try {
    stack.srv.child.kill("SIGTERM");
    const code = await Promise.race([
      stack.srv.exited,
      new Promise((r) => setTimeout(() => r("hung"), 8000)),
    ]);
    assert.equal(code, 0);
    const line = stack.srv.stderr().split("\n").find((l) => l.includes('"drain_start"'));
    assert.ok(line, `no drain_start line in:\n${stack.srv.stderr()}`);
    assert.equal(JSON.parse(line).budget_ms, 310_000,
      `unparseable budget was not replaced by the default: ${line}`);
  } finally { stack.up.close(); stack.as.close(); }
});




// ---- Arguments are checked against the schema we publish ---------------------
//
// The SDK does not enforce `inputSchema`. Measured before this: `count: 999999`
// against `maximum: 100`, a 5000-character `query` against `maxLength: 500`,
// and a 5000-entry array against `maxItems: 1000` were each relayed to the
// upstream API intact — every published constraint was advertising.

test("every published schema uses only vocabulary the validator enforces", async () => {
  // The guard that keeps the rest of this honest. A keyword the validator does
  // not implement is silently ignored, which turns a published constraint back
  // into advertising — and the schema author would have no way to notice. This
  // reads the schemas as clients receive them, not as the source declares them.
  const { unsupportedKeywords } = await import("../dist/validate.js");
  const stack = await startStack();
  try {
    const r = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" });
    const tools = JSON.parse(r.text.split("\n").filter((l) => l.startsWith("data: ")).pop().slice(6)).result.tools;
    assert.ok(tools.length >= 6);
    for (const t of tools) {
      assert.deepEqual(unsupportedKeywords(t.inputSchema), [],
        `${t.name} declares a constraint the validator would ignore`);
    }
  } finally { stack.stop(); }
});

test("out-of-contract arguments are refused before anything is relayed upstream", async () => {
  const stack = await startStack();
  try {
    const cases = [
      [{ query: "q", count: 999999 }, /at most 100, got 999999/],
      [{ query: "q", count: -5 }, /at least 1, got -5/],
      [{ query: "q", count: "many" }, /Expected integer for `count`/],
      [{ query: "q", count: 2.5 }, /Expected integer for `count`, got 2\.5/],
      [{ query: "x".repeat(5000) }, /at most 500 characters, got 5000/],
      [{ query: "q", topic: "gossip" }, /Allowed: "general", "news"/],
      [{ query: "q", include_domains: Array.from({ length: 5000 }, (_, i) => `d${i}`) }, /at most 1200 item\(s\), got 5000/],
      [{ query: "q", include_domains: ["x".repeat(99)] }, /include_domains\[0\]` must be at most 60/],
      [{ query: "q", highlight: { enable: true, max_tokens: 999999 } }, /highlight\.max_tokens` must be at most 20000/],
      [{ query: "q", highlight: { enable: "yes" } }, /Expected boolean for `highlight\.enable`/],
      // The properties list is the published interface; anything outside it
      // would otherwise be relayed to the upstream API unexamined.
      [{ query: "q", evil: 1 }, /Unknown parameter `evil`/],
      // Names that live on Object.prototype. A membership test written with
      // `in` accepts every one of them as a declared parameter of any schema —
      // measured, three sailed through and were relayed upstream.
      [{ query: "q", toString: { x: 1 } }, /Unknown parameter `toString`/],
      [{ query: "q", valueOf: { x: 1 } }, /Unknown parameter `valueOf`/],
      [{ query: "q", hasOwnProperty: { x: 1 } }, /Unknown parameter `hasOwnProperty`/],
      [{ count: 5 }, /Missing required parameter `query`/],
    ];
    for (const [args, expected] of cases) {
      const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: args } }),
      });
      const text = await res.text();
      const msg = JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).pop().slice(6)).result.content[0].text;
      assert.match(msg, expected, `wrong or missing rejection for ${JSON.stringify(args).slice(0, 60)}`);
    }
    // The point of doing this before dispatch: none of it reached the API.
    assert.equal(stack.up.seenKeys.length, 0,
      "an out-of-contract call was relayed upstream before being judged");
    await assertAlive(stack.srv, "schema rejections");
  } finally { stack.stop(); }
});

test("arguments at every declared boundary still pass", async () => {
  // The reverse case, and the one that matters most: a validator that rejects
  // everything would pass every test above. These are the exact edges the
  // schemas publish, so each is legal by definition and must go through.
  const stack = await startStack();
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "search",
          arguments: {
            query: "x".repeat(500), count: 100, topic: "news",
            include_domains: ["a.com"], highlight: { enable: true, max_tokens: 20000 },
            full_content: { enable: false, max_tokens: 100000 }, language: ["zh", "ja"],
            time_basis: "published", format: "markdown", safesearch: "off",
            include_images: true, timeout: 60,
          },
        },
      }),
    });
    const text = await res.text();
    const result = JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).pop().slice(6)).result;
    assert.notEqual(result.isError, true, `boundary values were rejected: ${result.content?.[0]?.text}`);
    assert.equal(stack.up.seenKeys.length, 1, "a legal call did not reach the upstream");
  } finally { stack.stop(); }
});

test("each tool is validated against its own schema, not another's", async () => {
  const stack = await startStack();
  try {
    // `news_search` publishes no `topic` — it is fixed to news — so passing one
    // is out of contract even though `search` accepts it.
    const news = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "news_search", arguments: { query: "q", topic: "general" } } }),
    });
    const msg = JSON.parse((await news.text()).split("\n").filter((l) => l.startsWith("data: ")).pop().slice(6))
      .result.content[0].text;
    assert.match(msg, /Unknown parameter `topic`/);

    // And `extract` has a different required parameter entirely.
    const extract = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "extract", arguments: { query: "q" } } }),
    });
    const emsg = JSON.parse((await extract.text()).split("\n").filter((l) => l.startsWith("data: ")).pop().slice(6))
      .result.content[0].text;
    assert.match(emsg, /Missing required parameter `urls`/);
    assert.equal(stack.up.seenKeys.length, 0);
  } finally { stack.stop(); }
});

// ---- URL-only clients, forced authorization, per-connection tool selection --
//
// Three affordances for clients that cannot do what a header-capable HTTP
// client can. Each has a reverse case: passing the happy path proves the
// feature exists, not that its guard works.

test("a key can travel in the query string, but a header always wins", async () => {
  // For clients that can only be handed a URL: Claude Desktop's mcpServers
  // config is a stdio mechanism with nowhere to put a header, and mcp-remote
  // takes `<url> [callback-port] [--debug]` with no header option.
  const stack = await startStack({ env: { OCTEN_MCP_LOG: "json" } });
  try {
    const r = await probe(stack.srv.port, "tools/list", {}, "?octenApiKey=QUERYKEY123");
    assert.equal(r.status, 200, "octenApiKey was not accepted as a credential");

    // octenApiKey is the only query spelling that counts as a credential, and
    // every plausible alternative has to keep failing. An extra accepted name
    // is an extra string on the public interface for a compatibility win
    // nobody asked for.
    //
    // tools/call rather than tools/list: without an authorization server
    // tools/list needs no credential at all (see the note at the top of
    // httpServer), so an assertion built on it would quietly stop testing
    // anything under that deployment shape. tools/call demands a credential in
    // both modes, so it is the method actually carrying this guard.
    for (const spelling of ["apiKey", "api_key", "key", "token", "octen_api_key"]) {
      const foreign = await probe(stack.srv.port, "tools/call",
        { name: "search", arguments: { query: "q" } }, `?${spelling}=QUERYKEY123`);
      assert.equal(foreign.status, 401,
        `?${spelling}= must not be accepted as a credential; octenApiKey is the only one`);
    }
    // Reverse case: a header-capable client must never be downgraded to the
    // query value, or two clients disagree about which key was billed.
    const both = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp?octenApiKey=FROM-QUERY`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "x-api-key": "FROM-HEADER",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "q" } } }),
    });
    assert.equal(both.status, 200);
    await both.text();
    assert.deepEqual(stack.up.seenKeys, ["FROM-HEADER"], "the query value overrode a header");

    // A key in a URL reaches proxy logs and browser history — none of which we
    // control. Ours we do.
    assert.doesNotMatch(stack.srv.stderr(), /QUERYKEY123|FROM-QUERY/,
      `a credential from the query string reached our own log:\n${stack.srv.stderr()}`);

    // A flat 8-character prefix is the whole credential for anything shorter
    // than that — measured, a 7-character key was logged in full — and a
    // hand-typed key in a URL is exactly where short values show up.
    const short = await probe(stack.srv.port, "tools/list", {}, "?octenApiKey=tinykey");
    assert.equal(short.status, 200);
    assert.doesNotMatch(stack.srv.stderr(), /tinykey/,
      `a short credential was logged in full:\n${stack.srv.stderr()}`);
    await assertAlive(stack.srv, "query credentials");
  } finally { stack.stop(); }
});

test("forced authorization challenges even a request that carries a key", async () => {
  // The one route from an already-configured API key to OAuth: with a key
  // present the ordinary rule never challenges, so there is no way to switch.
  const stack = await startStack();
  try {
    for (const [where, query, path] of [["/mcp/oauth", "", "/mcp/oauth"], ["?login", "?login", "/mcp"]]) {
      const res = await fetch(`http://127.0.0.1:${stack.srv.port}${path}${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "x-api-key": "a-perfectly-good-key",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = await res.text();
      assert.equal(res.status, 401, `${where} did not force the challenge`);
      assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
      // The message must not accuse a caller who did send a key of sending none.
      assert.doesNotMatch(body, /No credential on this request/);
      assert.match(body, /even when a key is supplied/);
    }
    // Reverse case: the ordinary endpoint must NOT challenge the same request,
    // or forcing would just be the old behaviour with extra steps.
    const plain = await probe(stack.srv.port, "tools/list", { "x-api-key": "a-perfectly-good-key" });
    assert.equal(plain.status, 200);
    await assertAlive(stack.srv, "forced authorization");
  } finally { stack.stop(); }
});

test("the other routes are untouched by the new path", async () => {
  const stack = await startStack();
  try {
    for (const path of ["/mcp", "/mcp/"]) {
      const res = await fetch(`http://127.0.0.1:${stack.srv.port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 200, `${path} regressed`);
      await res.text();
    }
    assert.equal((await fetch(`http://127.0.0.1:${stack.srv.port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${stack.srv.port}/.well-known/oauth-protected-resource`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${stack.srv.port}/.well-known/oauth-protected-resource/mcp`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${stack.srv.port}/mcp/oauth/extra`)).status, 404);
  } finally { stack.stop(); }
});

test("?tools narrows the roster, and the excluded tools really are gone", async () => {
  const stack = await startStack();
  try {
    const list = async (q) => {
      const r = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" }, q);
      assert.equal(r.status, 200, `tools/list failed for ${q || "(no filter)"}`);
      return [...r.text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    };
    assert.equal((await list("")).length, 6);
    assert.deepEqual(await list("?tools=search"), ["search"]);
    assert.deepEqual(await list("?tools=search,extract"), ["search", "extract"]);
    assert.deepEqual(await list("?tools=search,search"), ["search"], "duplicates must not advertise a tool twice");
    assert.equal((await list("?tools=")).length, 6, "an empty value means no selection, not no tools");

    // The reverse case that makes the feature real rather than decorative: a
    // client can call a tool it was never shown, so filtering the list alone
    // filters nothing.
    const call = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp?tools=search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "extract", arguments: { urls: ["http://x"] } } }),
    });
    const text = await call.text();
    assert.match(text, /"isError":true/, "an excluded tool was callable");
    assert.match(text, /not enabled for this connection/);
    assert.equal(stack.up.seenKeys.length, 0, "an excluded tool reached the upstream");
    await assertAlive(stack.srv, "tool selection");
  } finally { stack.stop(); }
});

test("an unknown or empty tool selection is refused, not silently narrowed", async () => {
  // Silently dropping a misspelled name produces a connection that looks
  // healthy and is missing a tool — and sends whoever debugs it to look at the
  // tool rather than at the spelling in their URL.
  const stack = await startStack();
  try {
    for (const q of ["?tools=serch", "?tools=search,nope", "?tools=,,,"]) {
      const r = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" }, q);
      assert.equal(r.status, 400, `${q} was accepted`);
      const body = JSON.parse(r.text);
      assert.equal(body.error.code, -32602, "invalid params is the JSON-RPC code for this");
      assert.match(body.error.message, /Available: search, news_search/,
        `the refusal must list the real names: ${body.error.message}`);
    }
    await assertAlive(stack.srv, "invalid tool selection");
  } finally { stack.stop(); }
});

test("a real tool the deployment does not serve is not called unknown", async () => {
  // Refused either way — but "Unknown tool name: image_search" is false when
  // the name is real and it is this deployment that does not serve it, and it
  // sends whoever reads the message hunting for a typo that is not there.
  const stack = await startStack({ env: { OCTEN_ENABLE_BETA_TOOLS: "false" } });
  try {
    const msg = async (q) => {
      const r = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" }, q);
      assert.equal(r.status, 400, `${q} should be refused`);
      return JSON.parse(r.text).error.message;
    };

    const disabled = await msg("?tools=image_search");
    assert.match(disabled, /not enabled on this deployment/);
    assert.match(disabled, /OCTEN_ENABLE_BETA_TOOLS/, "name the switch that is responsible");
    assert.doesNotMatch(disabled, /Unknown tool name/, "the name is real; saying otherwise misdirects");

    const typo = await msg("?tools=serch");
    assert.match(typo, /Unknown tool name: "serch"/);
    assert.doesNotMatch(typo, /not enabled/, "a typo is not a deployment setting");

    // Both kinds at once: each must be described as what it is.
    const mixed = await msg("?tools=serch,video_search");
    assert.match(mixed, /Unknown tool name: "serch"/);
    assert.match(mixed, /"video_search" is not enabled on this deployment/);

    // Whatever the reason, the reader is told what they can actually ask for,
    // and Beta tools are absent from that list on this deployment.
    for (const m of [disabled, typo, mixed]) {
      assert.match(m, /Available: search, news_search, broad_search, extract\./);
      assert.doesNotMatch(m, /Available:[^.]*image_search/);
    }
  } finally { stack.stop(); }
});

test("a selection cannot re-enable a Beta tool that the switch turned off", async () => {
  // Two independent switches. If a selection could reach past the Beta switch,
  // the switch would be advisory — and the tool would 403 at call time instead,
  // which is a much worse way to find out.
  const stack = await startStack({ env: { OCTEN_ENABLE_BETA_TOOLS: "false" } });
  try {
    const all = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" });
    assert.equal([...all.text.matchAll(/"name":"([a-z_]+)"/g)].length, 4, "Beta tools should be absent");

    const r = await probe(stack.srv.port, "tools/list", { "x-api-key": "k" }, "?tools=image_search");
    assert.equal(r.status, 400, "a disabled Beta tool must read as a name that does not exist");
    assert.doesNotMatch(JSON.parse(r.text).error.message, /image_search, video_search/,
      "the available list must not advertise tools this process will not serve");
  } finally { stack.stop(); }
});

// ---- Protocol surface: the shapes real clients and real pastes produce ------
//
// Each of these was probed against the built server rather than assumed. Two
// were defects and are fixed; the rest are pinned here because they are the
// contract a client depends on, and because a plausible "cleanup" could break
// any of them without a single existing test noticing.

test("a trailing slash on the endpoint is accepted, not 404", async () => {
  // The commonest paste artifact in a URL a human copies into a client config.
  // Answering 404 makes a working deployment look broken for a reason nobody
  // inspects — it was a 404 before this.
  const stack = await startStack();
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally { stack.stop(); }
});

test("a burst on one grant makes a single resolve-key call", async () => {
  // Measured before coalescing: eight simultaneous calls, eight resolve-key
  // requests. That burst is what an agent firing several tools at once right
  // after authorizing looks like — the dependency's worst moment is also its
  // most likely one. The JWKS path already coalesced; this one did not.
  const stack = await startStack();
  try {
    const token = mint(claims(stack.as, { grant_id: "burst" }));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => bearerCall(stack.srv.port, token, { id: 200 + i })));
    assert.ok(results.every((r) => r.status === 200), "a coalesced burst must still succeed for everyone");
    assert.equal(stack.as.hits.resolve, 1, `${stack.as.hits.resolve} resolve-key calls for one grant`);
  } finally { stack.stop(); }
});

test("an Accept header missing text/event-stream is refused with the reason", async () => {
  // A real trip-hazard: this 406 looks like an auth failure to anyone probing
  // by hand, so the message has to say what is actually missing.
  const stack = await startStack();
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": "k" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 406);
    const body = await res.text();
    assert.match(body, /text\/event-stream/);
    assert.doesNotMatch(body, /auth/i, "must not read as a credential problem");
  } finally { stack.stop(); }
});

test("credential precedence and spelling are fixed, not incidental", async () => {
  const stack = await startStack();
  try {
    // x-api-key wins when both are present. Either rule is defensible; an
    // undefined one means two clients disagree about which key was used.
    const both = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "x-api-key": "FROM-HEADER", Authorization: "Bearer FROM-AUTH",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "q" } } }),
    });
    assert.equal(both.status, 200);
    await both.text();
    assert.deepEqual(stack.up.seenKeys, ["FROM-HEADER"]);

    // Lowercase `bearer` is legal per RFC 7235 and some clients send it.
    const lower = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "bearer plainkey" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(lower.status, 200, "a lowercase scheme must not be read as no credential");
    await lower.text();

    // Whitespace is not a credential — it must reach the challenge, not the
    // upstream as a key made of spaces.
    const blank = await probe(stack.srv.port, "tools/list", { "x-api-key": "   " });
    assert.equal(blank.status, 401);
    assert.deepEqual(stack.up.seenKeys, ["FROM-HEADER"], "a blank key must never be forwarded");
  } finally { stack.stop(); }
});

test("non-POST methods and preflight answer without touching the MCP path", async () => {
  const stack = await startStack();
  try {
    const get = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, { headers: { "x-api-key": "k" } });
    assert.equal(get.status, 405, "stateless: there is no standalone SSE stream to GET");
    assert.equal(get.headers.get("allow"), "POST, OPTIONS");
    await get.text();

    const opts = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp`, { method: "OPTIONS" });
    assert.equal(opts.status, 204, "a failing preflight blocks every browser-based client");
    assert.match(opts.headers.get("access-control-allow-headers") ?? "", /x-api-key/);
  } finally { stack.stop(); }
});

test("the ?login entrypoint still works, for URLs already in circulation", async () => {
  // It is no longer required, but anyone told to paste `…/mcp?login` earlier
  // must not now get a different answer than the plain URL.
  const stack = await startStack();
  try {
    const r = await probe(stack.srv.port, "initialize", {}, "?login");
    assert.equal(r.status, 401);
    assert.match(r.wwwAuth ?? "", /resource_metadata=/);
  } finally { stack.stop(); }
});

test("a single-valued aud claim is accepted alongside the array form", async () => {
  // fosite emits an array, but the spec permits a bare string and a future AS
  // version could switch — silently rejecting every token would be the whole
  // service down, so this is pinned.
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, mint({ ...claims(stack.as), aud: RESOURCE }));
    assert.equal(r.status, 200);
  } finally { stack.stop(); }
});

test("a JWKS carrying no usable RSA key is a 503 that says so", async () => {
  const stack = await startStack({ as: { jwks: "no-rsa" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503, "unusable key material is our problem, not the token's");
    assertDiagnostic(r.msg.error.message, /no usable RSA keys/);
  } finally { stack.stop(); }
});

// ---- The OAuth trigger clients actually act on --------------------------------
//
// Confirmed against pre before this was fixed: with no credential, initialize,
// tools/list and tools/call all answered 200, and no response carried a
// `WWW-Authenticate`. A client therefore concludes the server needs no
// authorization, connects happily, lists tools, and only fails at the first
// real call — with a message pointing at manual API-key setup. It never offers
// to log in, because nothing ever told it there was anything to log into.

/** POST one JSON-RPC method with optional headers; return status + headers. */
async function probe(port, method, headers = {}, query = "") {
  const res = await fetch(`http://127.0.0.1:${port}/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: method === "tools/call"
        ? { name: "search", arguments: { query: "q" } }
        : { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    }),
  });
  const text = await res.text();
  return { status: res.status, wwwAuth: res.headers.get("www-authenticate"), text };
}

test("every uncredentialed method answers 401 with the challenge, initialize included", async () => {
  const stack = await startStack();
  try {
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      // Also without `?login`: gating the challenge on a query parameter made
      // the whole flow depend on the user pasting `…/mcp?login` instead of the
      // plain URL, which no client does on its own.
      const r = await probe(stack.srv.port, method);
      assert.equal(r.status, 401, `${method} answered ${r.status}; a client reads that as "no auth needed"`);
      assert.match(r.wwwAuth ?? "", /^Bearer /, `${method} carried no challenge`);
      assert.match(r.wwwAuth ?? "",
        /resource_metadata="https:\/\/mcp\.octen\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
      // Verdicts must be readable from the status line: a rejection carries no
      // `isError`, so a probe that greps for it reads a refusal as a success.
      assert.doesNotMatch(r.text, /isError/, `${method} mixed a tool-level error into a transport rejection`);
    }
    await assertAlive(stack.srv, "uncredentialed probes");
  } finally { stack.stop(); }
});

test("the advertised metadata URL resolves and names the authorization server", async () => {
  const stack = await startStack();
  try {
    const { wwwAuth } = await probe(stack.srv.port, "initialize");
    const url = wwwAuth.match(/resource_metadata="([^"]+)"/)[1];
    // Follow the client's next step for real, against this server.
    const doc = await fetch(`http://127.0.0.1:${stack.srv.port}${new URL(url).pathname}`);
    assert.equal(doc.status, 200, "the challenge pointed at a document this server does not serve");
    const prm = await doc.json();
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [stack.as.issuer]);
    assert.ok(prm.scopes_supported.includes("mcp:tools"));
  } finally { stack.stop(); }
});

test("a bare API key is never challenged — the two credential forms coexist", async () => {
  const stack = await startStack();
  try {
    for (const headers of [{ "x-api-key": "plain-key" }, { Authorization: "Bearer plain-key" }]) {
      const r = await probe(stack.srv.port, "initialize", headers);
      assert.equal(r.status, 200, `challenged a request that carried a credential: ${JSON.stringify(headers)}`);
      assert.equal(r.wwwAuth, null);
    }
    // And it reaches the upstream verbatim, not as something to be exchanged.
    const call = await probe(stack.srv.port, "tools/call", { "x-api-key": "plain-key" });
    assert.equal(call.status, 200);
    assert.deepEqual(stack.up.seenKeys, ["plain-key"],
      "a bare key must reach the upstream verbatim, not be exchanged for anything");
  } finally { stack.stop(); }
});

test("a deployment with no authorization server advertises nothing and keeps call-time enforcement", async () => {
  // Self-hosted, bare keys only: there is no AS to send anyone to, so a 401
  // challenge would be a dead end. The pre-existing behaviour must survive.
  const up = await startFaultyUpstream("ok");
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}` });
  try {
    const init = await probe(srv.port, "initialize");
    assert.equal(init.status, 200, "an OAuth-less deployment must still allow anonymous discovery");
    assert.equal(init.wwwAuth, null, "nothing may be advertised when there is no authorization server");

    const list = await probe(srv.port, "tools/list");
    assert.equal(list.status, 200);

    const call = await probe(srv.port, "tools/call");
    assert.equal(call.status, 200, "without an AS, a missing key stays a tool-level result");
    assert.match(call.text, /isError/);
    assert.match(call.text, /x-api-key/);

    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/.well-known/oauth-protected-resource`)).status, 404);
  } finally { srv.stop(); up.close(); }
});

test("the revocation window is configurable, and zero means resolve every time", async () => {
  // Measured on pre: a grant revoked at t=0 still worked at t=45s. That is the
  // cache TTL, and it is a trade worth being able to see and set rather than
  // discovering it from a stopwatch.
  const stack = await startStack({ env: { OCTEN_OAUTH_RESOLVE_CACHE_TTL_MS: "0" } });
  try {
    await bearerCall(stack.srv.port, mint(claims(stack.as)), { id: 2 });
    await bearerCall(stack.srv.port, mint(claims(stack.as)), { id: 3 });
    assert.equal(stack.as.hits.resolve, 2,
      "TTL 0 must consult the authorization server on every call");
  } finally { stack.stop(); }
});

// ---- The OAuth path must use the same tuned HTTP stack ------------------------

/**
 * Recording proxy. undici tunnels with CONNECT even for plain `http://`
 * origins, so this is a tunnel rather than a forwarder — and because the
 * tunnelled bytes are unencrypted HTTP, the request line inside can be read,
 * which is what makes the assertion specific about *which* endpoint went
 * through the proxy rather than merely that something did.
 */
function startProxy() {
  const seen = [];
  const sockets = new Set();
  const srv = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  srv.on("connect", (req, clientSocket, head) => {
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.on("data", (chunk) => {
        const m = chunk.toString("latin1").match(/^[A-Z]+ (\S+) HTTP\/1\.[01]/);
        if (m) seen.push(m[1]);
      });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    sockets.add(clientSocket).add(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((r) => srv.listen(0, () => r({
    port: srv.address().port, seen,
    close: () => { for (const s of sockets) s.destroy(); srv.close(); },
  })));
}

test("JWKS and resolve-key go through the configured proxy, like every other call", async () => {
  // The defect this pins: these two calls used undici's *global* dispatcher
  // rather than the module's configured one, so they ignored the proxy
  // environment entirely. Behind a corporate proxy that means OAuth cannot
  // work while every other request can — and nothing in the error would say
  // so. It is the same class of bug 0.4.0 fixed for the API calls, in the code
  // added after it.
  const proxy = await startProxy();
  const as = await startAs();
  const up = await startFaultyUpstream("ok");
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`,
    OCTEN_OAUTH_AUTHORIZATION_SERVER: as.issuer,
    OCTEN_MCP_RESOURCE: RESOURCE,
    OCTEN_OAUTH_RESOLVE_URL: `${as.issuer}/internal/oauth/resolve-key`,
    OCTEN_OAUTH_RESOLVE_TOKEN: "svc-secret",
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
  });
  try {
    const r = await bearerCall(srv.port, mint(claims(as)));
    assert.equal(r.status, 200, `call failed through the proxy: ${JSON.stringify(r.msg)}`);
    assert.ok(proxy.seen.some((u) => u.includes("/api/oauth/jwks")),
      `JWKS bypassed the proxy; the proxy only saw: ${JSON.stringify(proxy.seen)}`);
    assert.ok(proxy.seen.some((u) => u.includes("/internal/oauth/resolve-key")),
      `resolve-key bypassed the proxy; the proxy only saw: ${JSON.stringify(proxy.seen)}`);
  } finally { srv.stop(); up.close(); as.close(); proxy.close(); }
});

// ---- Every failure must name its cause ---------------------------------------
//
// A generic message is not a cosmetic problem. The 0.3.7 field report that
// started this whole line of work consisted of `fetch failed` repeated: the
// user could not tell a proxy from a DNS failure, and neither could we, so the
// exchange went several rounds before anyone learned anything. Every branch
// below used to answer with a sentence that fit any of a dozen causes.

/** Phrases that describe nothing. A message consisting only of these is a bug. */
const VAGUE = [
  /^Authorization backend temporarily unavailable/,
  /^Invalid or expired access token; re-authorize\.$/,
  /^Internal server error$/,
  /^Authentication required\.$/,
  /^not found$/,
  /fetch failed/,
  /code=UNKNOWN/,
];

function assertDiagnostic(message, mustMention) {
  for (const v of VAGUE) {
    assert.doesNotMatch(message, v, `message says nothing actionable: ${JSON.stringify(message)}`);
  }
  assert.match(message, mustMention, `message does not name the cause: ${JSON.stringify(message)}`);
}

test("an unreachable authorization server names the dependency and the transport code", async () => {
  // A port nothing listens on, so the failure is a real ECONNREFUSED rather
  // than a URL-validation error.
  const dead = await new Promise((r) => {
    const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const stack = await startStack({ env: { OCTEN_OAUTH_AUTHORIZATION_SERVER: `http://127.0.0.1:${dead}` } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as, { iss: `http://127.0.0.1:${dead}` })));
    assert.equal(r.status, 503);
    assertDiagnostic(r.msg.error.message, /JWKS/);
    assert.match(r.msg.error.message, /ECONNREFUSED|ECONNRESET|EHOSTUNREACH/,
      "the undici cause code is the part that distinguishes refused from filtered from unresolvable");
    // And it must say which way to fall: retry, not re-authorize.
    assert.match(r.msg.error.message, /retry/i);
  } finally { stack.stop(); }
});

test("each token rejection reason survives into the response body, not just the log", async () => {
  const stack = await startStack();
  try {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      // [claims, what the message must let the reader act on]
      [{ ...claims(stack.as), exp: now - 4000 }, /expired \d+s ago/],
      [{ ...claims(stack.as), aud: ["https://mcp.octen.example/mcp/"] }, /audience .*mcp\.octen\.example\/mcp\//],
      [{ ...claims(stack.as), iss: "https://evil.example" }, /issued by https:\/\/evil\.example/],
      [{ ...claims(stack.as), scp: ["other:scope"] }, /mcp:tools scope/],
      [{ ...claims(stack.as), grant_id: undefined }, /no grant_id/],
      [{ ...claims(stack.as), kid: "rotated-away" }, /kid=rotated-away/],
    ];
    for (const [c, expected] of cases) {
      const r = await bearerCall(stack.srv.port, mint(c));
      assert.equal(r.status, 401);
      assertDiagnostic(r.msg.error.message, expected);
      // The challenge carries it too, sanitised — that is what a client logs.
      assert.match(r.wwwAuth, /error_description="[^"]{20,}"/,
        `challenge lost the reason: ${r.wwwAuth}`);
    }
    await assertAlive(stack.srv, "token rejection reasons");
  } finally { stack.stop(); }
});

test("the audience mismatch message shows both values, because the difference is one character", async () => {
  const stack = await startStack();
  try {
    const r = await bearerCall(stack.srv.port, mint({ ...claims(stack.as), aud: [RESOURCE + "/"] }));
    // RFC 8707 binds byte-for-byte, so a trailing slash fails everything —
    // and is unfindable unless the two strings are printed next to each other.
    assert.match(r.msg.error.message, new RegExp(`${RESOURCE.replace(/[/.]/g, "\\$&")}/`));
    assert.match(r.msg.error.message, new RegExp(`this resource is ${RESOURCE.replace(/[/.]/g, "\\$&")}`));
  } finally { stack.stop(); }
});

test("a resolve-key auth failure blames this server's token, not the caller's", async () => {
  const stack = await startStack({ env: { OCTEN_OAUTH_RESOLVE_TOKEN: "wrong-service-token" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503, "our own misconfiguration must not be reported as the user's token being bad");
    assertDiagnostic(r.msg.error.message, /service token/);
    // The distinction under test is who is at fault. Saying "your token is
    // invalid" here sends the user round a re-authorization loop that cannot
    // fix a secret only we can rotate; the message must point at us instead.
    assert.doesNotMatch(r.msg.error.message, /(your|the) (access )?token (is|was) (invalid|expired|rejected)/i,
      `blames the caller for a server-side secret: ${r.msg.error.message}`);
    assert.match(r.msg.error.message, /rather than re-authorizing/,
      "must steer the client to retry, since re-authorizing cannot help");
  } finally { stack.stop(); }
});

test("a resolve endpoint answering 500 names the dependency and the status", async () => {
  const stack = await startStack({ as: { resolve: "http500" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    assert.equal(r.status, 503);
    assertDiagnostic(r.msg.error.message, /grant-resolution service answered HTTP 500/);
  } finally { stack.stop(); }
});

test("error messages never leak the internal resolve address", async () => {
  const stack = await startStack({ as: { resolve: "http500" } });
  try {
    const r = await bearerCall(stack.srv.port, mint(claims(stack.as)));
    // Specific about the fault, silent about internal topology — the resolve
    // endpoint is a cluster-internal address and this body goes to the public
    // internet.
    assert.doesNotMatch(r.msg.error.message, /internal\/oauth|127\.0\.0\.1|svc\.cluster\.local/,
      `internal address leaked: ${r.msg.error.message}`);
  } finally { stack.stop(); }
});

test("a missing credential says which headers are accepted", async () => {
  const stack = await startStack();
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp?login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const body = await res.json();
    assertDiagnostic(body.error.message, /x-api-key/);
    assert.match(body.error.message, /Authorization: Bearer/);
  } finally { stack.stop(); }
});

// ---- Resource-metadata path derivation --------------------------------------

test("the advertised metadata URL is derived from the resource path, and is served there", async () => {
  const stack = await startStack({ env: { OCTEN_MCP_RESOURCE: "https://host.example/deep/path/mcp" } });
  try {
    const res = await fetch(`http://127.0.0.1:${stack.srv.port}/mcp?login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
    const advertised = res.headers.get("www-authenticate").match(/resource_metadata="([^"]+)"/)[1];
    assert.equal(advertised, "https://host.example/.well-known/oauth-protected-resource/deep/path/mcp",
      "a hardcoded /mcp would advertise a document this deployment does not serve");
    // The advertised path must actually resolve here, or clients following the
    // challenge land on a 404 with no way forward.
    const doc = await fetch(`http://127.0.0.1:${stack.srv.port}${new URL(advertised).pathname}`);
    assert.equal(doc.status, 200);
    assert.equal((await doc.json()).resource, "https://host.example/deep/path/mcp");
    await assertAlive(stack.srv, "path-derived metadata");
  } finally { stack.stop(); }
});
