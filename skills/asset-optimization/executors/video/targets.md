---
title: Video - targets
status: draft
---

# Video: targets

Once the surface is known ([`../../surface.md`](../../surface.md)), map it to a codec and container:

| Surface | Baseline (reach) | Progressive / conditional |
|---------|------------------|---------------------------|
| Web (2026) | **H.264 MP4** (faststart) | VP9/WebM, then AV1 for the smallest tier |
| GitHub inline | **MP4 upload** (inline player) | keep it short and downscaled |
| Mobile app bundle | **H.264**, or **HEVC** | HEVC only where the platform decodes it |

Pick the baseline for reach; add a smaller codec as progressive enhancement only where the surface
decodes it. Reference platform limits (max size, max duration, dimensions) when a hard ceiling applies.
