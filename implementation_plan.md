# Lumia — Video/Animation/Link Screening Implementation Plan (v2)

**Status: PLANNED — not yet implemented.** Self-contained brief for extending
Lumia's screening: images → images + animations (autoplay and player-video) +
linked/embedded media. Read `AGENTS.md` for project context (threat model,
API contract, invariants) before starting. After implementation, update
`AGENTS.md` per its own instructions.

Rev v2 changes vs v1, all owner-driven:
1. Per-channel mode: **images-only** vs **images+videos** (images-only still
   screens autoplay animations).
2. Global animation scope: **all animation types** (mp4, gif, …) vs
   **autoplay-only** (gif, animated webp, …).
3. Staff-configurable **filesize threshold** (below = screened). Animation
   length is NEVER a skip criterion.
4. **Link/embed screening** via `messageUpdate` + URL extraction.
5. Adaptive frame count X sampled by animation **length** (determined below,
   not frame-by-frame decoding).
6. Budget assumes a **shared 2-core / 12 GB host** already running two other
   Docker services (budgeting + stock trackers).

---

## 1. Content classes and the gating matrix

Three classes, decided per attachment/link:

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

- Global scope `autoplay` overrides the matrix's last row to ❌ everywhere
  (the quota brake / global narrowing).
- Filesize threshold applies to ALL classes (pre-download skip above it).
- Animation length is never a skip criterion (frame COUNT adapts to length;
  length itself never disqualifies anything).

---

## 2. Current state (verified by reading the implemented code)

```
src/index.js      messageCreate at ~277: first image/* attachment → 15MB cap →
                  download → enqueue → timeout/delete/staff-alert w/ FP button
                  handleFalsePositiveApproval at ~113 (restores via embed image URL)
                  downloadImageWithCap(url, maxBytes) at ~238 (streaming cap)
                  isChannelConfigured at ~218 (walks thread parent chain)
src/safety.js     evaluateImage(buffer, contentType) + SafetyQueue (sequential,
                  50 max, 90s job timeout, 30s request timeout, retries 5s/15s/45s
                  on 403/429/5xx/network, 202 polling)
src/parse.js      parseVerdict / parseDuration / formatDuration (pure, tested)
src/settings.js   JSON store; getGuild deep-merges DEFAULT_GUILD_CONFIG:
                  { channels: [], timeoutMs, staffChannelId, staffRoleId }
src/commands.js   /lumia channel add|remove, timeout, staffchannel, role, show
tools/smoke.js    live API check with 1x1 PNG
Dockerfile        node:22-alpine only (no ffmpeg)
```

Existing gaps this plan closes: animations sent to the API as-is (only ~1st
frame effectively screened), no video support, no link/embed screening,
hardcoded size caps, no per-channel/global scope control.

---

## 3. Research findings (live-tested 2026-09-02, local ffmpeg 7.x)

### 3.1 The model has no video input

Model card: "text and a **single image**"; vision encoder **SigLIP 896×896**.
The chat-completions schema has `type: video_url`, but it is UNVERIFIED for
this model — the NVIDIA key was in its documented intermittent-403 state
during research. **Design assumes client-side frame extraction + per-frame
image calls** (the only live-verified request shape). Probing `video_url`
and multi-image requests when the key recovers is a checklist item (§13),
not a dependency.

### 3.2 ffmpeg extraction matrix (verified locally)

| Format | Duration probe | Extraction strategy | Result |
|---|---|---|---|
| mp4 (H.264) | `format.duration` | input-seek loop `-ss T -i f -frames:v 1` | ✓ |
| mp4 (H.264) | ok | single-pass `-vf fps=N/duration` | ✓ |
| avif (isobmff) | `format.duration` (0.4s in test) | input-seek loop | ✓ |
| gif | ok | `-vf fps=N/duration` OR select-by-index | ✓ |
| apng | **NaN** | `-count_frames` + `select='eq(n,i)+…'` | ✓ (dedupe indices!) |
| animated webp | n/a | **ffmpeg CANNOT decode animated webp** ("image data not found") | ✗ → `webpmux -get frame N` + ffmpeg still-decode |

