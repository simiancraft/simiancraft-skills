---
title: Animation - size expectations
status: draft
---

# Animation: size expectations

Data-driven. Populate from real runs. Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Notes |
|--------|-----------------|--------|-------|---------|-------|
| _e.g. UI walkthrough GIF_ | `gifsicle -O3 --lossy=80 --colors 128` | _TBD_ | _TBD_ | _TBD_ | within-GIF |
| _same source_ | `gif2webp -q 70` | _TBD_ | _TBD_ | _TBD_ | format change |
| _same source_ | `ffmpeg -> h264 mp4` | _TBD_ | _TBD_ | _TBD_ | see video |

Qualitative expectation (confirm with data): for anything longer than a couple of seconds or with
photographic content, converting to video beats every in-GIF optimization by a wide margin, because
GIF has no interframe compression.
