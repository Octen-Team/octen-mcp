/**
 * GET /.well-known/openai-apps-challenge — plugin-directory domain
 * verification (built output).
 *
 * The endpoint is anonymous BY DESIGN, like the PRM: it serves a random
 * token the directory generated for us — not a secret of ours — so the
 * directory can confirm we control the host. It must answer 404 until the
 * operator configures the token, serve EXACTLY the token as plain text
 * (no JSON, no token lists), and its presence must not loosen the MCP
 * endpoint's own auth in any way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startHttp, rpc, call } from "./helpers.mjs";

const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

test("challenge path answers 404 when no token is configured", async () => {
  const srv = await startHttp();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}${CHALLENGE_PATH}`);
    assert.equal(res.status, 404);
  } finally { srv.stop(); }
});

test("challenge path serves exactly the configured token as plain text", async () => {
  const srv = await startHttp({ OCTEN_APPS_CHALLENGE_TOKEN: "tok-abc123" });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}${CHALLENGE_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await res.text(), "tok-abc123");
  } finally { srv.stop(); }
});

test("a whitespace-only token is treated as unconfigured", async () => {
  const srv = await startHttp({ OCTEN_APPS_CHALLENGE_TOKEN: "   " });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}${CHALLENGE_PATH}`);
    assert.equal(res.status, 404);
  } finally { srv.stop(); }
});

test("POST on the challenge path is not served", async () => {
  const srv = await startHttp({ OCTEN_APPS_CHALLENGE_TOKEN: "tok-abc123" });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}${CHALLENGE_PATH}`, { method: "POST" });
    assert.notEqual(res.status, 200);
  } finally { srv.stop(); }
});

test("configuring the challenge token does not loosen tool-call auth", async () => {
  const srv = await startHttp({ OCTEN_APPS_CHALLENGE_TOKEN: "tok-abc123" });
  try {
    // Header-auth mode rejects an uncredentialed call in-band (isError);
    // OAuth deployments reject at the transport with 401. Either way the
    // call must not succeed just because the challenge route exists.
    const { status, msg } = await rpc(srv.port, call(1, "who is the CTO of octen"));
    assert.equal(status, 200);
    assert.equal(msg.result.isError, true, "an uncredentialed tools/call must still be rejected");
    assert.match(msg.result.content[0].text, /No API key/);
  } finally { srv.stop(); }
});
