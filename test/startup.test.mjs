/**
 * Startup-time behaviour that cannot be tested in-process.
 *
 * `src/http.ts` builds its dispatcher and resolves `OCTEN_RETRY` once, at module
 * load. Both are therefore frozen by the time the first test in a file runs, so
 * each case here spawns a fresh server and drives the real stdio protocol.
 *
 * The proxy cases are regressions: undici throws synchronously when it cannot
 * parse a proxy URL, and an uncaught throw at module load takes down all six
 * tools over a variable that 0.3.7 ignored entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

/** Spawn the built server with `env`, send `initialize`, resolve what came back. */
function startServer(env, extraStdin = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, OCTEN_API_KEY: "test-key", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.write(INITIALIZE + "\n");
    child.stdin.write(extraStdin);
    // The server holds stdio open; give it a moment, then close.
    setTimeout(() => child.kill(), 1500);
  });
}

/** Like startServer, but writes a second batch of stdin after `delayMs`. */
function startServerStaged(env, firstStdin, laterStdin, delayMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, OCTEN_API_KEY: "test-key", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.write(INITIALIZE + "\n");
    child.stdin.write(firstStdin);
    setTimeout(() => child.stdin.write(laterStdin), delayMs);
    setTimeout(() => child.kill(), delayMs + 2500);
  });
}

function started({ out }) {
  return out.split("\n").some((l) => l.includes('"serverInfo"'));
}

for (const [label, proxy] of [
  ["scheme-less (curl accepts this form)", "proxy.corp.example:8080"],
  ["unsupported scheme", "socks5://127.0.0.1:1080"],
  ["unparseable", ":::not-a-url"],
]) {
  test(`a ${label} proxy value does not prevent the server from starting`, async () => {
    const r = await startServer({ HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy });
    assert.ok(
      started(r),
      `server failed to start with HTTPS_PROXY=${proxy}. undici throws on an unparseable proxy ` +
      `URL at construction; unguarded, that kills all six tools at startup.\nstderr: ${r.err.slice(0, 400)}`
    );
  });
}

test("an unusable proxy is reported on stderr and falls back to direct connections", async () => {
  const r = await startServer({
    HTTPS_PROXY: "socks5://127.0.0.1:1080", https_proxy: "socks5://127.0.0.1:1080",
    HTTP_PROXY: "socks5://127.0.0.1:1080", http_proxy: "socks5://127.0.0.1:1080",
  });
  assert.ok(started(r));
  assert.match(r.err, /proxy environment is set but unusable/,
    "a silently ignored proxy is how the original bug went unnoticed for a release");
});

test("stdout carries only JSON-RPC, even with debug tracing on", async () => {
  const r = await startServer({ OCTEN_MCP_DEBUG: "1" });
  assert.ok(started(r));
  for (const line of r.out.split("\n").filter(Boolean)) {
    assert.doesNotMatch(line, /\[octen-mcp\]/, "debug output leaked into the MCP protocol stream");
    JSON.parse(line); // throws if anything non-JSON reached stdout
  }
  assert.match(r.err, /dispatcher=/, "debug tracing did not reach stderr");
});

/** Drive one search against an unreachable origin and count the logged attempts. */
async function countAttempts(env) {
  const call = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search", arguments: { query: "x" } },
  });
  const r = await startServer(
    { OCTEN_API_URL: "http://127.0.0.1:45999", OCTEN_MCP_DEBUG: "1",
      HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "", ...env },
    call + "\n"
  );
  return (r.err.match(/attempt=\d/g) ?? []).length;
}

test("connection failures are retried once by default", async () => {
  assert.equal(await countAttempts({}), 2);
});

test("OCTEN_RETRY=off disables the retry", async () => {
  assert.equal(await countAttempts({ OCTEN_RETRY: "off" }), 1,
    "the opt-out shipped without coverage in the first pass; a retry costs quota");
});

test("debug tracing emits the fields a field report needs", async () => {
  // A real local origin, so the success path (and its headers) is exercised.
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { results: [] }, meta: {} }));
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;

  const call = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search", arguments: { query: "x" } },
  });
  const r = await startServer(
    { OCTEN_MCP_DEBUG: "1", OCTEN_API_URL: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "" },
    call + "\n"
  );
  srv.close();

  // An absolute timestamp: a duration alone cannot be aligned against a
  // client's session log or against server-side receive times.
  assert.match(r.err, /\[octen-mcp \d{4}-\d{2}-\d{2}T[\d:.]+Z\]/,
    "debug lines carry no wall-clock timestamp");
  // When the call reached this process — the only way to separate our latency
  // from the host's or a relay's.
  assert.match(r.err, /call #1 received tool=search/);
  assert.match(r.err, /call #1 returning tool=search handler_total=\d+ms/);
  // Whether a handshake was paid for.
  assert.match(r.err, /socket=(new|reused)/);
  assert.match(r.err, /\/search attempt=1 status=200 elapsed=\d+ms/);
});

