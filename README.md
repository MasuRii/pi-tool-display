# pi-tool-display

OpenCode-style tool rendering for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-tool-display` provides compact, expandable tool call/result rendering that keeps your terminal clean while preserving access to full details when needed.

![Screenshot](https://raw.githubusercontent.com/MasuRii/pi-tool-display/main/assets/pi-tool-display.png)

## Features

- **Compact Tool Rendering** — Overrides built-in `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` tools with collapsed-by-default output
- **MCP Tool Support** — Custom rendering for MCP gateway tool calls with configurable verbosity
- **Rich Diff Display** — Adaptive split/unified diff views with syntax highlighting and inline change emphasis for `edit` and `write` operations
- **Three Presets** — Quick verbosity profiles: `opencode` (minimal), `balanced` (summaries), `verbose` (previews)
- **Thinking Labels** — Prefixes AI thinking blocks with themed labels for better readability
- **Native User Message Box** — Bordered user prompt styling (optional)
- **Extension Compatibility** — Per-tool ownership toggles to avoid conflicts with other extensions
- **Capability Detection** — Auto-hides MCP/RTK settings when those features aren't available

## Installation

### Local Extension Folder

Place this folder in one of Pi's auto-discovery locations:

```text
# Global (all projects)
~/.pi/agent/extensions/pi-tool-display

# Project-specific
.pi/extensions/pi-tool-display
```

### npm Package

```bash
pi install npm:pi-tool-display
```

### Git Repository

```bash
pi install git:github.com/MasuRii/pi-tool-display
```

## Usage

### Interactive Settings

Open the settings modal:

```text
/tool-display
```

### Direct Commands

```text
/tool-display show                    # Display current configuration
/tool-display reset                   # Reset to default settings
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

**opencode** (default) — Minimal inline-only display; tool results stay collapsed  
**balanced** — Compact summaries showing line counts and match totals  
**verbose** — Expanded previews with more visible content by default

## Configuration

Runtime configuration is stored at:

```text
~/.pi/agent/extensions/pi-tool-display/config.json
```

A starter template is available at `config/config.example.json`.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `registerToolOverrides` | object | all `true` | Per-tool ownership flags (see below) |
| `enableNativeUserMessageBox` | boolean | `true` | Enable bordered user message styling |
| `readOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `searchOutputMode` | string | `"hidden"` | `hidden`, `count`, or `preview` |
| `mcpOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `previewLines` | number | `8` | Lines shown in collapsed preview |
| `expandedPreviewMaxLines` | number | `4000` | Max lines when expanded |
| `bashCollapsedLines` | number | `10` | Lines shown for bash output |
| `diffViewMode` | string | `"auto"` | `auto`, `split`, or `unified` |
| `diffSplitMinWidth` | number | `120` | Minimum terminal width for split view |
| `diffCollapsedLines` | number | `24` | Lines shown in collapsed diff |
| `diffWordWrap` | boolean | `true` | Wrap long lines in diff view |
| `showTruncationHints` | boolean | `true` | Show truncation indicators |
| `showRtkCompactionHints` | boolean | `true` | Show RTK compaction hints |

### Tool Override Ownership

Control which tools this extension overrides:

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

Set any tool to `false` to leave rendering ownership to another extension.

> **Note:** Changes to tool ownership require `/reload` to take effect.

### Example Configuration

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

## Capability Detection

The extension automatically detects available capabilities:

- **MCP Tooling** — When no MCP tools are available, MCP-related settings are hidden and MCP output mode is forced to `hidden`
- **RTK Optimizer** — When [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) isn't installed, RTK compaction hint settings are hidden and hints are disabled

This prevents confusion from settings that have no effect in your environment.

## Troubleshooting

### Tool Ownership Conflicts

If another extension owns a tool and you see rendering conflicts:

1. Set the corresponding `registerToolOverrides.<tool>` to `false` in your config
2. Run `/reload` in Pi
3. Verify with `/tool-display show` that the ownership reflects expected `off` values

### Configuration Not Loading

If settings aren't applying:

1. Check the config file exists at `~/.pi/agent/extensions/pi-tool-display/config.json`
2. Verify JSON syntax is valid
3. Run `/tool-display show` to see current effective configuration

## Project Structure

```text
pi-tool-display/
├── index.ts                    # Extension entrypoint (Pi auto-discovery)
├── src/
│   ├── index.ts                # Extension bootstrap and registration
│   ├── tool-overrides.ts       # Built-in and MCP renderer overrides
│   ├── diff-renderer.ts        # Edit/write diff rendering engine
│   ├── config-modal.ts         # /tool-display settings UI
│   ├── capabilities.ts         # MCP/RTK capability detection
│   ├── config-store.ts         # Config load/save and normalization
│   ├── presets.ts              # Preset definitions and matching
│   ├── render-utils.ts         # Shared rendering helpers
│   ├── thinking-label.ts       # Thinking block label formatting
│   ├── user-message-box-native.ts  # User message border styling
│   ├── types.ts                # TypeScript type definitions
│   └── zellij-modal.ts         # Modal UI primitives
├── config/
│   └── config.example.json     # Starter config template
└── assets/
    └── pi-tool-display.png     # README screenshot
```

## Development

```bash
# Type check
npm run build

# Lint (same as build)
npm run lint

# Run tests
npm run test

# Full check
npm run check
```

## Related Extensions

- [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) — RTK optimizer for token-efficient source output

## License

[MIT](LICENSE)
