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

## Environment

- Requires `.env` with `RAG_CHATBOT_BASE_URL`, `FIRST_IMPRESSION_API_KEY`, `ELEVENLABS_API_KEY`
- Needs `ffmpeg`, `ffprobe` on PATH
- Headless Chromium via Playwright (`npx playwright install chromium`)
- On headless servers, use `xvfb-run` if Playwright needs a display:
  ```bash
  xvfb-run npx tsx cli.ts <tenantId>
  ```

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
