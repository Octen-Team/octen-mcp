/**
 * Regression pins for the undici-8 host incompatibility (0.4.1 → 0.4.2), on
 * the real stack.
 *
 * 0.4.1 built its tuned dispatcher from the packaged undici 6 and handed it to
 * the host's global `fetch`. That couples two undici versions across the
 * dispatch-handler protocol: undici 8 — embedded from Node 26 — dropped the
 * legacy handler compatibility v7 still carried, and rejects the v6 dispatcher
 * at validation (`InvalidArgumentError: invalid onError method`) before a
 * single byte is sent. Every tool call on such hosts failed as
 * `Network error … code=UND_ERR_INVALID_ARG`.
 *
 * The fix makes the HTTP stack self-contained: fetch and dispatcher both come
 * from the packaged undici. These tests drive the real built server over a
 * real socket — no seam, no stub — so running the suite on a Node whose
 * embedded undici we cannot dispatch to fails here first, whatever version
 * that host embeds. The in-process suites cannot catch this class of bug:
 * their stubs replace exactly the layer that breaks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "dist", "index.js");

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

test("a real tool call succeeds through the packaged HTTP stack on the host's own Node", async () => {
  // The incident in one assertion: on a host whose embedded undici rejects our
  // dispatcher, this call — real server process, real socket, no seam — dies
  // with UND_ERR_INVALID_ARG before the request is sent.
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = { headers: req.headers, url: req.url };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { results: [] }, meta: {} }));
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    const result = await callViaStdio(
      { OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` },
      { query: "compat probe" }
    );
    assert.notEqual(result.isError, true,
      `the call failed — on this Node that usually means the dispatcher was ` +
      `rejected by a foreign fetch: ${result.content?.[0]?.text}`);
    assert.ok(seen, "the request never reached the origin");

    // The request must carry our credentials and correlation id …
    assert.equal(seen.headers["x-api-key"], "test-key");
    assert.match(seen.headers["x-request-id"] ?? "", /^[0-9a-f-]{36}$/);
    // … and advertise exactly what the packaged undici can decode. Left to a
    // default this varies by scheme and by which undici does the fetching; an
    // origin honouring an encoding we cannot decode turns the body to garbage.
    assert.equal(seen.headers["accept-encoding"], "gzip, deflate, br");
  } finally {
    upstream.close();
  }
});

test("compressed response bodies decode through the packaged stack", async () => {
  // The pinned accept-encoding is a promise: every encoding we advertise, the
  // packaged undici must decode. If a future undici (or a header edit) breaks
  // gzip or br decode, the body reaches JSON.parse as compressed bytes and the
  // failure surfaces as "returned non-JSON" — a misdiagnosis, pointing at the
  // origin when the bug is ours. This exercises the decode path for real; the
  // header assertion above only proves what we advertise.
  const { gzipSync, brotliCompressSync } = await import("node:zlib");
  const envelope = Buffer.from(JSON.stringify({ code: 0, data: { results: [] }, meta: {} }));
  let enc = "gzip";
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": enc });
    res.end(enc === "br" ? brotliCompressSync(envelope) : gzipSync(envelope));
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    for (enc of ["gzip", "br"]) {
      const result = await callViaStdio(
        { OCTEN_API_URL: `http://127.0.0.1:${upstream.address().port}` },
        { query: "decode probe" }
      );
      assert.notEqual(result.isError, true,
        `${enc}-encoded body did not decode: ${result.content?.[0]?.text}`);
    }
  } finally {
    upstream.close();
  }
});

test("src/ never touches the host's fetch or its fetch classes", () => {
  // Lint-style guard. Passing global-fetch work off to the packaged dispatcher
  // is exactly the 0.4.1 bug; mixing the two families' Response / Headers /
  // Request classes is its instanceof-shaped sibling (the two are never the
  // same class, so cross-family instanceof is always false). Any new call site
  // must import from "undici" — the seam in http.ts, `fetchImpl`, already does.
  const offenders = [];
  const srcDir = path.join(ROOT, "src");
  for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(srcDir, f), "utf8");
    text.split("\n").forEach((line, i) => {
      for (const pattern of [
        /\bglobalThis\.fetch\b/,
        /\bglobal\.fetch\b/,
        // A bare call. The lookbehind rules out member calls (`.fetch(`) and
        // suffixed look-alikes (`prefetch(`); `fetchImpl(` / `undiciFetch(`
        // never match at all — no `(` right after `fetch`, and the pattern is
        // case-sensitive.
        /(?<![.\w])fetch\s*\(/,
        /\bnew\s+(Response|Headers|Request|FormData)\s*\(/,
        /instanceof\s+(Response|Headers|Request|FormData)\b/,
      ]) {
        if (pattern.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `global fetch-family usage in src/ — route it through the packaged undici:\n${offenders.join("\n")}`);
});
