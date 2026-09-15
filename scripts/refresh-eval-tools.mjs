#!/usr/bin/env node
// Regenerates evals/mocks/octen/_tools.json from this repo's own build.
//
// The eval suite serves mocked tools to the model; without a schema roster they
// arrive with no description and the model never calls them. Capturing that
// roster from the hosted deployment would make the suite grade routing against
// whatever is deployed rather than what this repo ships, so it is generated
// from dist/ and CI asserts the checked-in copy still matches.
//
//   npm run build && node scripts/refresh-eval-tools.mjs [--check]

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "evals/mocks/octen/_tools.json";
const check = process.argv.includes("--check");

const handshake = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "refresh-eval-tools", version: "1.0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m)).join("\n") + "\n";

// Beta tools are hidden unless the host opts in. The eval roster should carry
// every tool the skills can route to, so ask for all of them.
const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, OCTEN_API_KEY: "refresh-eval-tools", OCTEN_ENABLE_BETA_TOOLS: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.end(handshake);

let out = "";
for await (const chunk of child.stdout) out += chunk;

const listed = out
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((m) => m.id === 2);

if (!listed?.result?.tools?.length) {
  console.error("no tools/list response; run `npm run build` first");
  process.exit(1);
}

const next = JSON.stringify({ tools: listed.result.tools }, null, 2) + "\n";

if (check) {
  const current = readFileSync(OUT, "utf8");
  if (current !== next) {
    console.error(`${OUT} is stale — run \`node scripts/refresh-eval-tools.mjs\` and commit the result`);
    process.exit(1);
  }
  console.log(`${OUT} matches the built server (${listed.result.tools.length} tools)`);
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT} (${listed.result.tools.length} tools)`);
}
