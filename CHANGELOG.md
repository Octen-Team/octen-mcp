# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] — 2026-05-20

### Changed
- Align `mcpName` in `package.json` with the canonical GitHub
  organization name (`io.github.Octen-Team/octen-mcp`), required by the
  MCP Registry's case-sensitive ownership check.

## [0.1.4] — 2026-05-20

### Changed
- Tool response is now a single markdown text block instead of a compact
  summary followed by the entire raw JSON. Some models (Claude included)
  would otherwise reach for `jq` / file_search to dig through the JSON
  dump just to find a title — wasted turns and a worse UX. Markdown gives
  the model the structured info (title, category, page_structure,
  highlights/full_content) ready to use.

## [0.1.3] — 2026-05-20

### Added
- `mcpName` field in `package.json` (`io.github.octen-team/octen-mcp`),
  required by the official MCP Registry to link the npm package to a
  registry entry.

## [0.1.2] — 2026-05-20

### Changed
- VS Code install button now prompts for the API key on click (no manual JSON
  editing needed). Added a VS Code Insiders variant alongside.
- Removed the Cursor install button. Cursor's deeplink format can't pre-prompt
  for credentials, so the manual JSON config block is the canonical path now.

## [0.1.1] — 2026-05-20

### Fixed
- Align the MCP server's self-reported name (in the `initialize` handshake and
  startup log) with the published package name `octen-mcp`.

## [0.1.0] — 2026-05-20

### Added
- Initial release.
- `extract` tool wrapping Octen Extract API (`POST https://api.octen.ai/extract`).
- Supports `urls`, `query`, `max_age_seconds`, `format`, `timeout`, `include_images`,
  `include_videos`, `include_audio`, `include_favicon`.
- Surfaces Octen-unique response fields: `category`, `page_structure`, `highlights`.
- stdio transport (works with Claude Desktop, Cursor, Claude Code, Windsurf).
- `OCTEN_API_KEY` env var for authentication.
- `OCTEN_API_URL` override for staging or self-hosted endpoints.

[Unreleased]: https://github.com/Octen-Team/octen-mcp/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.5
[0.1.4]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.0