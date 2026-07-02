---
title: Video - size expectations
status: draft
---

# Video: size expectations

Data-driven. Populate from real runs. Do not record an unmeasured number.

| Source | Codec + CRF | Before | After | Savings | VMAF | Notes |
|--------|-------------|--------|-------|---------|------|-------|
| _e.g. screen recording, mov_ | `libx264 crf 23` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | web-safe baseline |
| _same source_ | `libsvtav1 crf 35` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | smallest, slow |
| … | | | | | | |

Heuristic to confirm, not trust: on the x264 CRF ladder each +6 roughly halves size; gate the result
with VMAF rather than believing "CRF 18 = visually lossless."
