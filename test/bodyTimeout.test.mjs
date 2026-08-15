/**
 * Regression test for the stalled-body misdiagnosis, on real sockets.
 *
 * A response whose 200 headers arrive but whose body stalls is aborted by the
 * client deadline during `resp.json()` — and used to be reported as
 * "returned non-JSON (HTTP 200)", sending whoever reads the error hunting for
 * a serialization bug instead of a stalled connection. A trans-Pacific stream
 * that stops mid-body is a realistic failure shape (see the 0.4.0 field
 * report); the diagnosis must name it.
 *
 * The genuine-non-JSON side (an HTML 502 from a gateway) is guarded by
 * "a gateway that returns HTML instead of JSON is reported as such" in
 * startup.test.mjs — together they pin both branches of the catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** Drive one tools/call through the stdio server; resolve its result. */
function callViaStdio(env, args, { killAfterMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, OCTEN_API_KEY: "test-key",
        HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no tool response before deadline; stdout:\n${out.slice(0, 500)}`));
    }, killAfterMs);
    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n").filter(Boolean)) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(m.result);
          return;
        }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: args } });
  });
}

test("a response whose body stalls mid-stream is reported as a timeout, not as malformed JSON", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"code":0,"data":{"resul'); // half a body, then silence
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    const t0 = Date.now();
    const result = await callViaStdio(
      { OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` },
      { query: "x", timeout: 2 }
    );
    const elapsed = Date.now() - t0;
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /timed out while reading the response body \(HTTP 200\)/, `got: ${text}`);
    assert.doesNotMatch(text, /non-JSON/, "a stalled stream must not be misreported as malformed JSON");
    // And it is the 2s deadline doing the aborting, at real elapsed time.
    assert.ok(elapsed >= 1900 && elapsed < 7000, `deadline fired at ${elapsed}ms, expected ~2000ms`);
  } finally {
    upstream.close();
  }
});
