#!/usr/bin/env node
/**
 * Octen MCP server — stdio entry.
 *
 * Transport: stdio (Claude Desktop / Claude Code / Cursor compatible). The
 * server itself is assembled in `server.ts`, shared with the HTTP entry
 * (`httpServer.ts`); this file only supplies what is stdio-specific — one user,
 * whose API key comes from the environment.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createOctenServer, VERSION } from "./server.js";

const server = createOctenServer({
  getApiKey: () => process.env.OCTEN_API_KEY,
  transport: "stdio",
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: do NOT console.log to stdout here — stdout is the MCP wire.
  // Use console.error for any startup logging.
  console.error(`[octen-mcp] v${VERSION} started, listening on stdio`);
}

main().catch((err) => {
  console.error("[octen-mcp] fatal:", err);
  process.exit(1);
});
