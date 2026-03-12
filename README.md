# pi-tool-display

OpenCode-style tool rendering for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-tool-display` keeps tool calls compact by default, adds richer diff rendering for file edits, and improves a few core chat UI details such as thinking labels and the native user prompt box.

![Screenshot](https://raw.githubusercontent.com/MasuRii/pi-tool-display/main/assets/pi-tool-display.png)

<img width="978" height="670" alt="image" src="https://github.com/user-attachments/assets/122b69ce-6c99-4aaa-ba93-236f97a1d8b4" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/7d5e36d3-cbe1-4d54-8bed-ae3dbdef870c" />
<img width="1919" height="566" alt="image" src="https://github.com/user-attachments/assets/68a1619b-62da-480f-8de3-2af441ccf6ff" />
<img width="1919" height="550" alt="image" src="https://github.com/user-attachments/assets/1d3f0b38-a5b5-47fc-b54b-8b55cc2bfaf1" />

## Features

- **Compact built-in tool rendering** for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- **MCP-aware rendering** with hidden, summary, and preview modes
- **Adaptive edit/write diffs** with split or unified layouts, syntax highlighting, inline emphasis, and narrow-pane width clamping
- **Progressive collapsed diff hints** that shorten automatically on small terminal widths instead of overflowing
- **Three presets**: `opencode`, `balanced`, and `verbose`
- **Thinking labels** during streaming and final message rendering, with context sanitization to avoid leaking presentation labels back into future model turns
- **Optional native user message box** with markdown-aware rendering and safer ANSI/background handling
- **Per-tool ownership toggles** so this extension can coexist with other renderer extensions
- **Capability-aware settings** that automatically hide MCP and RTK-specific controls when those features are unavailable

## Installation

### Local extension folder

Place this folder in one of Pi's auto-discovery locations:

```text
# Global (all projects)
~/.pi/agent/extensions/pi-tool-display

