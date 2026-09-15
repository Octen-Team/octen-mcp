#!/usr/bin/env node
// Asserts the Claude Code plugin manifests stay consistent with package.json.
//
// src/server.ts reads the version from package.json rather than hardcoding it,
// because a hardcoded copy drifted once (0.3.6 while the package shipped 0.3.7)
// and made the version a client reported useless for triage. The plugin
// manifests cannot read package.json at runtime, so the guard moves to CI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(ROOT + p, "utf8"));
const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");

const problems = [];

if (!market.plugins?.length) problems.push(".claude-plugin/marketplace.json lists no plugins");

for (const [label, got] of [
  [".claude-plugin/plugin.json version", plugin.version],
  [".claude-plugin/marketplace.json metadata.version", market.metadata?.version],
]) {
  if (got !== pkg.version) problems.push(`${label} is ${got}, package.json is ${pkg.version}`);
}

// Every entry, not just the first: a second one added later would otherwise
// drift from package.json unnoticed.
for (const [i, entry] of (market.plugins ?? []).entries()) {
  const at = `.claude-plugin/marketplace.json plugins[${i}]`;
  if (entry.version !== pkg.version) {
    problems.push(`${at}.version is ${entry.version}, package.json is ${pkg.version}`);
  }
  // `source` is what install resolution reads; without it `claude plugin install
  // octen@octen` — the command README.md hands users — cannot resolve the plugin.
  if (!entry.source) problems.push(`${at} is missing source`);
  // The plugin's own .mcp.json is the single source of truth for the server. A
  // second copy inline here has undocumented precedence and has to be kept
  // byte-identical by hand.
  if (entry.mcpServers) {
    problems.push(`${at} declares mcpServers; the plugin's .mcp.json already does`);
  }
}

for (const field of ["name", "description", "version", "author", "license"]) {
  if (!plugin[field]) problems.push(`.claude-plugin/plugin.json is missing ${field}`);
}

// CI never opened .mcp.json, so a bad merge or a renamed server key shipped a
// plugin with no MCP server at all — and renaming it silently detaches every
// mock under evals/mocks/<server>/.
let mcp;
try {
  mcp = read(".mcp.json");
} catch (err) {
  problems.push(`.mcp.json is missing or unparseable: ${err.message}`);
}
if (mcp) {
  const server = mcp.mcpServers?.octen;
  if (!server) problems.push('.mcp.json does not declare an "octen" server; evals/mocks/octen/ is keyed on that name');
  else {
    if (server.type !== "http") problems.push(`.mcp.json octen.type is ${server.type}, expected http`);
    // Exact, with no query string. The OAuth token audience is validated against
    // this URL and clients key stored credentials on it, so a decorated URL makes
    // anyone who already signed in through the README's `claude mcp add` sign in
    // a second time for the same server.
    if (server.url !== "https://mcp.octen.ai/mcp") {
      problems.push(`.mcp.json octen.url is ${server.url}, expected https://mcp.octen.ai/mcp with no query string`);
    }
    if (server.headers || server.env) {
      problems.push(".mcp.json octen carries credentials; the server authenticates over OAuth");
    }
  }
}

if (problems.length) {
  console.error("plugin manifest check failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`plugin manifests consistent at ${pkg.version}`);
