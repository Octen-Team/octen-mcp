/**
 * Regression tests for body-read misdiagnoses, on real sockets.
 *
 * `resp.json()` can fail three distinct ways, and two of them are not parse
 * errors: the client deadline aborting a stalled read, and the connection
 * dying mid-body (RST / FIN / an unhonored Content-Length — undici surfaces
 * these as a bare `TypeError: terminated` with the diagnosis on `cause.code`).
 * Both used to be reported as "returned non-JSON (HTTP 200)", sending whoever
 * reads the error hunting for a serialization bug instead of a network event.
 * A trans-Pacific stream that stops mid-body is a realistic failure shape
 * (see the 0.4.0 field report); the diagnosis must name which one happened.
 *
 * The genuine-non-JSON branch (an HTML 502 from a gateway) is guarded by
 * "a gateway that returns HTML instead of JSON is reported as such" in
 * startup.test.mjs — together these pin all three branches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** Drive one tools/call through the stdio server; resolve its result. */
function callViaStdio(env, args, { killAfterMs = 12000 } = {}) {
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
    // No id at all in user-facing text for body-read failures: neither the
    // client UUID nor the edge ref is searchable on Octen's side today.
    assert.doesNotMatch(text, /request_id=/, "client UUID leaked into a user-facing message");
    // And it is the 2s deadline doing the aborting, at real elapsed time.
    assert.ok(elapsed >= 1900 && elapsed < 9000, `deadline fired at ${elapsed}ms, expected ~2000ms`);
  } finally {
    upstream.close();
  }
});

test("a connection torn down mid-body is reported as a lost connection, not as malformed JSON", async () => {
  // The sibling the first fix missed, caught by its own review: no client
  // timeout fires here — the origin RSTs after half a body. undici rejects
  // resp.json() with a bare TypeError ("terminated"); the diagnosis lives on
  // e.cause.code, and lumping it into "non-JSON" is the same misdiagnosis
  // family this file exists to prevent.
  const upstream = net.createServer((sock) => {
    sock.on("data", () => {
      sock.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
        "Content-Length: 4096\r\n\r\n" + '{"code":0,"data":{"resul'
      );
      setTimeout(() => sock.resetAndDestroy(), 150); // RST, deadline never involved
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    const t0 = Date.now();
    const result = await callViaStdio(
      { OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` },
      { query: "x", timeout: 30 } // generous: proves the deadline is NOT what fired
    );
    const elapsed = Date.now() - t0;
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(
      text,
      /connection lost while reading the response body \(HTTP 200, code=(ECONNRESET|UND_ERR_SOCKET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH)\)/,
      `got: ${text}`
    );
    assert.doesNotMatch(text, /non-JSON/, "a torn-down connection must not be misreported as malformed JSON");
    assert.doesNotMatch(text, /timed out/, "no timeout fired here and the message must not claim one");
    assert.doesNotMatch(text, /request_id=/, "client UUID leaked into a user-facing message");
    assert.ok(elapsed < 10000, `failed fast at ${elapsed}ms — the 30s deadline was not the trigger`);
  } finally {
    upstream.close();
  }
});

test("body-read failures carry NO id — nothing Octen can search exists for them today", async () => {
  // The upstream DOES stamp an x-azure-ref, so this asserts active
  // suppression, not absence of input: edge access logging is not enabled on
  // Octen's side (verified 2026-08-15), so showing the ref would recreate the
  // unsearchable-id dead-end. Re-flip this test when edge logging lands.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "x-azure-ref": "EDGE-REF-TEST-123" });
    res.write('{"code":0,"data'); // then silence
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    const result = await callViaStdio(
      { OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` },
      { query: "x", timeout: 2 }
    );
    const text = result.content[0].text;
    assert.doesNotMatch(text, /x-azure-ref=/, `an unsearchable id leaked into user-facing text: ${text}`);
    assert.doesNotMatch(text, /request_id=/, "client UUID must stay out of user-facing text");
  } finally { upstream.close(); }
});
