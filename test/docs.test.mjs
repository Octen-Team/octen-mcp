/**
 * Documentation that goes stale is worse than absent: a reader who finds a
 * variable table trusts it to be the whole list.
 *
 * This started as a real gap — the HTTP transport and the OAuth work between
 * them added eleven environment variables, and none of the eleven reached the
 * README. Nothing failed, so nobody noticed. The check below is the cheapest
 * thing that would have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every environment variable name `src/` reads. */
function envNamesInSource() {
  const found = new Set();
  for (const f of readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(path.join(root, "src", f), "utf8");
    // `process.env.NAME`, `process.env["NAME"]`, and the envInt/envFlag helpers.
    for (const re of [
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
      /env(?:Int|Flag|FlagDefaultOn)\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
    ]) {
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
  }
  return found;
}

/**
 * Variables deliberately kept out of the README, each with the reason.
 *
 * The bar is narrow: the variable configures how *this project's own*
 * deployment is wired, so documenting it would put an operations detail in
 * front of every reader of a public package, and nobody installing `octen-mcp`
 * could act on it. A knob a self-hoster would reach for does not qualify,
 * however deployment-flavoured it looks — `OCTEN_DRAIN_TIMEOUT_MS` names
 * Kubernetes and still belongs in the table.
 *
 * Entries are reasons, not names, so adding one means writing the reason down
 * where a reviewer sees it.
 */
const UNDOCUMENTED = {
  OCTEN_MCP_FRONT_DOOR_ID:
    "names the front door in front of the hosted deployment; an operations " +
    "detail of running mcp.octen.ai, not a setting a reader of this package has.",
};

test("every environment variable the code reads is documented in the README", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const undocumented = [...envNamesInSource()]
    .filter((n) => !readme.includes(`\`${n}\``))
    .filter((n) => !(n in UNDOCUMENTED))
    .sort();
  assert.deepEqual(undocumented, [],
    "these are read by src/ but absent from the README's variable tables");
});

test("an exemption is dropped once the variable is documented after all", () => {
  // Otherwise the list only ever grows, and an entry that stopped applying
  // silently keeps a variable out of the check it should now be under.
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  for (const name of Object.keys(UNDOCUMENTED)) {
    assert.equal(readme.includes(`\`${name}\``), false,
      `${name} is in the README now — remove it from UNDOCUMENTED`);
  }
});

test("an exemption is dropped once the code stops reading the variable", () => {
  const read = envNamesInSource();
  for (const name of Object.keys(UNDOCUMENTED)) {
    assert.equal(read.has(name), true,
      `nothing in src/ reads ${name} — remove it from UNDOCUMENTED`);
  }
});

test("the documented hosted endpoint is the one this server actually advertises", () => {
  // Replaces an earlier test that forbade naming the endpoint at all, back
  // when it did not resolve. Now that it does, the risk inverts: a README that
  // names a *different* URL than the deployment's `OCTEN_MCP_RESOURCE` sends
  // clients to fetch protected-resource metadata that will not match their
  // token's audience, and RFC 8707 compares that byte-for-byte.
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /https:\/\/mcp\.octen\.ai\/mcp/, "the hosted endpoint should be documented");
  const urls = [...readme.matchAll(/https:\/\/mcp\.octen\.ai[^\s`"')\]]*/g)].map((m) => m[0]);
  for (const u of urls) {
    assert.match(u, /^https:\/\/mcp\.octen\.ai(\/mcp(\/oauth)?(\?[^\s]*)?|\/\.well-known\/[^\s]*)?$/,
      `${u} is not a path this server serves — /mcp, /mcp/oauth and the well-knowns are`);
  }
});