# Project-specific
.pi/extensions/pi-tool-display
```

### npm package

```bash
pi install npm:pi-tool-display
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-tool-display
```

## Usage

### Interactive settings

Open the settings modal:

```text
/tool-display
```

The modal exposes the day-to-day controls most people change regularly:

- preset profile
- read output mode
- grep/find/ls output mode
- MCP output mode (when MCP is available)
- preview line count
- bash collapsed line count
- diff layout mode
- native user message box toggle

Advanced options remain in `config.json`.

### Direct commands

```text
/tool-display show                    # Show the effective config summary
/tool-display reset                   # Reset to the default opencode preset
/tool-display preset opencode         # Apply opencode preset
/tool-display preset balanced         # Apply balanced preset
/tool-display preset verbose          # Apply verbose preset
```

## Presets

| Preset | Read Output | Search Output | MCP Output | Preview Lines | Bash Lines |
|--------|-------------|---------------|------------|---------------|------------|
| `opencode` | hidden | hidden | hidden | 8 | 10 |
| `balanced` | summary | count | summary | 8 | 10 |
| `verbose` | preview | preview | preview | 12 | 20 |

- **`opencode`** (default): minimal inline-only display; tool results stay collapsed
- **`balanced`**: compact summaries with line counts and match totals
- **`verbose`**: larger previews for read/search/MCP output and more visible bash output

## Configuration

Runtime configuration is stored at:

```text
~/.pi/agent/extensions/pi-tool-display/config.json
```

A starter template is included at `config/config.example.json`.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `registerToolOverrides` | object | all `true` | Per-tool ownership flags |
| `enableNativeUserMessageBox` | boolean | `true` | Enable bordered user prompt rendering |
| `readOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `searchOutputMode` | string | `"hidden"` | `hidden`, `count`, or `preview` |
| `mcpOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `previewLines` | number | `8` | Lines shown in collapsed preview mode |
| `expandedPreviewMaxLines` | number | `4000` | Max preview lines when fully expanded |
| `bashCollapsedLines` | number | `10` | Lines shown for collapsed bash output |
| `diffViewMode` | string | `"auto"` | `auto`, `split`, or `unified` |
| `diffSplitMinWidth` | number | `120` | Minimum width before auto mode prefers split diffs |
| `diffCollapsedLines` | number | `24` | Diff lines shown before collapsing |
| `diffWordWrap` | boolean | `true` | Wrap long diff lines when needed |
| `showTruncationHints` | boolean | `true` | Show truncation indicators for compacted output |
| `showRtkCompactionHints` | boolean | `true` | Show RTK compaction hints when RTK metadata exists |

### Tool ownership

Use `registerToolOverrides` to control which built-in tools this extension owns:

```json
{
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  }
}
```

Set any entry to `false` if another extension should handle that tool instead.

> Changes to tool ownership take effect after `/reload`.

### Example config

```json
{
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  },
  "enableNativeUserMessageBox": true,
  "readOutputMode": "summary",
  "searchOutputMode": "count",
  "mcpOutputMode": "summary",
  "previewLines": 12,
  "expandedPreviewMaxLines": 4000,
  "bashCollapsedLines": 15,
  "diffViewMode": "auto",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "showTruncationHints": true,
  "showRtkCompactionHints": true
}
```

## Rendering notes

### Edit and write diffs

`edit` and `write` results use the same diff renderer. In `auto` mode the extension chooses split or unified layout based on available width. On narrow panes it clamps rendered lines and shortens collapsed hint text so the diff stays readable instead of spilling past the terminal width.

### Write summaries

When content is available, `write` call summaries include line count and byte size information inline so you can quickly see the size of the pending write before expanding the result.

### Thinking labels

Thinking blocks are labeled during streaming and on final messages. Before the next model turn, the extension sanitizes those presentation labels out of the stored assistant context so they do not accumulate or pollute future prompts.

### Native user message box

When enabled, user prompts render inside a bordered box using Pi's native user message component. The renderer preserves markdown content more safely and normalizes ANSI/background handling to avoid odd nested background artifacts.

## Capability detection

The extension checks the current Pi environment and adjusts behavior automatically:

- **MCP tooling unavailable**: MCP settings are hidden and MCP output is forced off
- **RTK optimizer unavailable**: RTK hint settings are hidden and RTK compaction hints are disabled
- **Compatible fork core summaries detected**: duplicate thinking-label patching is skipped automatically so built-in fork summaries remain the single source of truth

This keeps the UI aligned with what the current environment can actually support.

## Troubleshooting

### Tool ownership conflicts

If another extension is already rendering one of the built-in tools:

1. Set `registerToolOverrides.<tool>` to `false`
2. Run `/reload`
3. Use `/tool-display show` to confirm the effective ownership state

### Config not loading

If your settings are not being applied:

1. Check that `~/.pi/agent/extensions/pi-tool-display/config.json` exists
2. Make sure the JSON is valid
3. Run `/tool-display show` to inspect the effective config summary

### MCP or RTK settings missing

Those controls only appear when the corresponding capability is available in the current Pi environment.

## Project structure

```text
pi-tool-display/
├── index.ts                         # Extension entrypoint for Pi auto-discovery
├── src/
│   ├── index.ts                     # Bootstrap and extension registration
│   ├── capabilities.ts              # MCP/RTK capability detection
│   ├── config-modal.ts              # /tool-display settings UI and command handling
│   ├── config-store.ts              # Config load/save and normalization
│   ├── diff-renderer.ts             # Edit/write diff rendering engine
│   ├── line-width-safety.ts         # Width clamping helpers for narrow panes
│   ├── presets.ts                   # Preset definitions and matching
│   ├── render-utils.ts              # Shared rendering helpers
│   ├── thinking-label.ts            # Thinking label formatting and context sanitization
│   ├── tool-overrides.ts            # Built-in and MCP renderer overrides
│   ├── types.ts                     # Shared config and type definitions
│   ├── user-message-box-markdown.ts # Markdown extraction for user message rendering
│   ├── user-message-box-native.ts   # Native user message box registration
│   ├── user-message-box-patch.ts    # Safe native render patching helpers
│   ├── user-message-box-renderer.ts # User message border renderer
│   ├── user-message-box-utils.ts    # ANSI/background normalization helpers
│   ├── write-display-utils.ts       # Write summary helpers
│   └── zellij-modal.ts              # Modal UI primitives
├── config/
│   └── config.example.json          # Starter config template
├── tests/
│   └── tool-ui-utils.test.ts        # Utility tests for user message and diff helpers
└── assets/
    └── pi-tool-display.png          # README screenshot
```

## Development

```bash
# Type check
npm run build

# Run tests
npm run test

# Full verification
npm run check
```

## Related extensions

- [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) — RTK optimizer for token-efficient source output

## License

[MIT](LICENSE)
