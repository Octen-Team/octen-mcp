/**
 * Every advertised tool must carry explicit MCP tool annotations.
 *
 * Plugin-directory review requires explicit `readOnlyHint` / `openWorldHint` /
 * `destructiveHint` values on every MCP tool, and tool scanners surface
 * missing annotation metadata as findings. Every Octen tool is a read-only
 * query against the open web: it fetches and never mutates external state.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The tool modules read OCTEN_API_KEY at import time — set it before importing.
process.env.OCTEN_API_KEY = process.env.OCTEN_API_KEY ?? "test-key";

const { searchTool, newsSearchTool, broadSearchTool } = await import("../dist/search.js");
const { extractTool } = await import("../dist/extract.js");
const { imageSearchTool } = await import("../dist/imageSearch.js");
const { videoSearchTool } = await import("../dist/videoSearch.js");
const { ToolSchema } = await import("@modelcontextprotocol/sdk/types.js");

const tools = [
  searchTool,
  newsSearchTool,
  broadSearchTool,
  extractTool,
  imageSearchTool,
  videoSearchTool,
];

test("the annotation roster covers every advertised tool", () => {
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["broad_search", "extract", "image_search", "news_search", "search", "video_search"],
  );
});

for (const tool of tools) {
  test(`${tool.name} declares read-only, open-world, non-destructive annotations`, () => {
    assert.ok(tool.annotations, `${tool.name} must declare annotations`);
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations.openWorldHint, true, `${tool.name} openWorldHint`);
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} destructiveHint`);
    // The shape must be valid per the MCP spec, not just truthy.
    ToolSchema.parse(tool);
  });
}