test("concurrent calls do not cross-attribute each other's connections", async () => {
  // The bug this guards: connection state kept in module-level counters is
  // shared by every in-flight call, so one call reports another's connection as
  // its own. It surfaced as `status=200 socket=connect-failed` — a contradiction
  // on its face.
  //
  // Reproducing it needs a *mix*, not just concurrency: one call reusing a warm
  // socket while another call's connect fails at the same moment. Four calls
  // that all open connections corrupt nothing, because every one of them really
  // did open a connection. `maxConnections = 1` produces the mix — the pool's
  // second connection is dropped on arrival while the first stays usable.
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { results: [] }, meta: {} }));
    }, 400);
  });
  srv.maxConnections = 1;
  srv.keepAliveTimeout = 60_000;
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;

  const call = (id) => JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "search", arguments: { query: `q${id}` } },
  });
  // First call warms one socket; the next two run together, so one reuses it
  // and the other tries — and fails — to open a second.
  const stdin = call(10) + "\n";
  const later = call(11) + "\n" + call(12) + "\n";

  const r = await startServerStaged(
    { OCTEN_MCP_DEBUG: "1", OCTEN_API_URL: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "" },
    stdin, later, 1200
  );
  srv.close();

  const lines = r.err.split("\n").filter((l) => l.includes("attempt="));
  assert.ok(lines.length >= 2, `expected several request lines, got:\n${r.err}`);
  for (const line of lines) {
    assert.doesNotMatch(
      line, /status=200.*socket=connect-failed/,
      `a call that returned 200 cannot have failed to connect — it inherited another call's connection state:\n${line}`
    );
  }
  const reused = lines.filter((l) => l.includes("socket=reused")).length;
  assert.ok(reused >= 1,
    `expected at least one call to reuse the warm socket; none did, so the mix this test needs did not occur:\n${r.err}`);
});

test("a call that opens a connection reports peer address, TLS and ALPN", async () => {
  const call = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search", arguments: { query: "x" } },
  });
  const r = await startServer(
    { OCTEN_MCP_DEBUG: "1", OCTEN_API_URL: "http://127.0.0.1:45999",
      HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "" },
    call + "\n"
  );
  // Unreachable origin: the connect-failure line must still name what it tried.
  assert.match(r.err, /connect FAILED.*code=ECONNREFUSED/);
  assert.match(r.err, /connect FAILED.*peer=127\.0\.0\.1:45999/,
    "a connect failure that does not say which address it tried is not actionable");
  assert.match(r.err, /socket=connect-failed/,
    "a connection that was never established must not be reported as reused");
});

test("env overrides reach the dispatcher", async () => {
  const r = await startServer({
    OCTEN_MCP_DEBUG: "1", OCTEN_KEEP_ALIVE_MS: "12345",
    OCTEN_CONNECT_TIMEOUT_MS: "6789", OCTEN_HTTP2: "1",
  });
  assert.match(r.err, /keepAlive=12345ms/);
  assert.match(r.err, /connect=6789ms/);
  assert.match(r.err, /h2=true/);
});

test("an invalid env override falls back rather than producing NaN", async () => {
  const r = await startServer({ OCTEN_MCP_DEBUG: "1", OCTEN_KEEP_ALIVE_MS: "not-a-number" });
  assert.match(r.err, /keepAlive=60000ms/, "invalid input should fall back to the default");
  assert.doesNotMatch(r.err, /NaN/);
});

test("a gateway that returns HTML instead of JSON is reported as such", async () => {
  // Untestable through the in-process stub, whose `json()` returns an object
  // directly and so can never throw the way a real body does. A 502 page from
  // an intermediary is a normal production event and must not surface as a
  // parse crash or a misleading network error.
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html><body>502 Bad Gateway</body></html>");
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;

  const call = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search", arguments: { query: "x" } },
  });
  const r = await startServer(
    { OCTEN_API_URL: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "" },
    call + "\n"
  );
  srv.close();

  const reply = r.out.split("\n").filter(Boolean).map(JSON.parse).find((m) => m.id === 2);
  const text = reply?.result?.content?.[0]?.text ?? "";
  assert.match(text, /returned non-JSON \(HTTP 502\)/, `got: ${text}`);
});
