/**
 * Tests for the remote HTTP entry (built output).
 *
 * The design under test:
 * stateless Streamable HTTP, `initialize`/`tools/list` unauthenticated, auth
 * enforced at `tools/call`, and both `x-api-key` and `Authorization: Bearer`
 * accepted. The most important case here is key isolation — one process serves
 * many tenants, and nothing in the in-process suites exercises that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startHttp, startUpstream, rpc, call, INIT } from "./helpers.mjs";

test("healthz answers without touching the upstream", async () => {
  const srv = await startHttp();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.name, "octen-mcp");
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
  } finally { srv.stop(); }
});

test("initialize succeeds without a credential (auth is enforced at call time)", async () => {
  const srv = await startHttp();
  try {
    const { status, msg } = await rpc(srv.port, INIT);
    assert.equal(status, 200);
    assert.equal(msg.result.serverInfo.name, "octen-mcp");
  } finally { srv.stop(); }
});

test("tools/list succeeds without a credential and shows all six tools", async () => {
  const srv = await startHttp();
  try {
    const { msg } = await rpc(srv.port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(
      msg.result.tools.map((t) => t.name).sort(),
      ["broad_search", "extract", "image_search", "news_search", "search", "video_search"]
    );
  } finally { srv.stop(); }
});

test("tools/call without a credential fails with header guidance, not an env-var hint", async () => {
  const srv = await startHttp();
  try {
    const { msg } = await rpc(srv.port, call(3, "x"));
    assert.equal(msg.result.isError, true);
    const text = msg.result.content[0].text;
    assert.match(text, /x-api-key/, "the fix for an HTTP caller is a header, and the error must say so");
    assert.match(text, /Bearer/);
    assert.doesNotMatch(text, /env var/, "env-var advice is wrong for a remote caller");
  } finally { srv.stop(); }
});

test("x-api-key header reaches the upstream", async () => {
  const up = await startUpstream();
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}` });
  try {
    const { msg } = await rpc(srv.port, call(4, "x"), { "x-api-key": "key-alpha" });
    assert.notEqual(msg.result.isError, true, msg.result.content?.[0]?.text);
    assert.deepEqual(up.seenKeys, ["key-alpha"]);
  } finally { srv.stop(); up.close(); }
});

test("Authorization: Bearer is accepted as the same credential (Codex-style clients)", async () => {
  const up = await startUpstream();
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}` });
  try {
    const { msg } = await rpc(srv.port, call(5, "x"), { Authorization: "Bearer key-bravo" });
    assert.notEqual(msg.result.isError, true, msg.result.content?.[0]?.text);
    assert.deepEqual(up.seenKeys, ["key-bravo"]);
  } finally { srv.stop(); up.close(); }
});

test("concurrent requests with different keys never receive each other's credential", async () => {
  // The whole multi-tenant premise. If the key ever lands in module state
  // instead of per-request closure, concurrent tenants swap credentials —
  // quota billed to the wrong account at best, data under the wrong account
  // at worst — and every single-caller test stays green while it happens.
  const up = await startUpstream();
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}` });
  try {
    const keys = ["tenant-a", "tenant-b", "tenant-c", "tenant-d"];
    const results = await Promise.all(keys.map((k, i) =>
      rpc(srv.port, call(10 + i, `q-${k}`), { "x-api-key": k })));
    for (const [i, r] of results.entries()) {
      assert.notEqual(r.msg.result.isError, true);
      // The stub echoes the key it saw into the result title.
      assert.match(
        r.msg.result.content[0].text, new RegExp(`echo:${keys[i]}`),
        `request sent with ${keys[i]} was served with someone else's credential`
      );
    }
    assert.deepEqual([...up.seenKeys].sort(), [...keys].sort());
  } finally { srv.stop(); up.close(); }
});

test("the environment's key is never used as a fallback for HTTP callers", async () => {
  // stdio's env fallback must not leak here: a request with no key must fail,
  // not silently ride the deployment's own credential.
  const up = await startUpstream();
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`,
    OCTEN_API_KEY: "deployment-secret",
  });
  try {
    const { msg } = await rpc(srv.port, call(6, "x"));
    assert.equal(msg.result.isError, true, "keyless request must fail even when the process env has a key");
    assert.equal(up.seenKeys.length, 0, "the deployment's own key leaked to an unauthenticated caller");
  } finally { srv.stop(); up.close(); }
});

test("GET /mcp is 405 (stateless: no standalone SSE stream)", async () => {
  const srv = await startHttp();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(res.status, 405);
  } finally { srv.stop(); }
});

test("a request whose body arrives late keeps its own key (deterministic isolation)", async () => {
  // The concurrent test above guards the observable contract, but the race
  // window for shared-key-state bugs sits between a request's HEADERS arriving
  // and its dispatch — i.e. during the body-read await. Promise.all cannot
  // reliably land inside it. This constructs the interleaving exactly:
  //
  //   A: headers + half the body (key tenant-A) ... stall ...
  //   B: complete request (key tenant-B)          ← would overwrite shared state
  //   A: rest of the body                         ← A dispatches; must still be tenant-A
  const net = await import("node:net");
  const up = await startUpstream();
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}` });
  try {
    const bodyA = JSON.stringify(call(20, "slow-body"));
    const half = Math.floor(bodyA.length / 2);

    const sock = net.connect(srv.port, "127.0.0.1");
    await new Promise((r) => sock.on("connect", r));
    sock.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
      `Accept: application/json, text/event-stream\r\nx-api-key: tenant-A\r\n` +
      `Content-Length: ${bodyA.length}\r\n\r\n` + bodyA.slice(0, half)
    );
    // Let A's headers be fully processed before B goes through.
    await new Promise((r) => setTimeout(r, 150));

    const b = await rpc(srv.port, call(21, "fast"), { "x-api-key": "tenant-B" });
    assert.notEqual(b.msg.result.isError, true);

    // Now complete A and read its response.
    let respA = "";
    sock.on("data", (d) => (respA += d));
    sock.write(bodyA.slice(half));
    await new Promise((r) => setTimeout(r, 800));
    sock.destroy();

    assert.match(
      respA, /echo:tenant-A/,
      `request A was served with a credential overwritten during its body read:\n${respA.slice(-300)}`
    );
    assert.deepEqual([...up.seenKeys].sort(), ["tenant-A", "tenant-B"]);
  } finally { srv.stop(); up.close(); }
});

test("oversized bodies are refused with 413 before parsing", async () => {
  // The cap is set explicitly rather than inherited: what is under test is
  // "over the cap is 413", not what the cap happens to default to. Pinning it
  // to the default meant this test had to be rewritten the day the default
  // moved to make room for base64 images.
  const srv = await startHttp({ OCTEN_MCP_MAX_BODY: "65536" });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search", arguments: { query: "x".repeat(65536 + 100) } } }),
    });
    assert.equal(res.status, 413);
    await res.text();
  } finally { srv.stop(); }
});

test("OCTEN_MCP_LOG=json emits parseable structured events and never the full key", async () => {
  const up = await startUpstream();
  const secret = "secret-key-abcdef123456";
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}`, OCTEN_MCP_LOG: "json" });
  try {
    await rpc(srv.port, call(30, "x"), { "x-api-key": secret });
    // Give the trailing call_returning line a beat to flush.
    await new Promise((r) => setTimeout(r, 200));
    const err = srv.stderr();

    // Redaction is the non-negotiable property of this log mode.
    assert.doesNotMatch(err, new RegExp(secret), "the full API key leaked into logs");
    // Fingerprint, not prefix: enough to tell two keys apart in a trace, and
    // never more than half the credential — a flat 8 characters was the whole
    // thing for anything shorter than that.
    const fp = err.match(/"key_prefix":"([^"]*)"/)?.[1] ?? "";
    assert.match(fp, /^secret-k…$/);
    assert.ok(fp.replace("…", "").length <= Math.floor(secret.length / 2),
      `the fingerprint ${JSON.stringify(fp)} is more than half of a ${secret.length}-char key`);

    const events = err.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    // Not Object.groupBy: that is Node 21+, and this package declares
    // engines >=18.17 with CI running 18 through 26.
    const byEvent = events.reduce((acc, e) => {
      (acc[e.event] ??= []).push(e);
      return acc;
    }, {});
    assert.ok(byEvent.startup, "no startup event");
    assert.ok(byEvent.http_request, "no http_request event");
    assert.ok(byEvent.call_received?.[0]?.tool === "search");
    assert.ok(byEvent.call_returning?.[0]?.handler_ms >= 0, "call_returning lacks handler_ms");
    const reqEvt = byEvent.request?.[0];
    assert.equal(reqEvt?.status, 200);
    assert.match(reqEvt?.socket ?? "", /^(new|reused)$/);
    for (const e of events) assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/, "event missing ts");
  } finally { srv.stop(); up.close(); }
});

test("SIGTERM drains: in-flight call completes, healthz flips 503, new calls refused, exit 0", async () => {
  // The rolling-deploy contract. Without it every deploy kills live calls.
  const http2 = await import("node:http");
  const upSrv = http2.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { results: [{ title: "slow-ok", url: "http://x" }] }, meta: {} }));
    }, 1200);
  });
  await new Promise((r) => upSrv.listen(0, r));
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${upSrv.address().port}` });
  try {
    // Start a call that will still be in flight when SIGTERM lands.
    const inflight = rpc(srv.port, call(40, "slow"), { "x-api-key": "k" });
    await new Promise((r) => setTimeout(r, 300));

    srv.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));

    // Readiness must already report draining…
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(h.status, 503, "healthz must flip to 503 during drain");
    assert.equal((await h.json()).status, "draining");
    // …new work must be refused…
    const refused = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": "k" },
      body: JSON.stringify(call(41, "new")),
    });
    assert.equal(refused.status, 503, "new requests during drain must be refused");
    await refused.json(); // consume — an unread body raises a late rejection when the child exits

    // …and the in-flight call must still complete successfully.
    const done = await inflight;
    assert.notEqual(done.msg.result.isError, true, done.msg.result?.content?.[0]?.text);
    assert.match(done.msg.result.content[0].text, /slow-ok/);

    assert.equal(await srv.exited, 0, "drained process must exit 0");
  } finally { srv.stop(); upSrv.close(); }
});

// ---------------------------------------------------------------------------
// OAuth surface (A3.5): the trigger that makes clients start OAuth at all.
// Verified live against a hosted MCP endpoint: without a 401 + WWW-Authenticate,
// claude.ai treats a server as unauthenticated and never shows consent.
// ---------------------------------------------------------------------------
const OAUTH_ENV = {
  OCTEN_OAUTH_AUTHORIZATION_SERVER: "https://auth.octen.example",
  OCTEN_MCP_RESOURCE: "https://mcp.octen.example/mcp",
};

test("with an AS configured, both PRM well-known paths serve the RFC 9728 document", async () => {
  const srv = await startHttp(OAUTH_ENV);
  try {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${p}`);
      assert.equal(res.status, 200, p);
      const doc = await res.json();
      assert.deepEqual(doc, {
        resource: "https://mcp.octen.example/mcp",
        authorization_servers: ["https://auth.octen.example"],
        scopes_supported: ["mcp:tools"],
        bearer_methods_supported: ["header"],
      }, `PRM at ${p} must match RFC 9728 byte-for-byte — aud binding depends on it`);
    }
  } finally { srv.stop(); }
});

test("?login without a credential answers 401 with the challenge pointing at PRM", async () => {
  const srv = await startHttp(OAUTH_ENV);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp?login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(INIT),
    });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://mcp.octen.example/.well-known/oauth-protected-resource/mcp"',
      "the challenge is how a client finds the AS; a malformed header ends the flow silently"
    );
    await res.json();
  } finally { srv.stop(); }
});

test("?login challenges even a request that carries a credential", async () => {
  // Deliberate reversal of what this test used to assert. It pinned "presence
  // of any credential passes through", which came from the era when `?login`
  // was the *gate* on the challenge. That gate was removed — an uncredentialed
  // request is challenged everywhere now — and what `?login` is for afterwards
  // is the opposite: forcing authorization when a credential IS present. That
  // is the only route from an already-configured API key to OAuth, because a
  // key otherwise stops the challenge from ever being sent.
  const srv = await startHttp(OAUTH_ENV);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp?login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: "Bearer anything-at-all",
      },
      body: JSON.stringify(INIT),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    await res.text();

    // Reverse case: the plain endpoint must still accept that same credential,
    // or forcing would just be a blanket refusal.
    const plain = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: "Bearer anything-at-all",
      },
      body: JSON.stringify(INIT),
    });
    assert.equal(plain.status, 200);
    await plain.text();
  } finally { srv.stop(); }
});

test("without an AS configured, the OAuth surface does not exist", async () => {
  // A self-hosted instance must not advertise an authorization server it
  // does not have — an unusable capability surfaced anywhere misleads.
  const srv = await startHttp();
  try {
    const prm = await fetch(`http://127.0.0.1:${srv.port}/.well-known/oauth-protected-resource`);
    assert.equal(prm.status, 404);
    await prm.json();
    const login = await fetch(`http://127.0.0.1:${srv.port}/mcp?login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(INIT),
    });
    assert.equal(login.status, 200, "?login is inert when no AS is configured");
  } finally { srv.stop(); }
});

test("initialize advertises the branding surface (title, websiteUrl, icons)", async () => {
  const srv = await startHttp();
  try {
    const { msg } = await rpc(srv.port, INIT);
    const info = msg.result.serverInfo;
    assert.equal(info.title, "Octen");
    assert.equal(info.websiteUrl, "https://octen.ai");
    assert.ok(Array.isArray(info.icons) && info.icons[0].src.startsWith("https://octen.ai/"),
      "directory listings render these fields");
  } finally { srv.stop(); }
});
