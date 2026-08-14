/**
 * Tests for the remote HTTP entry (built output).
 *
 * The design under test follows Exa's (docs/remote-mcp-feasibility.md):
 * stateless Streamable HTTP, `initialize`/`tools/list` unauthenticated, auth
 * enforced at `tools/call`, and both `x-api-key` and `Authorization: Bearer`
 * accepted. The most important case here is key isolation — one process serves
 * many tenants, and nothing in the in-process suites exercises that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "httpServer.js");

/** Start the HTTP server on an ephemeral port; resolve { port, stop, stderr() }. */
function startHttp(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, PORT: "0",
        HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${err}`)), 8000);
    child.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/listening on :(\d+)\/mcp/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), stop: () => child.kill(), stderr: () => err });
      }
    });
  });
}

/** Stub upstream API that records the x-api-key of every request it receives. */
function startUpstream() {
  const seenKeys = [];
  const srv = http.createServer((req, res) => {
    seenKeys.push(req.headers["x-api-key"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      code: 0,
      data: { results: [{ title: `echo:${req.headers["x-api-key"]}`, url: "http://x" }] },
      meta: {},
    }));
  });
  return new Promise((resolve) => srv.listen(0, () =>
    resolve({ port: srv.address().port, seenKeys, close: () => srv.close() })));
}

/** POST one JSON-RPC message; parse the SSE or JSON response into the message. */
async function rpc(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
    return { status: res.status, msg: data ? JSON.parse(data.slice(6)) : undefined, raw: text };
  }
  return { status: res.status, msg: text ? JSON.parse(text) : undefined, raw: text };
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const call = (id, query) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "search", arguments: { query } },
});

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
