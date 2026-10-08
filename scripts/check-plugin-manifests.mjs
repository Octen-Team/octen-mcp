#!/usr/bin/env node
// Asserts the Claude Code plugin manifests stay consistent with package.json.
//
// src/server.ts reads the version from package.json rather than hardcoding it,
// because a hardcoded copy drifted once (0.3.6 while the package shipped 0.3.7)
// and made the version a client reported useless for triage. The plugin
// manifests cannot read package.json at runtime, so the guard moves to CI.

import { readFileSync, existsSync } from "node:fs";
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

// The Agent Plugins manifests at the repository root serve Cursor and any other
// client that reads the open standard. They hardcode the version the same way
// the Claude ones do, so they are held to the same check.
let agentPlugin;
try {
  agentPlugin = read("plugin.json");
} catch (err) {
  problems.push(`plugin.json is missing or unparseable: ${err.message}`);
}
if (agentPlugin) {
  if (agentPlugin.version !== pkg.version) {
    problems.push(`plugin.json version is ${agentPlugin.version}, package.json is ${pkg.version}`);
  }
  if (agentPlugin.name !== plugin.name) {
    problems.push(`plugin.json name is ${agentPlugin.name}, .claude-plugin/plugin.json says ${plugin.name}`);
  }
  if (agentPlugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    problems.push("plugin.json is missing the Agent Plugins manifest $schema identifier");
  }
}

let agentMcp;
try {
  agentMcp = read("mcp.json");
} catch (err) {
  problems.push(`mcp.json is missing or unparseable: ${err.message}`);
}
if (agentMcp) {
  const s = agentMcp.mcpServers?.octen;
  if (!s) problems.push('mcp.json does not declare an "octen" server');
  else {
    // The standard names this transport streamable-http; Claude's .mcp.json says
    // http for the same endpoint. Neither spelling is valid in the other file.
    if (s.type !== "streamable-http") problems.push(`mcp.json octen.type is ${s.type}, expected streamable-http`);
    if (s.url !== "https://mcp.octen.ai/mcp") problems.push(`mcp.json octen.url is ${s.url}, expected https://mcp.octen.ai/mcp`);
    if (s.headers) problems.push("mcp.json octen carries headers; the server authenticates over OAuth");
  }
}

// Cursor reads .cursor-plugin/plugin.json in preference to the root Agent
// Plugins manifest, and carries display fields the standard has no room for.
// A fourth copy of the version is a fourth chance to drift.
let cursorPlugin;
try {
  cursorPlugin = read(".cursor-plugin/plugin.json");
} catch (err) {
  problems.push(`.cursor-plugin/plugin.json is missing or unparseable: ${err.message}`);
}
if (cursorPlugin) {
  if (cursorPlugin.version !== pkg.version) {
    problems.push(`.cursor-plugin/plugin.json version is ${cursorPlugin.version}, package.json is ${pkg.version}`);
  }
  if (cursorPlugin.name !== plugin.name) {
    problems.push(`.cursor-plugin/plugin.json name is ${cursorPlugin.name}, .claude-plugin/plugin.json says ${plugin.name}`);
  }
  // Marketplace listings resolve a relative logo against the repository, so an
  // absent file ships a broken image rather than failing anything at install.
  if (cursorPlugin.logo && !cursorPlugin.logo.startsWith("http")) {
    if (!existsSync(ROOT + cursorPlugin.logo)) {
      problems.push(`.cursor-plugin/plugin.json logo ${cursorPlugin.logo} is not in the repository`);
    }
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
