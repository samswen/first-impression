# First Impression

Prepare polished first impression demo packages for target prospects. Record live browser interactions with your product, auto-detect and remove frozen frames, fine-tune edits on a visual timeline, and export a clean demo video ready to share.

## Features

- **Record** live browser demos against any target URL with configurable queries
- **Auto freeze detection** — automatically identifies and marks frozen frames for removal
- **Visual timeline editor** — drag to mark keep/cut regions, double-click to toggle segments
- **Trim** videos by removing frozen or unwanted segments
- **Speed adjust** — save WYSIWYG videos at different playback speeds
- **Multiple versions** — iterate with trimmed and speed-adjusted variants, each with its own timeline
- **State persistence** — picks up where you left off across sessions

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

### Studio (Web UI)

```bash
pnpm studio
```

Opens http://localhost:3456 with the recording studio.

### Workflow

1. Enter the prospect's URL and the queries to demo
2. Click **Start Recording** — Playwright captures the full browser interaction
3. Freeze detection runs automatically, marking frozen segments as cuts on the edit bar
4. Adjust cuts on the visual timeline — drag to refine, double-click to toggle
5. Click **Generate Trimmed Video from Edit** to produce a clean version
6. Optionally adjust playback speed and save as WYSIWYG

### CLI Recording

```bash
pnpm record
```

Runs a headless recording with default config.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm studio` | Start the web studio (auto-reloads on file changes) |
| `pnpm record` | Run a CLI recording |
| `pnpm lint` | Run Biome linter and formatter |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run lint + typecheck |

## Architecture

```
server.ts          Express server — API + static files
recorder.ts        Playwright recording engine
freeze-detect.ts   FFmpeg freeze detection + frame extraction
trim.ts            FFmpeg trim/concat pipeline
helpers.ts         Playwright interaction helpers
public/index.html  Single-page web UI
record.ts          CLI entry point
```

## Requirements

- Node.js 18+
- FFmpeg and FFprobe on PATH
- Playwright Chromium browser
