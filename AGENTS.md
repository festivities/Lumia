# Lumia — AI Media Moderation Bot (v2)

**This file is the comprehensive context document for the Lumia project.**
Status: **IMPLEMENTED**


## Purpose

Lumia moderates a Blender 3D rendering community Discord server for any malicious
actors posting NSFW artwork — predominantly anime-style ("hentai"-type) content, 
both hand-drawn 2D, 3D-rendered, animations, and videos.
There is no human staff — Lumia is the first responder. Media posted or linked in
configured channels are screened by NVIDIA''s `nvidia/nemotron-3.5-content-safety` model:
- Its vision encoder is SigLIP (a general image-text encoder), so it generalizes
  to drawings, renders, and anime-style art — not just photographs.
- Its safety-training data (VLGUARD, RTVLM, MM-SafetyBench, etc.) includes
  drawn/rendered sexual content, which photo-oriented detectors (e.g. Google
  SafeSearch) routinely miss.
- Its taxonomy includes sexual-content categories, which is what our flags will
  mostly be. Categories are treated as opaque strings — do not hardcode or
  filter on specific category names.

Note on false positives: SFW anime art is a daily occurrence in this community,
so the real FP surface is "SFW anime-style render flagged as sexual". This is
why the flow is fail-open on errors, why every flag gets a staff-review
alert with an interactive "Approve (False Positive)" button to instantly lift
timeouts and restore original media.

What Lumia does: flagged messages are deleted, the author is timed out for a
configurable duration, and staff are alerted in a configurable channel for
manual review.

**Scope decision (owner-confirmed): ONLY media (images, animations, videos, and media links) are screened.**
Message text is NOT moderated by Lumia — Discord AutoMod handles text. The user''s message text is
never sent to the AI model (only extracted media URLs are fetched locally and sent).

**Deployment decision (owner-confirmed): Dockerfile.** Single self-contained
image with `ffmpeg` and `libwebp-tools`. Runs on Oracle Ampere ARM64 (2 cores,
12 GB RAM) sharing resources with other background containers.

---

## Content Classes and Gating Matrix

| Class | Examples | Rendering in Discord |
|---|---|---|
| **static image** | jpg, png, still webp/avif/heic | inline image |
| **autoplay animation** | animated gif, apng, animated webp, animated avif | inline, moves by itself |
| **player video** | mp4, webm, mov, mkv, m4v, avi, wmv, flv, mpg, ogv, 3gp… | Discord video player |

Gating (what actually gets screened):

| Content class | channel mode `images` | channel mode `images+videos` |
|---|---|---|
| static image | ✅ always | ✅ always |
| autoplay animation | ✅ always | ✅ always |
| player video | ❌ | ✅ **only if** global scope = `all` |

- Global scope `autoplay` overrides player video to ❌ everywhere (the quota brake).
- Filesize threshold (`maxFileMb`, default 50 MB) applies to ALL classes (pre-download skip above it).
- Animation length is never a skip criterion (frame count adapts to duration; length itself never disqualifies).

---

## Stack (decided — do not revisit)

- **Runtime**: Node.js ≥ 22, ESM (`"type": "module"`). ARM64-native.
- **Discord library**: `discord.js` v14.
- **Media tools**: Mainline `ffmpeg`, `ffprobe`, `webpmux` (installed via Alpine `ffmpeg` & `libwebp-tools`).
- **Storage**: Single JSON file `data/config.json` with atomic writes (`.tmp` + rename).
- **Env**: `node --env-file=.env` (Docker: `--env-file`). No dotenv.
- **Resource budget**: Single-threaded ffmpeg (`-threads 1 -filter_threads 1`), serialized queue jobs.

---

## Verified Nemotron API Contract

- Endpoint: `POST https://integrate.api.nvidia.com/v1/chat/completions`
  Headers: `Authorization: Bearer $NVIDIA_API_KEY`, `Content-Type: application/json`
- Request body:
  ```json
  {
    "model": "nvidia/nemotron-3.5-content-safety",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<b64>" } },
        { "type": "text", "text": "<Detailed contextual prompt for anime/CGI artwork>" }
      ]
    }],
    "max_tokens": 200,
    "temperature": 0.01,
    "top_p": 0.95,
    "stream": false,
    "chat_template_kwargs": { "request_categories": "/categories" }
  }
  ```
- **Fixed prompt**: A detailed multi-line prompt providing context for evaluating anime-style artwork, 3D CGI, and specific fetish characteristics (armpits, sideboobs, ahegao, etc.) to moderate based on emphasis rather than mere presence.
- **Rate limit**: 40 requests/min (free tier). Throttled via 1.6s call spacing ceiling (~37.5 calls/min).
- **Known flakiness**: Key intermittently returns 403 authorization failed; exponential backoff retries (5s/15s/45s) on 403/429/5xx and network errors; after retries exhausted → fail-open.
- **HTTP 202**: Poll `GET /v1/status/{requestId}` with 1s interval up to 60s.

---

## Moderation Flow (`messageCreate` & `messageUpdate`)

1. **Ignore**: non-guild messages, bots and webhooks, unmonitored channels/threads.
2. **Attachment Screening**:
   - Classify attachment via `classifyAttachment(att, gates)`.
   - Skip if `att.size > maxFileMb MB` (fail-open).
   - Download with streaming size cap.
   - For `player-video`: write temp file, `enqueueVideo(path, 'player-video')`.
   - For `image`: run pure JS sniffer `sniffImage(buffer)`:
     - If animated (GIF, APNG, animated WebP/AVIF): write temp file, `enqueueVideo(path, 'autoplay-animation')`.
     - If static JPEG/PNG: `enqueueImage(buffer, contentType)`.
     - If static other (WebP, AVIF, HEIC): `normalizeStillImage` → `enqueueImage`.
