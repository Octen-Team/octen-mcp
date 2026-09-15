#!/usr/bin/env node
// Asserts the Claude Code plugin manifests stay consistent with package.json.
//
// src/server.ts reads the version from package.json rather than hardcoding it,
// because a hardcoded copy drifted once (0.3.6 while the package shipped 0.3.7)
// and made the version a client reported useless for triage. The plugin
// manifests cannot read package.json at runtime, so the guard moves to CI.

import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");
const entry = market.plugins?.[0];

const problems = [];

for (const [label, got] of [
  [".claude-plugin/plugin.json version", plugin.version],
  [".claude-plugin/marketplace.json metadata.version", market.metadata?.version],
  [".claude-plugin/marketplace.json plugins[0].version", entry?.version],
]) {
  if (got !== pkg.version) problems.push(`${label} is ${got}, package.json is ${pkg.version}`);
}

// The plugin's own .mcp.json is the single source of truth for the server. A
// second copy inline in the marketplace entry has undocumented precedence and
// has to be kept byte-identical by hand.
if (entry?.mcpServers) {
  problems.push("marketplace entry declares mcpServers; the plugin's .mcp.json already does");
}

for (const field of ["name", "description", "version", "author", "license"]) {
  if (!plugin[field]) problems.push(`.claude-plugin/plugin.json is missing ${field}`);
}

if (problems.length) {
  console.error("plugin manifest check failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`plugin manifests consistent at ${pkg.version}`);
