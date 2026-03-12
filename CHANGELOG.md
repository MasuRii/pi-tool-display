# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.10] - 2026-03-13

### Fixed
- Add npm override for file-type >=21.3.1 to resolve CVE (infinite loop in ASF parser)

## [0.1.9] - 2026-03-13

### Added
- Write overwrite diff guard to skip expensive diff computation for large files (4000+ lines or 1M+ cells)
- Cached user message markdown renderer to avoid rebuilding markdown for large content on every render
- Configurable limits for user message markdown (100K characters, 2000 lines)

### Changed
- Improved performance for large write operations by using approximate stats instead of computing full diff
- User message markdown now bypasses rebuild for extremely large content (>100K chars or >2000 lines)
- Optimized write diff rendering to defer detailed data computation until actually needed

### Fixed
- Prevented UI slowdown on very large file writes by showing guard message instead of computing expensive diffs
- Avoided redundant markdown parser instantiation for repeated renders of the same user message

## [0.1.8] - 2026-03-12

### Changed
- Extracted diff presentation logic into dedicated `diff-presentation.ts` module with `DiffPresentationMode`, `buildDiffSummaryText`, `normalizeDiffRenderWidth`, and `resolveDiffPresentationMode` utilities
- Improved compact line rendering with dedicated marker and prefix functions
- Added width-safe diff rendering utilities for consistent terminal width handling

## [0.1.7] - 2026-03-07

### Added
- Added line-width safety utilities for diff rendering so collapsed and expanded diff output can be clamped to the current pane width.
- Added utility test coverage for write display helpers, native user message box helpers, and narrow-width diff hint behavior.

### Changed
- Updated README documentation to reflect the current command surface, config model, width-safe diff behavior, native user message box pipeline, and project structure.
- Refactored native user message box rendering into focused markdown, patching, renderer, and ANSI/background utility modules.

### Fixed
- Prevented diff rendering and collapsed diff hints from overflowing narrow terminal widths by progressively shortening hint text and clamping rendered lines.
- Preserved inline `write` call summaries with line-count and byte-size metadata when content is available.
- Prevented thinking label presentation changes from leaking into future assistant context by sanitizing stored thinking blocks during the `context` extension event.
- Hardened thinking label normalization to strip ANSI residue fragments such as `38;5;208m` before display formatting.
- Restored final-message thinking label persistence on `message_end` so themed labels remain consistent after streaming and across session reloads.
- Improved native user message box rendering so markdown content, ANSI-only blank lines, and background fill behave more consistently.

## [0.1.6] - 2026-03-04

### Fixed
- Use absolute GitHub raw URL for README image to fix npm display

## [0.1.5] - 2026-03-04

### Added
- Thinking labels feature that prefixes AI reasoning blocks with themed "Thinking:" labels for better readability

### Changed
- Rewrote README.md with professional documentation standards
- Added comprehensive feature documentation, configuration reference, and usage examples
- Simplified settings modal by removing less-used advanced options (expandedPreviewMaxLines, diffSplitMinWidth, diffCollapsedLines, tool ownership toggles)

## [0.1.4] - 2026-03-02

### Added
- Auto-detection of MCP and RTK capabilities to conditionally expose related UI/config controls.

### Changed
- `/tool-display` modal now hides MCP settings when MCP tooling is unavailable.
- `/tool-display` modal now hides RTK compaction hint settings when RTK optimizer is unavailable.
- Runtime rendering now force-disables MCP output mode and RTK hint rendering when those capabilities are unavailable.
- Native user message box is now user-configurable via `enableNativeUserMessageBox` in config and `/tool-display` settings.

## [0.1.3] - 2026-03-02

### Added
- Added per-tool ownership config via `registerToolOverrides` for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` so users can avoid tool ownership conflicts with other extensions.
- Added settings modal toggles for built-in tool ownership and `/reload` guidance when ownership changes.
- Added backward-compatible config migration from legacy `registerReadToolOverride` to `registerToolOverrides.read`.

### Changed
- Built-in tool override registration is now conditional per tool based on ownership settings.
- Updated README configuration/troubleshooting docs for multi-tool extension compatibility.

## [0.1.2] - 2026-03-01

### Fixed
- Corrected `write` call rendering state handling so path changes without new content no longer reuse stale line/size metadata from previous writes.
- Restored write call suffix rendering (`(X lines, Y)`) when content is available, improving call summary consistency.

## [0.1.1] - 2026-03-01

### Changed
- Reorganized repository layout to a cleaner package structure:
  - moved implementation modules to `src/`
  - moved screenshot assets to `assets/`
  - moved example config to `config/`
  - kept root `index.ts` as stable Pi auto-discovery entrypoint.
- Simplified TypeScript build command to use `tsconfig.json` project mode.
- Updated README installation heading now that npm package is published.

## [0.1.0] - 2026-03-01

### Added
- Public repository scaffolding (`README.md`, `LICENSE`, `CHANGELOG.md`, `.gitignore`, `.npmignore`).
- Package metadata for public distribution (`keywords`, `files`, `license`, `publishConfig`, engine constraints).
- Vendored `zellij-modal.ts` to keep this extension self-contained as a standalone repository.

### Changed
- Updated `config-modal.ts` to use local `zellij-modal.ts` import.
- Updated build script to include `zellij-modal.ts`.