3. **Link & Embed Screening** (`screenMessageLinks`):
   - Triggered on `messageCreate` (when no attachment flagged) and `messageUpdate` (when Discord unfurls embeds).
   - Extract candidate URLs from `message.embeds` and text URLs matching media extensions.
   - Dedupe per message ID + URL (2000-entry FIFO cache).
   - Fetch media via `fetchGuarded(url, maxBytes)` with SSRF protection (private/loopback/link-local IP rejection, max 3 redirects).
   - Classify and screen via same queue paths.
4. **Sampling & Short-Circuit**:
   - Player videos: Sample `X` frames by duration (`framesForDuration`: 4 to 12 frames) via keyframe-anchored input seeking.
   - Autoplay animations: Uniform index sampling (up to 8 frames for GIF/APNG, up to 6 frames for WebP).
   - **Short-circuit**: Queue job aborts further frame evaluations on the first `unsafe` frame to conserve quota.
5. **Action on Unsafe Verdict**:
   - **Timeout** member for configured duration.
   - **Delete** flagged message.
   - **Alert** staff channel: Embed with author, channel, categories, timeout duration, source (attachment/link), original URL, sample summary, flagged timestamp/frame, and inline image preview of the flagged frame.
   - **Interactive Button**: `Approve (False Positive)` button attached.
6. **False Positive Approval**:
   - Staff clicking button lifts member timeout, re-posts original media to the channel with author attribution, and updates staff alert audit trail.

---

## Slash Commands (`/lumia`)

- `/lumia channel add <channel> [mode: images|images+videos]` — Add or update monitored channel.
- `/lumia channel remove <channel>` — Remove monitored channel.
- `/lumia channel mode <channel> <mode: images|images+videos>` — Set mode for monitored channel.
- `/lumia animations <scope: all|autoplay>` — Set global animation scope (`autoplay` is quota brake).
- `/lumia maxsize <megabytes: 1..500>` — Set filesize threshold.
- `/lumia timeout <duration>` — Set timeout duration (e.g. `10m`, `1h30m`, `2d`, `45s`).
- `/lumia staffchannel <channel>` — Set staff alert review channel.
- `/lumia role [role]` — Set staff role to ping on alerts.
- `/lumia show` — Display current configuration.

---

## File Structure

```
package.json                  dependencies and scripts
.gitignore                    ignores data/, node_modules, .env
.env.example                  sample env file
.env                          runtime API tokens (not committed)
Dockerfile                    Alpine Node 22 + ffmpeg + libwebp-tools
eslint.config.mjs             ESLint flat config
src/index.js                  application bootstrap, events, moderation routing, FP flow
src/video.js                  classification, sniffers, still normalization, frame extraction
src/links.js                  URL extraction, SSRF-guarded fetcher, dedupe cache
src/settings.js               atomic JSON configuration store & schema migration
src/safety.js                 Nemotron client, rate limiter, image/video screening queues
src/commands.js               /lumia slash command definitions and handlers
src/parse.js                  pure parsers for verdicts and durations
test/classify.test.js         attachment & link gating tests
test/frames.test.js           adaptive frame calculation & dedupe tests
test/links.test.js            URL extraction & SSRF guard tests
test/parse.test.js            verdict & duration parser tests
test/settings.test.js         settings store & migration tests
test/sniff.test.js            pure JS animation sniffer tests
test/video.integration.test.js live ffmpeg frame extraction tests
test/fixtures/                sample mp4, gif, apng, avif, webp files
tools/smoke.js                live API & frame extraction smoke test
```

---

## Deliberate Simplifications

- ponytail: Frame caps (12 video / 8 autoplay) hardcoded; raise if real misses surface.
- ponytail: Autoplay webp samples first 6 frames (looped asset).
- ponytail: Animated avif best-effort via isobmff; 0 frames → fail-open.
- ponytail: Text URLs without a media extension are skipped (no content-probe of arbitrary links).
- ponytail: First screenable attachment only; links: all candidates per message.
- ponytail: Sub-second flash frames between sample points can slip (keyframe anchoring mitigates).
- ponytail: One queue, extraction serialized — no parallel decode on the shared host.
- ponytail: `maxFileMb` is per guild, not per channel.
- ponytail: No cross-message URL/verdict caching.

---

## Invariants

- User message text is NEVER sent to the AI model.
- Link fetches are SSRF-guarded: http/https only, public IPs only, ≤ 3 validated redirects, stream capped.
- Animated images are never sent to the API as-is (extraction always).
- Frames leave as `image/jpeg` data URIs with the fixed prompt.
- Temp files live in `os.tmpdir()/lumia-*`, cleaned in `finally`, swept at boot.
- ffmpeg is single-threaded; at most one decode at a time.
- Animation length is never a moderation criterion (only the filesize threshold is).
- Fail-open on API errors, unparseable responses, oversize files, and decoding errors.

---

## Commands

```bash
npm start             # node --env-file=.env src/index.js
npm test              # node --test
npm run lint          # eslint
node --env-file=.env tools/smoke.js   # live API + video extraction smoke test
```
