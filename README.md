# First Impression

Target prospect tool that produces polished, self-contained demo packages for [XInfer.AI](https://xinfer.ai). Each package showcases a recorded AI shopping assistant demo on the prospect's actual website, uploaded to S3 and accessible at:

```
https://assets.xinfer.com/demo/[tenant-slug]
```

## How It Works

1. **Record** a browser session of XInfer's chat widget on the target site (automated via Playwright)
2. **Edit** the recording — detect/remove freezes, trim segments, adjust playback speed
3. **Narrate** — generate AI voiceover for timeline events, plus branded intro & outro scenes
4. **Compose** — concatenate intro + narrated video + outro into a polished final cut
5. **Publish** — generates a branded demo page and uploads everything to S3
6. **Outreach** — compose and copy email/SMS letters to send the prospect their demo link

## Features

### Recording
- **Automated recording** — Playwright navigates the prospect's site, opens the widget, sends queries, and captures video
- **Widget injection** — optionally provide a widget URL to overlay on any site, or record the live site directly
- **Snapshot capture** — takes a pre-recording screenshot for use in intro scenes and OG image previews

### Editing
- **Auto freeze detection** — identifies and marks frozen frames for removal via FFmpeg
- **Visual timeline editor** — drag to mark keep/cut regions, double-click to toggle segments
- **Trim & speed adjust** — remove unwanted segments, save WYSIWYG videos at different speeds
- **Multiple versions** — iterate with trimmed and speed-adjusted variants, each with its own timeline

### Narration
- **AI voiceover** — generates narration clips for each timeline event (widget open, queries) and mixes them into the video at the correct timestamps
- **Intro scene** — branded opening with site snapshot, text overlay card, and AI voiceover introducing the demo
- **Outro scene** — closing scene with call-to-action narration
- **ElevenLabs TTS** — professional voice synthesis with configurable voice, speed, and style
- **Voice caching** — SHA-256 hash-based caching of TTS results to avoid redundant API calls

### Publishing
- **Final composition** — one-click concatenation of intro + main video + outro
- **Demo page generation** — produces a branded, responsive HTML page per prospect with video, business context, and CTAs
- **S3 publishing** — one-click upload of video + snapshot + demo page, returns the public URL
- **Outreach letter composer** — after publishing, generates ready-to-copy email and SMS outreach templates personalized with the prospect's business info

### Studio UI
- **Workflow-guided buttons** — progressive highlighting shows the next step (speed → intro → voiceover → compose → publish)
- **Auto tab switching** — newly generated videos automatically become the active tab
- **State persistence** — picks up where you left off across sessions
- **In-panel previews** — all actions display results in the main panel, no popup windows

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

Create `.env` with:

```env
# rag-chatbot API (for tenant info)
RAG_CHATBOT_BASE_URL=https://your-rag-chatbot-url
FIRST_IMPRESSION_API_KEY=your-api-key

# Auth
FIRST_IMPRESSION_SECRET=your-auth-secret

# ElevenLabs (text-to-speech)
ELEVENLABS_API_KEY=your-api-key
ELEVENLABS_VOICE_ID=your-voice-id          # optional, defaults to "Hope"
ELEVENLABS_VOICE_MODEL=eleven_flash_v2_5   # optional
ELEVENLABS_VOICE_SPEED=0.92                # optional

# AWS S3 (for publishing)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_BUCKET=your-bucket
ASSETS_BASE_URL=https://assets.xinfer.com
```

Requires `ffmpeg` and `ffprobe` on PATH.

## Usage

### Studio (Web UI)

```bash
pnpm studio
```

Opens http://localhost:3456 with the recording studio.

### Workflow

1. Enter the prospect's URL, widget URL (optional), and queries to demo
2. Click **Start New Recording** — Playwright captures the full browser interaction
3. **Make x2 Speed Video** — creates a 2x speed version of the raw recording
4. **Make Intro & Outro** — generates branded opening/closing scenes with voiceover (requires Tenant ID)
5. **Add Voice to Video** — generates narration clips for each timeline event and mixes them into the video
6. **Compose Final Video** — concatenates intro + narrated video + outro into `final.webm`
7. **Preview** — renders the demo page in-panel with the final video
8. **Publish** — uploads to S3 and returns the demo URL
9. **Outreach** — right panel shows email and SMS templates with copy buttons

### CLI Pipeline

Fully autonomous pipeline — just provide a tenant ID and the CLI derives everything else (URL, widget, queries, subtitle, intro/outro) from tenant info and AI generation.

```bash
# Full autonomous run (derives URL, queries, subtitle, intro/outro from tenant info + AI)
tsx cli.ts 536222

# With user attribution (defaults to demo@xinfer.ai if omitted)
tsx cli.ts 536222 --email sam@xinfer.ai

# Override URL or queries when needed
tsx cli.ts 536222 --url https://example.com --queries "Show me products" "What about returns?"

# Resume from a specific step (uses saved state.json)
tsx cli.ts 536222 --recording 2026-03-09T12-33-23 --from 5

# Stop before publishing
tsx cli.ts 536222 --no-publish

# JSON from stdin
echo '{"tenant":536222,"email":"sam@xinfer.ai"}' | tsx cli.ts
```

Steps: 1=fetch & generate, 2=record, 3=speed, 4=intro/outro, 5=voiceover, 6=compose, 7=publish

| Option | Description |
|--------|-------------|
| `<tenantId>` | Tenant ID (first positional argument, required) |
| `--email <email>` | User email for publish attribution (default: `demo@xinfer.ai`; auto-creates user if not found) |
| `--url <url>` | Override target website URL (default: derived from tenant info) |
| `--widget-url <url>` | Override widget script URL (default: derived from tenant subdomain) |
| `--queries "q1" "q2"` | Override queries (default: AI-generated, then suggested actions) |
| `--recording <id>` | Resume an existing recording (required with `--from`) |
| `--from <step>` | Start from step 1–7 (default: 1) |
| `--speed <number>` | Speed multiplier (default: 2) |
| `--headed` | Show browser during recording |
| `--no-publish` | Stop after compose, skip publish |
| `--force` | Skip duplicate detection, always publish new version |

#### What step 1 does automatically

The first step fetches tenant info and calls the AI generate API to produce all content needed for the pipeline:

- **URL**: derived from `setup.website` or `app.homePageUrl`
- **Widget URL**: derived from tenant subdomain (`https://{subdomain}.xinfer.ai/widget.js`)
- **Queries**: AI-generated, falls back to `app.suggestedActions`
- **Subtitle**: AI-generated, falls back to a default based on whether the tenant has products
- **Intro/outro text**: AI-generated, falls back to defaults in the narration module

All generated content is saved to `state.json` in the recording directory, enabling resume from any step without re-fetching.

#### State file

Each CLI run saves `state.json` in the recording directory after every step. This enables resuming with `--from` without losing generated content:

```json
{
  "tenantId": 536222,
  "completedStep": 3,
  "url": "https://example.com",
  "widgetUrl": "https://demo-agent.xinfer.ai/widget.js",
  "subtitle": "A personalized demo of...",
  "introText": "Meet our AI assistant...",
  "outroText": "That's the assistant in action...",
  "queries": ["Show me products", "What about returns?"],
  "tagline": "Your AI shopping assistant",
  "inventoryDescription": "Premium electronics and accessories",
  "speed": 2
}
```

### CLI Recording

```bash
pnpm record
```

Runs a headless recording with default config.

## Recording Directory

Each recording lives in `recordings/[ISO-timestamp]/` and accumulates files through the workflow:

```
recordings/2026-03-08T12-23-36/
├── config.json                 # Recording inputs (url, queries, tenantId)
├── state.json                  # CLI pipeline state (generated content, progress)
├── raw.webm                    # Original Playwright recording
├── raw-speed-2x.webm           # 2x speed version
├── raw-speed-2x-voiced.webm    # With narration mixed in
├── timeline.json               # Action timeline (page-load, queries, etc.)
├── snapshot.png                # Pre-recording screenshot
├── snapshot-page.html          # Local page with widget injected
├── freezes-raw.json            # Detected freeze data
├── frames-raw/                 # Extracted freeze frame thumbnails
├── intro.webm                  # Branded intro scene
├── intro-audio.mp3             # Intro voiceover
├── intro-overlay.png           # Intro text card overlay
├── outro.webm                  # Branded outro scene
├── outro-audio.mp3             # Outro voiceover
├── outro-overlay.png           # Outro text card overlay
├── voiceover/                  # Narration working directory
│   ├── clip-0.mp3 .. clip-N.mp3
│   └── ...
└── final.webm                  # Composed final video (intro + main + outro)
```

## Published Demo Page

Each published demo at `https://assets.xinfer.com/demo/[tenant-slug]` includes:

- XInfer branding + prospect's business name and logo
- Personalized hero copy
- Autoplay video of the composed demo
- Business context from the Setup Wizard (tagline, inventory description)
- XInfer platform intro video
- Omnichannel capabilities grid
- Call-to-action (try demo, visit xinfer.ai)
- `og:image` meta tag for link previews (uses the site snapshot)

## Architecture

```
server.ts          Express server — 17 API endpoints + static files
recorder.ts        Playwright recording engine
helpers.ts         Playwright interaction helpers (typing, zoom, scroll)
tenant.ts          Fetches business info from rag-chatbot API
voice.ts           ElevenLabs TTS with SHA-256 hash caching
narrate.ts         Intro/outro scene generation (snapshot + overlay + voiceover)
voiceover.ts       Timeline-based narration (per-event TTS + FFmpeg audio mix)
freeze-detect.ts   FFmpeg freeze detection + frame extraction
trim.ts            FFmpeg trim/concat pipeline
demo-page.ts       Generates static HTML demo page per tenant
upload.ts          S3 publisher (video + snapshot + HTML)
public/index.html  Single-page web UI (recording studio)
record.ts          CLI entry point (recording only)
cli.ts             CLI entry point (autonomous 7-step pipeline)
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/recordings` | List all recordings |
| POST | `/api/recordings` | Start a new recording |
| GET | `/api/recordings/:id` | Get recording details (videos, timeline, freezes) |
| GET | `/api/recordings/:id/events` | SSE stream for recording progress |
| DELETE | `/api/recordings/:id` | Delete a recording |
| POST | `/api/recordings/:id/detect-freezes` | Run freeze detection |
| GET | `/api/recordings/:id/frames/:video/:name` | Serve freeze frame thumbnails |
| POST | `/api/recordings/:id/trim` | Trim video by cut ranges (SSE) |
| POST | `/api/recordings/:id/speed` | Create speed-adjusted video (SSE) |
| GET | `/api/recordings/:id/video/:file` | Stream a video file |
| DELETE | `/api/recordings/:id/video/:file` | Delete a video variant |
| GET | `/api/tenant/:tenantId` | Fetch tenant info |
| POST | `/api/recordings/:id/intro` | Generate intro & outro scenes (SSE) |
| POST | `/api/recordings/:id/voiceover` | Add narration to video (SSE) |
| POST | `/api/recordings/:id/compose` | Concatenate intro + main + outro |
| POST | `/api/recordings/:id/preview` | Generate demo page preview HTML |
| POST | `/api/recordings/:id/publish` | Publish to S3 |

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm studio` | Start the web studio (auto-reloads on file changes) |
| `pnpm cli` | Run the full autonomous pipeline from the command line |
| `pnpm record` | Run a CLI recording |
| `pnpm lint` | Run Biome linter and formatter |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run lint + typecheck |

## Requirements

- Node.js 18+
- FFmpeg and FFprobe on PATH
- Playwright Chromium browser
- ElevenLabs API key (for voiceover)
- AWS credentials (for publishing)
