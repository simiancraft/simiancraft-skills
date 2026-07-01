---
title: Animation - targets
status: draft
---

# Animation: targets

Once the surface is known ([`../../surface.md`](../../surface.md)), GIF is rarely the answer:

| Surface | Preferred | Notes |
|---------|-----------|-------|
| Web (2026) | **animated WebP**, or **video** for anything non-trivial | GIF is the fallback, not the goal |
| GitHub inline | **GIF** or an **MP4 upload** (inline player) | animated WebP renders inline too |
| Mobile app bundle | short loop -> animated WebP; longer -> bundled video | avoid heavy GIFs |

For anything longer than a couple of seconds or photographic, the target answer is almost always
video; see [`../video/procedure.md`](../video/procedure.md).