- `ffprobe -count_frames` works on gif/apng (cheap: animated images are small).
- Input-seek (`-ss` before `-i`) FAILS on animated-image demuxers — only for
  real containers. Input-seek on containers is keyframe-anchored: seek lands
  on the prior keyframe and decodes forward — **scene changes/cuts are
  keyframes**, so spliced-in explicit segments (which start at a cut) are
  disproportionately likely to be sampled. Document as a design property.
- Decoders confirmed in mainline ffmpeg: gif, apng, webp(still), h264, hevc,
  vp8, vp9, av1 — all present in Alpine's `ffmpeg` package (aarch64);
  `webpmux` comes from Alpine `libwebp-tools`. Verify in-container (§13).
- When total frames F < requested N, `floor(i*F/N)` yields duplicates —
  dedupe and sample `min(F, N)`.

### 3.3 Discord-side facts

- Attachment `contentType`: `video/mp4`, `video/quicktime`, `video/webm`,
  `video/x-matroska`, `image/gif`, `image/png` (APNG often `image/apng`,
  sometimes plain `image/png`), `image/webp`, `image/avif`; exotic files →
  `application/octet-stream` or null → **extension fallback required**.
- Discord does not transcode attachments; `attachment.url` serves original bytes.
- Link embeds arrive asynchronously: `messageCreate` for user messages has
  no unfurled embeds; Discord sends `MESSAGE_UPDATE` seconds later with
  embeds. → link screening needs BOTH create (text URLs) and update (embeds).
