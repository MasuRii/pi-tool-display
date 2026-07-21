# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added `preserveCallRenderer` for custom tool overrides that should retain a useful native call header while compacting or hiding only result output.

### Fixed
- Decorate tools registered by later-loaded extensions before Pi snapshots their definitions.
- Track decorated tool objects by identity and restore interception state across reloads and defensive double loads.

## [0.5.0] - 2026-07-03

### Added
- Added an `enabled` config toggle that gates tool override registration, with reload cleanup that disposes overrides and patches on `session_shutdown`. ([c78163d](https://github.com/MasuRii/pi-tool-display/commit/c78163dddc0f94b7a542d2d1e01109c903bc70cc))
- Added regression coverage for the active backlog: expanded large-diff rendering in constrained tmux-style panes (#23) and the esbuild lockfile bump from PR #24. ([7e46231](https://github.com/MasuRii/pi-tool-display/commit/7e4623191583f31a056602d8a08f1a4a7accd8b6))

### Changed
- Widened Pi coding-agent and Pi TUI peer dependency ranges through `^0.80.0` and added a `postinstall` patch with npm `overrides` to resolve known vulnerabilities in transitive dependencies. ([5f753a9](https://github.com/MasuRii/pi-tool-display/commit/5f753a9407fca6c2a7463d90eede01ce056c7bbc))
- Extracted render helpers and consolidated tool override logic to reduce inline duplication. ([3239d7a](https://github.com/MasuRii/pi-tool-display/commit/3239d7a825fe14e5cdcac86c75dd4b21aec0018c))
- Updated the lockfile-resolved `esbuild` dependency from `0.28.0` to `0.28.1` via Dependabot PR #24. ([caf65f2](https://github.com/MasuRii/pi-tool-display/commit/caf65f209c49ddcfc8362ff95c58a6a91cd1ba03))
- Updated README badge styling and added a ko-fi support button. ([2094fb6](https://github.com/MasuRii/pi-tool-display/commit/2094fb64ca4e79ff7d947d0f8be2f2d9ea967fe2))

### Fixed
- Capped expanded edit/write diff bodies with the existing `expandedPreviewMaxLines` setting and a visible omission hint so large diffs stay bounded in small tmux panes (#23). Thanks to @jmikedupont2 for reporting. ([7e46231](https://github.com/MasuRii/pi-tool-display/commit/7e4623191583f31a056602d8a08f1a4a7accd8b6))

## [0.4.3] - 2026-06-16

### Added
- Added `customToolOverrides` for explicit opt-in rendering of non-built-in extension tools, with `generic` as the default kind and optional `mcp` rendering for MCP proxy-style arguments.
- Added custom tool override coverage for malformed config, output modes, late tool registration, argument shapes, and runtime contract preservation.

### Changed
- Preserved configured MCP output mode even when MCP tools are not detected at startup, so dynamically registered MCP tools can still be decorated later.

### Fixed
- Bash tool display overrides now preserve Pi `settings.json` shell settings (`shellPath` and `shellCommandPrefix`) when rebuilding the bash tool.

## [0.4.2] - 2026-06-01

### Changed
- Deferred config modal, settings inspector, and built-in tool metadata loading until needed to reduce startup work.
- Replaced shared agent-directory lookup with a local `PI_CODING_AGENT_DIR`-aware resolver for config and capability checks.
- Widened peer dependency ranges to `^0.74.0 || ^0.75.0 || ^0.77.0 || ^0.78.0`.

### Fixed
- Corrected classic-mode diff line-number gutter spacing.

## [0.4.1] - 2026-05-26

### Added
- Reload-safe extension lifecycle: `src/disposable.ts` cleanup registry that disposes all tool overrides, prototype patches, timers, and event handlers on `session_shutdown(reason: "reload")`, preventing orphaned pi-mono default rendering after `/reload`.
- Comprehensive test suite with 15 new test files covering reload behavior, bash display, MCP overrides, ANSI utilities, diff renderer edge cases, user message boxes, thinking labels, render utilities, and integration tests (696 total tests, up from 68).

### Fixed
- Bash display now respects `shellPath` and `commandPrefix` from `settings.json` when present (#21).
- Bash spinner timer reworked to use toolCallId-keyed Map instead of `__piToolDisplayBashSpinner`, with interval reduced from 80ms to 200ms, defensive `invalidate()` check, and all timers registered in the cleanup registry (#19).
- Bash override registration is now deferred (like read/grep/edit) and uses `before_agent_start` to discover ownership via `pi.getAllTools()` before overriding, preventing conflicts with other extensions (#17). Thanks to @iwinux for reporting.
- `pi.registerTool` is now intercepted to decorate MCP tools as they register, eliminating a race condition where `session_start`/`before_agent_start` fire before `pi-mcp-adapter` finishes registering tools (#15, #18). Thanks to @dashanlkk for reporting and opening PR #18.
- `isMcpToolCandidate()` heuristics expanded to match `mcp`, `mcp_*`, `*_mcp`, names containing `server:` or starting with `ctx_`, and parameter schemas containing `mcpServer`, `serverUrl`, or `server_name`, catching many MCP servers that were previously false negatives.
- `stripBackgroundSgrParams()` now correctly preserves foreground RGB sequences like `38;2;12;49;200m` instead of misinterpreting color component `49` as a background reset (#8, #3). Thanks to @michaelrommel for the patch and @w-winter for reporting.
- `patchUserMessageRenderPrototype` now restores stale patches from prior extension instances before re-patching, and `registerNativeUserMessageBox` has a duplicate-prevention guard with `session_shutdown` restoration (#10). OSC 133 stripping is now scoped to prompt-control sequences only; OSC 8 hyperlinks are preserved. Thanks to @w-winter for reporting.
- Thinking label duplicate-prevention guard prevents re-registering event handlers across reloads; `session_shutdown(reason: "reload")` resets the guard so re-registration works after reload; recursive nested-array handling added for malformed thinking content (#2). Thanks to @agustif for PR #2.
- `registerDeferredBuiltInToolOverrides()` is now also called on `session_start` (not just `before_agent_start`), fixing a reload bug where read/grep/edit/bash tools fell back to default pi-mono rendering.

## [0.4.0] - 2026-05-22

### Added
- Added the `./tool-display-api-consumer` subpath export so other extensions can decorate tool definitions through the runtime tool-display API or queue decorations until `pi-tool-display` is loaded.
- Added hashline-anchor-aware diff rendering so read/edit anchor lines can display their `LINE#HASH` labels in the diff gutter.

### Changed
- Deferred built-in tool override registration until the built-in owner is available and refreshed cached built-in tools on session lifecycle changes.
- Redacted secret-like debug payload values and switched debug writes to asynchronous buffered file logging.

## [0.3.6] - 2026-05-04

### Added
- Documented the `debug` config flag for opt-in file diagnostics under the runtime-created `debug/` directory with terminal debug output kept disabled.
- Added regression coverage for config store isolation, pending diff preview safety, tool override registration, presets, and thinking label rendering.

### Changed
- Scoped projected pending edit and write previews to the active workspace before reading files, with clear fallback notices when previews cannot be resolved safely.
- Shared ANSI sanitization and width-safety helpers across diff and user message rendering for more consistent narrow-pane output.

### Fixed
- Hardened pending write metadata tracking so preview and execution state do not leak across tool call lifecycles.
- Improved tool override preview reads and write state handling for safer partial-render updates.

## [0.3.5] - 2026-04-27

### Changed
- Removed the deleted bundled screenshot asset from published package contents and removed the corresponding README project-structure reference to `assets/pi-tool-display.png`.

## [0.3.4] - 2026-04-24

### Added
- Added projected pending diff previews for partial `edit` and `write` tool calls so the TUI can show `pending edit`, `pending overwrite`, and `pending create` diffs before execution finishes
- Added preview fallback notices when projected edit previews cannot be resolved deterministically from the current file contents

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to `^0.70.2`
- Diff renderer write headers now support contextual action labels so pending previews can display `pending edit`, `pending overwrite`, and `pending create`

### Fixed
- Restored native user message box spacing on recent Pi releases by extracting markdown through the newer nested `Box` wrapper and stripping OSC 133 prompt markers from fallback content normalization
- Limited fallback OSC stripping to OSC 133 prompt markers so OSC 8 hyperlinks and other non-prompt OSC sequences remain intact in user message rendering

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
