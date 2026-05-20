# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-05-20

### Fixed
- Server self-reported name in `initialize` response was `@octen/mcp-fetch` (a leftover
  from an earlier scoped-package draft). Now correctly reports `octen-mcp`, matching
  the published npm package name. Same fix applied to the stderr startup banner.

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

[Unreleased]: https://github.com/Octen-Team/octen-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Octen-Team/octen-mcp/releases/tag/v0.1.0