- `embed.image.url` / `embed.thumbnail.url` are direct image URLs (e.g.
  i.ytimg.com thumbnails for YouTube links — screening them is correct:
  that's what renders in chat). `embed.video.url` is a direct media URL for
  raw video links, but an embed-page URL for player sites (YouTube) — a
  content-type check on fetch naturally excludes player pages.
- Attachment CDN URLs stay fetchable ~24h after message deletion (already
  relied on by the image FP-restore flow).

---

## 4. Settings model & slash commands

### 4.1 New config shape (per guild)

```json
{
  "channels": { "<channelId>": { "mode": "images+videos" } },
  "animationScope": "all",
  "maxFileMb": 50,
  "timeoutMs": 3600000,
  "staffChannelId": null,
  "staffRoleId": null
}
```

- `channels` becomes an **object keyed by channelId** (was an array).
- `mode`: `"images"` | `"images+videos"` — per channel.
- `animationScope`: `"all"` | `"autoplay"` — global (per guild).
- `maxFileMb`: integer 1..500, default 50 — the filesize threshold. Applies
  to attachments AND linked media (by content-length / stream cap).
- **Migration** (in `settings.js` load path, one-time): if `guild.channels`
  is an array, convert to `{ id: { mode: "images+videos" } }` for each entry
  and save. Existing guilds get full screening after upgrade (the point of
  this feature); staff narrow per channel via commands. Missing keys
  deep-merge to defaults (`mode` → `"images+videos"`, `animationScope` →
  `"all"`, `maxFileMb` → `50`).

### 4.2 Command changes (`src/commands.js`)

- `/lumia channel add <channel> [mode: images|images+videos]`
  — optional `mode` choice, default `images+videos`. Idempotent: if the
  channel is already monitored, updates its mode.
- `/lumia channel remove <channel>` — unchanged (deletes map entry).
- `/lumia channel mode <channel> <mode>` — set mode for an existing channel.
- `/lumia animations <scope: all|autoplay>` — global animation scope.
  (`autoplay` = "only autoplay animation formats ever" — the quota brake.)
- `/lumia maxsize <megabytes:integer 1..500>` — filesize threshold.
  Discord enforces the integer range; no new parser needed.
- `/lumia show` — embed gains: per-channel mode list
  (`<#id>: images` / `images+videos`), `Animations: all / autoplay only`,
  `Max file size: 50 MB`.
- Existing `timeout`, `staffchannel`, `role` unchanged. All ephemeral, all
  ManageGuild-gated, same handlers structure.

---

## 5. New module `src/video.js`

### 5.1 Constants

```js
export const DEFAULT_MAX_FILE_MB = 50;
// ffmpeg invoked with: -threads 1 -filter_threads 1  (shared 2-core host)
```

### 5.2 Pre-download classification

```js
/**
 * @param {Attachment|{contentType, name}} att
 * @param {{ channelMode: 'images'|'images+videos',
 *           animationScope: 'all'|'autoplay' }} gates
 * @returns 'player-video' | 'image' | null   (null = skip)
 */
export function classifyAttachment(att, gates)
```

- `contentType video/*` → `player-video`; `image/*` → `image`
  (autoplay vs static is decided post-download by the sniffer — contentType
  cannot distinguish gif vs animated webp).
- contentType null / `application/octet-stream` → extension map
  (lowercase, from `att.name`):
  - PLAYER_EXT: `mp4 m4v mov webm mkv avi wmv flv mpg mpeg ts m2ts mts ogv ogm 3gp 3g2 vob`
  - IMAGE_EXT: `gif png apng webp avif jpg jpeg jfif heic heif bmp tiff`
- Then apply gates: `player-video` requires `channelMode === 'images+videos'`
  && `animationScope === 'all'`, else null (log skip reason at debug level).
  `image` always passes.

### 5.3 Animation sniffers (post-download, pure JS, synchronous, unit-tested)

```js
/** @returns {{kind:'gif'|'png'|'webp'|'avif'|'jpeg'|'other',
 *             animated:boolean, frameCount:number|null}} */
export function sniffImage(buffer)
```

- **GIF** (`GIF87a|GIF89a`): LSD packed byte → skip Global Color Table
  (`3*2^((packed&7)+1)` if `packed&0x80`); block loop — `0x21` ext: label +
  sub-blocks (`len+data` until `0x00`); `0x2C` image descriptor: 10 bytes +
  Local Color Table (same rule) + 1 LZW byte + sub-blocks; `0x3B` stop.
  `frameCount` = image descriptors seen; `animated = frameCount > 1`.
- **PNG** (8-byte sig, then `len(4BE) type(4) data crc(4)` chunks): animated
  iff `acTL` chunk appears before first `IDAT` (stop at IDAT);
  `frameCount` = acTL data bytes 0-3 (BE).
- **WebP** (`RIFF`+size+`WEBP`, chunks `fourcc(4) size(4LE)`): animated iff
  `ANIM` chunk exists; `frameCount` = `ANMF` chunk count (log only).
- **AVIF/HEIF** (bytes 4-7 = `ftyp`): animated iff major brand or any
  compatible brand = `avis`; `avif`/`heic` alone → still.
- **JPEG** (`FFD8FF`) → still. Else `other`. Never throw on truncated input —
  return `{kind:'other', animated:false, frameCount:null}`.

### 5.4 Still normalization

```js
/** jpeg/png pass through; other stills → 1 ffmpeg call → JPEG buffer. */
export async function normalizeStillImage(buffer)
```

Only `image/png` (verified) and `image/jpeg` (documented) are trusted data
URIs; webp/avif/heic stills are transcoded to JPEG so they can't fail-open
at the API. Pass-through keeps the common case subprocess-free.

### 5.5 Adaptive frame sampling — the value of X

**Design: sample by TIME (uniform timestamps), not by decoding every frame.**
Input-seek is keyframe-anchored (§3.2) — cheap AND biased toward cuts/scene
changes, which is exactly where spliced content hides. Frame count scales
with duration but is capped for quota (40 RPM):

```js
/** Player videos (duration known via ffprobe): */
export function framesForDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null; // → count-frame path
  if (seconds <= 2)  return 4;
  if (seconds <= 5)  return 5;
  if (seconds <= 10) return 6;
  if (seconds <= 20) return 8;
  if (seconds <= 60) return 10;
  return 12; // hard cap: quota ceiling 40 RPM @ 1.6s spacing
}

/** Autoplay animations (index-space, frame count via ffprobe -count_frames): */
// F ≤ 8 → screen ALL frames; F > 8 → 8 uniform indices (deduped)
```

Rationale (the "optimal X" determination):
- **Quota**: 40 RPM hard limit; 1.6s minimum spacing between API calls →
  ≤ 37.5 calls/min. Worst case (12-frame video) ≈ 20s of serialized API time.
  Typical Discord clip (2-10s) = 4-6 calls.
- **Discrimination**: SigLIP classifies single 896×896 images — more samples
  = strictly better coverage, but returns diminish; 12 samples over a 60s+
  clip ≈ one every 5-15s.
- **Residual risk (documented)**: a sub-second flash frame between sample
  points can slip through. Keyframe anchoring mitigates (cuts are keyframes);
  staff-review alerts compensate. `ponytail:` raise caps (16/12) if misses
  prove real — costs quota linearly.
- **Autoplay anims get full coverage up to 8** — they're the prevalent abuse
  vector (looped explicit gifs), and they're small.

```js
/**
 * @param {string} filePath temp file on disk
 * @param {{classHint:'player-video'|'autoplay-animation'}} opts
 * @returns {Promise<{frames: {index:number, t:number|null, buffer:Buffer}[]}>}
 * @throws on probe/decode failure or 0 frames (caller fail-opens)
 */
export async function extractFrames(filePath, opts = {})
```

Strategy by family:
- **Player video** (any container incl. AVIF-isobmff): `ffprobe -show_format`
  → duration → X = `framesForDuration(d)`; per i: `ffmpeg -v error -threads 1
  -filter_threads 1 -ss <i*d/X> -i f -frames:v 1 -q:v 3 -y out_i.jpg`
  (t reported in seconds). Duration NaN/0 → throw (broken file, fail-open).
- **Autoplay animation, gif/apng**: `ffprobe -count_frames` → F; indices
  `floor(i*F/min(F,8))` deduped; single pass `-vf select='eq(n,0)+eq(n,3)+…'
  -vsync vfr` (t = null → "frame N" in alert).
- **Autoplay animation, webp**: `webpmux -get frame <i> f -o frame_i.webp`
  (1-indexed, stop at first failure), each → ffmpeg still-decode → JPEG.
  First-min(F,6) frames (not uniform — looped assets, content cycles);
  `ponytail:` note in code.
- **Autoplay avif**: isobmff path above; 0 frames → throw → fail-open.
  Near-zero prevalence. `ponytail:` note.
- Temp hygiene: per-job `mkdtempSync(os.tmpdir()/lumia-…)`, always
  `rmSync(recursive, force)` in `finally`. Extraction runs INSIDE the queue
  job (serialized — max one ffmpeg at a time on the shared 2-core host).

---

## 6. New module `src/links.js`

```js
export function extractCandidateUrls(message)      // pure
export async function fetchGuarded(url, maxBytes)  // SSRF-guarded stream fetch
export function isScreenableLinkUrl(url)           // pure: extension gate for text URLs
```

- `extractCandidateUrls`: collect from `message.embeds[]` — `image.url`,
  `thumbnail.url`, `video.url` (dedupe) — plus regex
  `/https?:\/\/[^\s<>"']+/gi` over `message.content`, trimming trailing
  `).,!?`. Text URLs are pre-gated by media extension
  (gif png jpg jpeg webp avif apng mp4 webm mov mkv m4v); embed URLs are
  always candidates (Discord resolved them to media). URLs embedded in the
  user's text are extracted **locally only** — the text itself is still never
  sent to the model (invariant, unchanged).
- `fetchGuarded(url, maxBytes)`: `redirect: 'manual'`; resolve hostname via
  `dns.promises.lookup` and reject loopback/private/link-local IPs
  (SSRF trust boundary — this is a user-controlled URL); follow ≤ 3 hops
  re-validating each; then stream with the size cap (reuse the
  `downloadImageWithCap` body pattern), return
  `{ buffer, contentType }`. Non-2xx or non-media contentType → `null`
  (skip + log). This also naturally skips YouTube/player pages (text/html).
- **Dedupe**: `Map` keyed `${message.id}|${url}` (insertion-ordered, cap
  2000, evict oldest) so create + repeated updates never double-screen the
  same URL; a URL is only ever screened once per message. (No cross-message
  caching — that's the pre-agreed no-verdict-cache simplification.)

---

## 7. Flow changes in `src/index.js`

### 7.1 `messageCreate` (replaces current steps 2-4)

1. Resolve channel config: `channelMode = cfg.channels[message.channel.id]?.mode`
   (thread parent chain as today, `isChannelConfigured` unchanged).
2. Pick first screenable attachment via `classifyAttachment(att, gates)`
   → `player-video` | `image` | null.
3. Size gate: `att.size > maxFileMb MB` → skip + log (fail-open). Applies to
   both classes (single threshold; images formerly capped at 15MB are now
   screened up to the threshold — behavior change, intended).
4. Download (`downloadImageWithCap(url, maxBytes)`).
5. Route:
   - `player-video` → write temp file → `enqueueVideo(path, 'player-video')`
     (queue holds only the PATH — RAM-safe).
   - `image` → `sniffImage(buffer)`:
     - animated → temp file → `enqueueVideo(path, 'autoplay-animation')`
     - static jpeg/png → `enqueueImage(buffer, contentType)` (unchanged)
     - static other → `normalizeStillImage` → `enqueueImage`
6. If NO screenable attachment AND message has embeds/text URLs →
   link screening (§7.2) immediately (covers direct links posted with no
   unfurl wait).
7. Verdict unsafe → action flow unchanged (timeout → delete → staff alert),
   alert extended per §7.3.

### 7.2 `messageUpdate` (new listener) + shared link path

- Guard: guild message, not bot/webhook, channel configured. Don't diff
  against oldMessage (may be partial/uncached) — the dedupe map makes
  re-extraction cheap and idempotent.
- `extractCandidateUrls(message)` → for each URL not in the dedupe map:
  mark it, `fetchGuarded(url, maxBytes)` → skip null results; classify by
  fetched `contentType` (video/* → player-video, image/* → image) →
  apply the SAME gates (channel mode, animation scope, threshold via
  content-length/stream cap) → route into the same enqueue paths as §7.1.
  Sniffer runs on the downloaded buffer exactly as for attachments
  (autoplay detection is content-based, not extension-based).
- Embed thumbnails count as `image` class (small, but they're what rendered
  in chat — a NSFW thumb flags). They pass the threshold trivially.
- Player-site embeds (YouTube etc.) die at the content-type gate — nothing
  to screen.

### 7.3 Staff alert & FP-restore (video/animation/link verdicts)

Alert embed (extends current): fields `Sampled Frames:
6 (t=0.0s, 0.4s, …)` / `(frames 0, 3, 7…)`, `Flagged At: t=2.0s (frame 4)`,
`Source: attachment | link`, `Original File: <url>` (attachment CDN URL or
the screened link). Embed image = `attachment://flagged_frame.jpg` with the
flagged frame's JPEG as the file (staff see the evidence inline).

FP-approval (`handleFalsePositiveApproval`): prefer re-posting the
**original media** — fetch the `Original File` URL, re-upload it as a file
attachment to the original channel with the author-attribution embed
(same styling as today). CDN expiry (~24h) → fallback: restore the flagged
frame image + note. All steps individually try/caught, permissions unchanged.

Boot-time temp sweep: `readdirSync(os.tmpdir())`, `rmSync` stale `lumia-*`
dirs older than 24h (crash leftovers). ~6 lines.

---

## 8. `src/safety.js` changes

- `enqueueImage(buffer, contentType)` — today's behavior, 90s job timeout.
- `enqueueVideo(filePath, classHint)` — NEW, ONE queue job per media:
  1. `extractFrames(filePath, {classHint})`
  2. loop frames: `evaluateImage(frame.buffer, 'image/jpeg', signal)`
  3. **short-circuit** at the first unsafe verdict (quota saver; keep that
     frame's buffer + t/index)
  4. resolve `{ safe, categories (union), framesTotal, framesScreened,
     flaggedAt, flaggedFrameBuffer, sourceUrl }`
  5. `finally`: delete temp dir + temp media file.
  Job timeout: **300s** (extraction + up to 12 calls; retry storms can still
  blow it → fail-open, documented).
- **Throttle**: module-level `lastCallAt` in `evaluateImage`; before each
  attempt `await sleep(max(0, 1600 - (now - lastCallAt)))` → hard ceiling
  ~37.5 calls/min regardless of endpoint latency. (~4 lines.)
- Otherwise unchanged: fixed prompt, retries 5s/15s/45s, 202 polling, 30s
  request timeout, queue 50 max sequential.

**Aggregation**: `safe` = all screened frames safe; `categories` = union,
first-appearance order; short-circuit makes `framesScreened < framesTotal`
possible (verdict is already final — only infrastructure errors after a
short-circuit matter, and none exist).

---

## 9. Failure-mode table

| Failure | Outcome |
|---|---|
| Unlisted extension/contentType | skip (not screenable) |
| Class gated off (mode/scope) | skip + debug log |
| File above threshold | skip + log (fail-open) |
| Download/stream over cap | skip + log (fail-open) |
| SSRF guard rejects host (private IP) | skip + log |
| Link fetch non-media content-type / non-2xx | skip + log |
| Dedupe hit (already screened for this message) | skip silently |
| ffprobe/ffmpeg/webpmux failure, 0 frames | job rejects w/ stderr snippet → fail-open |
| Frame API call fails after retries | job rejects → fail-open (message stays) |
| Video job > 300s | abort → fail-open |
| Queue ≥ 50 pending | reject at enqueue → fail-open |
| Temp cleanup fails | log only; boot sweep bounds it |

Fail-open rationale unchanged (AGENTS.md).

---

## 10. Resource budget (SHARED 2-core / 12 GB host)

The host also runs two other Docker services (budgeting + stock trackers).
Lumia must be a polite neighbor:

- **CPU**: all ffmpeg calls use `-threads 1 -filter_threads 1`; extraction
  is serialized inside the queue → **at most one single-threaded decode at
  a time**, typically 1-3s per frame seek on 1080p. Node itself is idle
  between events. Optional guardrail in run docs:
  `docker run … --cpus=1.5 --memory=1g lumia`.
- **RAM**: videos spool to disk immediately; queue holds PATHS (worst case
  50 paths ≈ 0 MB). Image buffers ≤ threshold each; frames are ≤ ~500KB
  JPEGs, ≤ 12 at a time. Steady RSS ≈ 120MB; ffmpeg burst 200-400MB.
  Leaves ≥ 10GB for the co-tenants.
- **Disk**: /tmp holds ≤ 1 active job's spool (≤ threshold) + frame dir;
  `finally` cleanup + boot sweep bound it. Docker overlay absorbs it; no
  extra volume needed (config volume unchanged).
- **API quota**: 40 RPM → 1.6s spacing ceiling 37.5/min. Worst case one
  60s+ video = 12 calls ≈ 20s serialized. Raid of N videos queues serially;
  overflow → fail-open + logs; `/lumia animations autoplay` is the global
  brake, per-channel `images` mode is the fine-grained one.
- **Latency (honest)**: flagged video/link stays visible ~20-60s (worst
  300s) before action vs ~3-5s for images. Pre-emptive delete-then-screen
  is fail-closed — rejected by project philosophy. Documented residual.

---

## 11. Test plan (`node --test`)

- `test/sniff.test.js` — pure: gif (2 descriptors → animated; 1 → static),
  png+acTL → animated, plain png → static, webp ANIM/ANMF → animated,
  VP8L-only → static, avif brand `avis` → animated / `avif` → static,
  jpeg → static, garbage + truncated buffers → `other`, never throws.
- `test/classify.test.js` — matrix incl. gates: `video/mp4` + mode `images`
  → null; + mode `images+videos` + scope `autoplay` → null; + scope `all` →
  player-video; `image/gif` → image always; octet-stream + `.mkv` →
  player-video; `.txt` / null ext → null.
- `test/frames.test.js` — `framesForDuration` table (0/2/5/10/20/60/600s →
  null/4/5/6/8/10/12); index dedupe helper (F=5, N=8 → 5 indices, unique).
- `test/links.test.js` — `extractCandidateUrls`: embeds url fields collected,
  dedupe, text regex + trailing punctuation strip, non-media text URLs
  filtered by `isScreenableLinkUrl`.
- `test/settings.test.js` — array→map migration, defaults deep-merge
  (mode/images+videos, scope/all, maxFileMb/50), round-trip save.
- `test/video.integration.test.js` — skipped unless `ffmpeg` on PATH; uses
  committed `test/fixtures/` binaries (§13 generation commands):
  `extractFrames` per format (mp4/avif input-seek, gif/apng select-by-index,
  webp via webpmux if available) ≥1 frame, buffers > 0, dedupe correct
  (F=5 < 8 → 5 frames); `normalizeStillImage` on still webp → JPEG magic
  `FFD8`.
- Existing `test/parse.test.js` unchanged.

---

## 12. Deliberate simplifications (carry into AGENTS.md as `ponytail:`)

- Frame caps (12 video / 8 autoplay) hardcoded; raise if real misses surface.
- Autoplay webp samples first 6 frames (looped asset); uniform would need
  webpinfo frame counting.
- Animated avif best-effort via isobmff; 0 frames → fail-open.
- Text URLs without a media extension are skipped (no content-probe of
  arbitrary links) — extensionless CDN links slip; add content-probe if real.
- First screenable attachment only; links: all candidates per message.
- Sub-second flash frames between sample points can slip (keyframe anchoring
  mitigates); staff review compensates.
- One queue, extraction serialized — no parallel decode on the shared host.
- `maxFileMb` is per guild, not per channel — per-channel override if ever
  actually needed.
- No cross-message URL/verdict caching (pre-agreed no-verdict-cache).

## 13. Verification checklist (ALL before done)

1. `npm run lint` clean; `npm test` green (all suites above).
2. Generate/commit fixtures (run once):
   ```
   ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -c:v libx264 -pix_fmt yuv420p test/fixtures/sample.mp4
   ffmpeg -f lavfi -i testsrc=duration=1:size=200x200:rate=5 -loop 5 test/fixtures/sample.gif
   ffmpeg -f lavfi -i testsrc=duration=1:size=200x200:rate=5 -plays 0 -c:v apng test/fixtures/sample.apng
   ffmpeg -f lavfi -i testsrc=duration=0.4:size=200x200:rate=5 -c:v libaom-av1 -crf 40 test/fixtures/sample.avif
   ffmpeg -i test/fixtures/sample.gif -c:v libwebp -quality 80 -loop 0 test/fixtures/sample.webp
   ffmpeg -i test/fixtures/sample.gif -frames:v 1 test/fixtures/sample_still.webp
   ```
3. `docker build` ok; in-container: `ffmpeg -version`,
   `ffmpeg -hide_banner -decoders | grep -E "gif|apng|h264|hevc|vp8|vp9|av1|webp"`,
   `webpmux -help`; run integration tests in-container or on host.
4. `node --env-file=.env tools/smoke.js` (extended: + ffmpeg testsrc mp4 →
   extract → one frame screened) — exit non-zero on extraction failure.
   If the NVIDIA key is in its known 403 state, note and retry later.
5. API probes when key recovers (research debt, non-blocking): `video_url`
   support, multi-image requests, animated-gif-as-image behavior (quantify
   the gap this update closes). Note findings in AGENTS.md.
6. Boot check: missing DISCORD_TOKEN → clear error, exit 1 (unchanged).
7. Settings migration check: hand-craft an old-format `data/config.json`
   (array channels), boot once, confirm converted + saved.
8. Manual flow (test guild): post `sample.mp4` in images+videos channel →
   alert with frame table + flagged frame; post gif in images-only channel →
   still screened; post direct .png URL (no attachment) → screened via
   update path; `.maxsize 1` → both posts skipped + logged; Approve (FP) on
   a video alert → timeout lifted + original re-posted.
9. Update `AGENTS.md`: status, flow (classes/gating matrix), file map
   (+ video.js, links.js), settings shape + migration, new commands,
   simplifications (§12), invariants (§14), Dockerfile.

## 14. New invariants (carry into AGENTS.md)

- User message text is STILL never sent to the model — URL extraction is
  local-only; only fetched media bytes + the fixed prompt leave the box.
- Link fetches are SSRF-guarded: http/https only, public IPs only
  (post-DNS), ≤ 3 validated redirects, stream capped.
- Animated images are never sent to the API as-is (extraction always).
- Frames leave as `image/jpeg` data URIs with the fixed prompt.
- Temp files live in `os.tmpdir()/lumia-*`, always cleaned in `finally`,
  swept at boot.
- ffmpeg is single-threaded (shared host); at most one decode at a time.
- Animation length is never a moderation criterion (only the filesize
  threshold is).
