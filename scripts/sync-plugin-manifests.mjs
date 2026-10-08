#!/usr/bin/env node
// Writes package.json's version into every plugin manifest.
//
// Five hand-maintained copies of one version is five chances to drift, and
// check-plugin-manifests.mjs could only report the drift after the fact —
// leaving whoever ran `npm version` to fix four JSON files by hand and push
// again. This closes the loop: `npm version` runs it, so the manifests move
// with the package.
//
//   node scripts/sync-plugin-manifests.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(ROOT + p, "utf8"));
const write = (p, d) => writeFileSync(ROOT + p, JSON.stringify(d, null, 2) + "\n");

const { version } = read("package.json");
const changed = [];

for (const p of [".claude-plugin/plugin.json", "plugin.json", ".cursor-plugin/plugin.json"]) {
  const d = read(p);
  if (d.version !== version) { d.version = version; write(p, d); changed.push(p); }
}

const market = read(".claude-plugin/marketplace.json");
let marketChanged = false;
if (market.metadata?.version !== version) { market.metadata.version = version; marketChanged = true; }
for (const e of market.plugins ?? []) {
  if (e.version !== version) { e.version = version; marketChanged = true; }
}
if (marketChanged) { write(".claude-plugin/marketplace.json", market); changed.push(".claude-plugin/marketplace.json"); }

console.log(changed.length
  ? `synced to ${version}: ${changed.join(", ")}`
  : `already at ${version}`);
