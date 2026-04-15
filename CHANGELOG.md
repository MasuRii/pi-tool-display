# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-04-15

### Added
- `diffIndicatorMode` config option with three styles: `bars` (persistent vertical indicators), `classic` (+/- markers on first row only), and `none` (no indicator column)
- Config modal dropdown for diff indicator style selection under "Diff indicators" setting

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to `^0.67.2`
- Config path resolution now uses `getAgentDir()` API to correctly respect `PI_CODING_AGENT_DIR` environment variable (thanks to @tynanbe for PR #6)
- Diff renderer now supports mode-aware indicator glyph resolution (bars, classic, none)
- Line prefix width calculations adjusted per indicator mode for accurate diff column alignment
- Removed unused `session_switch` listener from native user message box registration
- Added top margin line to native user message box rendering (thanks to @w-winter for the suggestion)
- Rebalanced diff row and inline emphasis background mixing for more consistent added/removed line readability

### Fixed
- Diff indicator markers now render correctly across all indicator modes with proper continuation handling
- Classic mode now shows +/- only on first visual row, with spacing on wrapped continuation lines
- Corrected ANSI background reset detection so RGB color sequences containing component value `49` no longer break inline diff emphasis background rendering (thanks to @michaelrommel for reporting issue #8)

## [0.3.1] - 2026-04-01

### Changed
- Updated npm keywords and package metadata for improved discoverability
- Added Related Pi Extensions cross-linking section to README

## [0.3.0] - 2026-04-01

### Added
- `prepareArguments` delegate support for built-in tool overrides (read, grep, find, ls, edit, write, bash)
- `buildPromptSnippetFromDescription()` helper to derive prompt snippets from MCP tool descriptions
- MCP proxy prompt metadata (`MCP_PROXY_PROMPT_SNIPPET`, `MCP_PROXY_PROMPT_GUIDELINES`) for tool registration
- Write execution metadata tracking via tool call ID for accurate diff rendering across execution lifecycle
- `applyLineBackgroundToWidth()` helper for consistent line background handling in diff renderer

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.64.0
- Refactored tool-overrides to use context-based argument extraction instead of closure state
- Improved diff renderer width handling with cleaner background reset logic
- Simplified continuation prefix rendering by removing unnecessary row background parameters
- Enhanced MCP proxy tool registration with proper prompt metadata propagation

### Fixed
- Write diff rendering now correctly tracks previous content and file existence state across render phases
- Tool call rendering now uses context-based state instead of global mutable state

### Tests
- Added tests for diff renderer width handling with line backgrounds
- Added tests for tool-overrides configuration and prepareArguments delegation

## [0.2.0] - 2026-03-24

### Added
- `bashOutputMode` config option with three modes: `opencode` (classic collapse), `summary` (line count only), `preview` (show lines)
- Live bash preview with spinner animation and elapsed time during command execution
- `bash-display.ts` module for bash call rendering with spinner state management
- `modal-icons.ts` module for Nerd Font detection and modal icon sets (`PI_NERD_FONTS` and `POWERLINE_NERD_FONTS` env vars)
- `settings-inspector-modal.ts` module with split-pane inspector UI (category list + setting details)
- Search icon in settings inspector modal filter hint (Nerd Font `\uF002` or emoji `🔍`)

### Changed
- Settings modal now uses split-pane inspector with setting descriptions, summaries, and advanced notes
- Modal width increased to accommodate split-pane layout (wider terminals get more space)
- `showTruncationHints` config now defaults to `false`
- `showRtkCompactionHints` config now defaults to `false`
- Bash output now supports different rendering modes controlled by `bashOutputMode`
- Refactored config modal to use new inspector modal component instead of legacy settings modal

### Config
- Added `bashOutputMode: "opencode" | "summary" | "preview"` to config schema
- Updated example config to demonstrate new `bashOutputMode` option
- Presets now include appropriate `bashOutputMode` values ("summary" for compact, "preview" for verbose)

### Tests
- Added comprehensive tests for bash output modes (opencode, summary, preview)
- Added test coverage for spinner state management and elapsed time formatting
- Added tests for modal icon detection with various terminal environments

## [0.1.12] - 2026-03-23

### Added
- `tool-metadata.ts` module with shared utilities: `toRecord`, `getTextField`, `isMcpToolCandidate`, `extractPromptMetadata`
- `cloneToolParameters` function to deep-copy built-in tool parameter schemas for extension renderers
- Comprehensive tests for MCP detection, config guards, output modes, and metadata cloning
- Plural label support in search summaries
- Conditional truncation hints via `showTruncationHints` config (defaults to `false`)
- Keywords for better npm discoverability: `hide`, `collapse`, `truncate`, `compact`, `diff`, `output-mode`

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.62.0
- Extracted shared utilities to dedicated `tool-metadata.ts` module for reuse across capabilities and tool-overrides
- Refactored tool-overrides to preserve `promptSnippet` and `promptGuidelines` on overridden read, edit, and write tools
- Improved diff renderer with accurate line number tracking and line number delta calculation for proper hunk tracking
- Removed Windows path normalization from system prompt sanitizer working-directory handling
- Simplified system prompt sanitizer to only handle documentation removal
- Enhanced package description to highlight hide/collapse/truncate capabilities for better npm discovery

### Tests
- Added test suites for diff renderer numbering and wrap handling
- Added tests for tool-overrides config and registration behavior
- Added tests for capabilities module with MCP detection scenarios

## [0.1.11] - 2026-03-13

### Changed
- Refactored `sequenceAffectsBackground` to `sequenceResetsBackground` with simpler logic that only detects background reset sequences (codes 0 and 49)

### Tests
- Added test coverage for diff-renderer width handling

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
