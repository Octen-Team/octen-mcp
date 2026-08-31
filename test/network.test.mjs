/**
 * Real-socket reproductions of the failure shapes from the 0.3.7 field report.
 *
 * The in-process suite (http.test.mjs) covers the same code paths with
 * *simulated* error objects — a stub that throws `{code: "ECONNRESET"}`. That
 * proves the handling logic, not that real wire behavior produces those
 * shapes. Each test here builds the failure out of actual TCP sockets and
 * drives the built server as a separate process.
 *
 * What deliberately is NOT here, and why (recorded so nobody "fixes" it):
 *  - A true SYN-blackhole connect timeout (the reporter's cluster, 12.8s). It
 *    cannot be simulated deterministically cross-platform: localhost always answers, the
 *    listen-backlog-saturation trick works on Linux but macOS accepts anyway
 *    (verified 2026-08-15), and unroutable test IPs are hijacked by VPN/TUN
 *    setups — which is exactly how this repo's own dev machine behaves. The
 *    UND_ERR_CONNECT_TIMEOUT handling stays covered by the simulated-error
 *    tests plus manual live verification.
 *  - DNS failure (ENOTFOUND): resolver behavior is environment-dependent for
 *    the same reason.
 *  - Upstream queueing/relay delay (field report §4.2): not our layer; covered
 *    by the call_received observability, not by tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

import { startHttp, rpc, call } from "./helpers.mjs";

/**
 * Raw TCP upstream that serves connection #1's first request normally, then
 * RSTs the moment a second request arrives on that same socket — the
 * keep-alive race: the origin killing a socket exactly as the client
 * dispatches on it. Every later connection is served normally.
 */
function startRstOnReuseServer() {
  let conns = 0;
  const srv = net.createServer((sock) => {
    conns++;
    const id = conns;
    let requests = 0;
    sock.on("data", (d) => {
      const chunk = d.toString("latin1");
      if (!chunk.includes("POST ")) return; // body continuation of a parsed request
      requests++;
      if (id === 1 && requests >= 2) {
        sock.resetAndDestroy(); // RST, not FIN — the abrupt variant
        return;
      }
      const body = JSON.stringify({
        code: 0,
        data: { results: [{ title: `served-by-conn-${id}`, url: "http://x" }] },
        meta: {},
      });
      sock.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`
      );
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ port: srv.address().port, close: () => srv.close() })));
}

test("a socket RST mid-dispatch on a reused connection is rescued by the retry", async () => {
  // Field report §4.5: every one of their manual retries succeeded. This is that
  // scenario on real sockets — and the property the retry exists for.
  const up = await startRstOnReuseServer();
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${up.port}`, OCTEN_MCP_DEBUG: "1" });
  try {
    const first = await rpc(srv.port, call(1, "warm"), { "x-api-key": "k" });
    assert.match(first.msg.result.content[0].text, /served-by-conn-1/);

    const second = await rpc(srv.port, call(2, "reuse"), { "x-api-key": "k" });
    assert.notEqual(second.msg.result.isError, true,
      `retry did not rescue the RST: ${second.msg.result.content?.[0]?.text}`);
    assert.match(second.msg.result.content[0].text, /served-by-conn-2/,
      "the rescue must have happened on a fresh connection");

    const err = srv.stderr();
    assert.match(err, /attempt=1 FAILED .*socket=reused/,
      "the failure must be attributed to the reused socket");
    assert.match(err, /attempt=2 status=200 .*socket=new/,
      "the retry must show a fresh connection");
  } finally { srv.stop(); up.close(); }
});

test("the same RST without the retry is a real wire failure (harness self-check)", async () => {
  // Guards the test above against silently stopping to reproduce: if undici
  // ever absorbs this internally, this companion starts failing and tells us
  // the scenario — not the retry — went stale.
  const up = await startRstOnReuseServer();
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${up.port}`, OCTEN_MCP_DEBUG: "1", OCTEN_RETRY: "off",
  });
  try {
    await rpc(srv.port, call(1, "warm"), { "x-api-key": "k" });
    const second = await rpc(srv.port, call(2, "reuse"), { "x-api-key": "k" });
    assert.equal(second.msg.result.isError, true,
      "with the retry off, the RST must surface — otherwise this suite is testing nothing");
    assert.match(second.msg.result.content[0].text, /ECONNRESET|UND_ERR_SOCKET/);
  } finally { srv.stop(); up.close(); }
});

test("an origin that closes idle sockets politely (FIN) costs a reconnect, not an error", async () => {
  // The graceful sibling of the RST case — and the reason keepAliveTimeout
  // must sit below the origin's idle limit. A FIN'd socket must be replaced
  // silently: no failure, no retry, just socket=new on the next call.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { results: [{ title: "ok", url: "http://x" }] }, meta: {} }));
  });
  upstream.keepAliveTimeout = 100; // origin reaps idle sockets fast
  await new Promise((r) => upstream.listen(0, r));
  const srv = await startHttp({
    OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}`, OCTEN_MCP_DEBUG: "1",
  });
  try {
    const a = await rpc(srv.port, call(1, "a"), { "x-api-key": "k" });
    assert.notEqual(a.msg.result.isError, true);
    await new Promise((r) => setTimeout(r, 400)); // outlive the origin's idle limit
    const b = await rpc(srv.port, call(2, "b"), { "x-api-key": "k" });
    assert.notEqual(b.msg.result.isError, true);
    assert.doesNotMatch(srv.stderr(), /FAILED/,
      "a polite FIN must not surface as a failure anywhere");
  } finally { srv.stop(); upstream.close(); }
});

test("[http transport] an upstream that accepts and never answers hits the tool deadline at real elapsed time", async () => {
  // The in-process suite fakes TimeoutError objects; this one earns it: the
  // socket connects fine and then nothing ever comes back.
  const upstream = http.createServer(() => { /* accept, read, say nothing */ });
  await new Promise((r) => upstream.listen(0, r));
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const t0 = Date.now();
    const r = await rpc(srv.port, { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search", arguments: { query: "x", timeout: 2 } } }, { "x-api-key": "k" });
    const elapsed = Date.now() - t0;
    assert.equal(r.msg.result.isError, true);
    assert.match(r.msg.result.content[0].text, /timed out after 2s/);
    assert.ok(elapsed >= 1900 && elapsed < 8000, `deadline fired at ${elapsed}ms, expected ~2000ms`);
  } finally { srv.stop(); upstream.close(); }
});

test("[http transport] a stalled response body is reported as a timeout, not as malformed JSON", async () => {
  // Found while writing this suite: headers 200 arrive, the body stalls, the
  // deadline aborts the body read — and the old catch reported "returned
  // non-JSON (HTTP 200)", sending whoever reads the error hunting for a
  // serialization bug instead of a stalled connection.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"code":0,"data":{"resul'); // half a body, then silence
  });
  await new Promise((r) => upstream.listen(0, r));
  const srv = await startHttp({ OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const r = await rpc(srv.port, { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search", arguments: { query: "x", timeout: 2 } } }, { "x-api-key": "k" });
    assert.equal(r.msg.result.isError, true);
    const text = r.msg.result.content[0].text;
    assert.match(text, /timed out while reading the response body \(HTTP 200\)/, `got: ${text}`);
    assert.doesNotMatch(text, /non-JSON/, "a stalled stream must not be misreported as malformed JSON");
  } finally { srv.stop(); upstream.close(); }
});
