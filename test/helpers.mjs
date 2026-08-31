/**
 * Shared harness for tests that drive the built HTTP entry as a real process
 * against real sockets. Not matched by the test glob (no `.test.` infix).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "httpServer.js");

/** Start the HTTP server on an ephemeral port; resolve { port, stop, stderr() }. */
export function startHttp(env = {}) {
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
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${err}`)), 8000);
    child.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/listening on :(\d+)\/mcp/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), child, exited, stop: () => child.kill(), stderr: () => err });
      }
    });
  });
}

/**
 * Wait for a pattern to appear in a server's stderr, bounded.
 *
 * Some events are written after the client's socket is already gone — a drain
 * finishes once the peer stops sending, which is strictly later than the
 * response the test was waiting on. Sampling `stderr()` once at that moment
 * asks the server to have already logged something it has no reason to have
 * logged yet. That passes on a fast machine and fails on a loaded CI runner,
 * which is how this arrived: green locally, red on all five Node versions.
 *
 * Returns the accumulated stderr either way, so the caller's assertion still
 * produces the full log on failure rather than a bare timeout.
 */
export async function waitForStderr(srv, re, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(srv.stderr())) return srv.stderr();
    await new Promise((r) => setTimeout(r, 25));
  }
  return srv.stderr();
}

/** Stub upstream API that records the x-api-key of every request it receives. */
export function startUpstream() {
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
export async function rpc(port, body, headers = {}) {
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

export const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
export const call = (id, query) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "search", arguments: { query } },
});
