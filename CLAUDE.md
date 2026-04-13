# First Impression - Video Pipeline

## Quick Start

```bash
npx tsx cli.ts <tenantId>            # full run
npx tsx cli.ts <tenantId> --no-publish  # skip S3 upload
npx tsx cli.ts <tenantId> --recording <id> --from 4  # re-run from voiceover step
```

## Recent Change: Voice Placement Algorithm (commit 61416f1)

The voiceover clip placement was reworked. When reviewing pipeline output, check:

### What to verify in logs

1. **Timeline events** should show `send=` and `respEnd=` timestamps for query events:
   ```
   query-1: 5.2s-22.1s (16.9s) send=8.4s respEnd=18.6s "What services do you offer?"
   ```

2. **Push-forward cascade** — all clips must have >= 1s gap between them. Look for:
   ```
   Clip 2 pushed from 12.3s to 15.8s (cascade)
   ```

3. **SendTime slide** — unpushed query clips should slide toward sendTime:
   ```
   Clip 2 slid +3.2s toward sendTime 11.5s
   ```

4. **Final clip schedule** — verify no overlaps, all gaps >= 1s:
   ```
   Clip 1 [open-widget] ok: ideal=3.0s actual=3.0s-6.2s (3.2s)
   Clip 2 [query-1] ok: ideal=8.5s actual=11.5s-15.1s (3.6s) gap=5.3s sendTime=11.5s
   ```

### Red flags
- Any gap < 1.0s between clips = bug in cascade
- A clip marked PUSHED that has a gap > 1.0s to the previous = cascade set pushed unnecessarily
- Narration starting during typing (before sendTime) for query clips = slide didn't work

## Testing the CFR Recording (x11grab)

The recorder was just switched from Playwright's built-in VFR `recordVideo` to **Xvfb + ffmpeg x11grab** on Linux. This eliminates the video/timeline duration mismatch that caused voice narration to drift out of sync.

### Prerequisites

```bash
sudo apt-get install -y xvfb x11-utils
```

### What changed in `recorder.ts`

- On Linux (`process.platform === "linux"`), the recorder:
  1. Starts Xvfb on `:99` (or reuses if already running)
  2. Launches Chromium in **headed** mode on the virtual display
  3. Records the display with `ffmpeg -f x11grab -framerate 30` (constant 30fps)
  4. Stops ffmpeg by sending `q` to stdin after recording
  5. **No VP8→VP9 re-encode, no setpts stretch** — the video is already VP9 at wall-clock speed
- On macOS, the old Playwright VFR + stretch approach is preserved

### What to verify

1. Run a test recording:
   ```bash
   npx tsx cli.ts <tenantId> --no-publish
   ```

2. Check the log for:
   - `Xvfb started on :99` or `Xvfb already running on :99`
   - `Video XX.Xs, timeline XX.Xs (CFR, no stretch needed)` — these two numbers should be within ~1s of each other
   - **No** "stretching X.XXXx" message — that means the old VFR path was used

3. If video and timeline diverge by more than 1s, something is wrong with x11grab capture.

4. Watch the final video and verify:
   - Narration aligns with what's happening on screen
   - Voice doesn't finish early or start late relative to visual events
   - No visual glitches from the x11grab capture

### ffmpeg buffer settings (tuned for 4+ CPU, 16+ GB)

- `probesize 128M` — large input analysis buffer
- `thread_queue_size 1024` — deep frame queue
- `threads 4` — encoding threads (adjust if machine has fewer cores)

### Troubleshooting

- **"No video file found — ffmpeg x11grab failed"**: Check ffmpeg stderr. Likely Xvfb didn't start or DISPLAY isn't set. Verify with `xdpyinfo -display :99`.
- **Black/empty video**: Chromium didn't render to the Xvfb display. Verify `DISPLAY=:99` is set before browser launch.
- **Video too short**: x11grab should produce wall-clock-accurate duration. If not, check system load — ffmpeg may have dropped frames under heavy CPU pressure.

## Environment

- Requires `.env` with `RAG_CHATBOT_BASE_URL`, `FIRST_IMPRESSION_API_KEY`, `ELEVENLABS_API_KEY`
- Needs `ffmpeg`, `ffprobe` on PATH
- Headless Chromium via Playwright (`npx playwright install chromium`)
- **Linux**: needs `xvfb` and `x11-utils` packages for CFR recording
- **macOS**: no extra deps, uses Playwright's built-in recorder

## Pipeline Steps

1. Fetch tenant info + AI-generate content (queries, subtitle, narration)
2. Record browser session (Playwright + widget interaction)
3. Generate intro/outro scenes
4. Add voiceover narration (TTS + placement algorithm)
5. Compose final video (intro + main + outro)
6. Publish to S3

Resume from any step: `--from N --recording <id>`

## Project Structure

- `cli.ts` — CLI entrypoint, argument parsing, step orchestration
- `recorder.ts` — Playwright browser recording, timeline generation
- `voiceover.ts` — TTS generation, clip placement algorithm, ffmpeg mixing
- `helpers.ts` — Timing constants (TYPING_DELAY, PAUSE_AFTER_TYPE, etc.)
- `voice.ts` — ElevenLabs TTS wrapper
- `server.ts` — HTTP server mode (used by cloud workers)
