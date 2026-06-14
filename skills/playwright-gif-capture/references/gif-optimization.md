# GIF optimization: don't make deep-fried, janky, or bloated GIFs

A GIF has three quality axes, and they trade against each other. You cannot max
all three; pick a budget and spend it on purpose.

1. **Color fidelity**: too little and the GIF looks "deep-fried": posterized
   gradients, banding, colors smeared to the nearest of too-few palette entries.
2. **Smoothness**: too few or unevenly-timed frames and it looks "janky":
   stuttering, strobing, motion that skips.
3. **File size**: too big and it won't embed / upload / load. Size is roughly
   `frames x width x height x palette-entropy`; every other axis feeds it.

The rest of this file is the cause → prevention for each, the right tool per
case, and a target-size workflow so you stop guessing.

---

## 1. Color fidelity: avoid deep-fried

**Cause.** GIF is capped at **256 colors per frame**. The naive `ffmpeg out.gif`
falls back to a fixed 256-web-safe palette and no dithering, so anything with
gradients, glow, or photographic color bands hard. Over-reducing colors
(`--colors 32`) to save size is the other way in.

**Prevention: generate an optimal palette, then dither:**

```bash
# two-pass palette (the default for any non-flat content)
ffmpeg -y -i IN -vf "fps=16,scale=720:-1:flags=lanczos,split[a][b];\
[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
-loop 0 out.gif
```

- `palettegen=max_colors=N`: fewer colors = smaller + more deep-fried. Start at
  256; only drop it to trade size (see §3). `stats_mode=diff` weights the palette
  toward moving regions (better for animation); `single` builds a per-frame
  palette (best fidelity, larger).
- `paletteuse=dither=…`: dithering hides banding by trading it for fine noise:
  - `bayer:bayer_scale=5`: ordered dither, **least file-size cost**, slightly
    grainy; the safe default for gradients/glow.
  - `floyd_steinberg` / `sierra2_4a`: error-diffusion, **smoothest** gradients,
    but the noise is high-entropy so it **inflates size** and can shimmer between
    frames. Use for hero/photographic stills, not for size-constrained loops.
  - `none`: no dither, smallest and cleanest on **flat / synthetic** content
    (UI, line art, solid fills); deep-fries anything with a gradient.
- `flags=lanczos` on the scale; high-quality downscale; `bilinear` softens.

**When ffmpeg still bands, use gifski** (per-frame palettes + good diffusion;
best for photographic, gradient-heavy, or many-color frames). Frames in, GIF out:

```bash
gifski -o out.gif --fps 16 --width 720 --quality 90 /tmp/frames/f*.png
```

gifski almost always looks better than ffmpeg on rich color, at a **larger file**;
reach for §3 (gifsicle) afterward if you need it smaller.

---

## 2. Smoothness: avoid jank

**Cause.** Two separate failures: (a) **too few fps**, and (b) **uneven frame
timing**. GIF frame delays are quantized to **centiseconds (1/100 s)**, and many
viewers silently clamp very short delays: anything below ~6 cs is commonly bumped
up to a ~10 fps floor. So a "30 fps" GIF often plays slower, and unevenly, than
intended.

**Prevention:**

- **Capture at a fixed clock, not wall-clock.** Drive the animation time per
  frame (see SKILL.md, method A) so frames are evenly spaced. Wall-clock
  screenshotting inherits render jitter and produces uneven motion.
- **Pick an fps the format respects:** **12–20 fps** is the sweet spot for smooth
  web GIFs. 10 reads as "documentation smooth"; 8 is choppy but tiny; >25 is
  wasted (viewers clamp it and you just pay size). Match the encode `fps` to the
  capture fps exactly; a mismatch makes ffmpeg drop or duplicate frames,
  which is its own stutter.
- **Loop seamlessly** when the content is periodic: capture exactly one period
  (or an integer number) so the last frame flows into the first. `-loop 0` loops
  forever; a visible jump at the wrap is a capture-length bug, not an encode bug.
- **Don't increase fps above the source.** Interpolated/duplicated frames add
  size without smoothness.

---

## 3. File size: hit a budget, then stop

**Cause.** Size grows with **frame count (duration x fps)**, **dimensions**,
**color count**, and **dither entropy**. A 1080p, 30 fps, 5 s, error-diffused GIF
is tens of MB and unshippable.

**Prevention: spend the cheapest axis first.** In order of best
quality-per-byte saved:

1. **Dimensions**: `scale=480:-1` (or `-1` height). Halving width ~quarters
   size. Biggest lever; do this first.
2. **Duration**: trim to the shortest loop that reads. 2–4 s is usually plenty.
3. **fps**: 16 → 12 → 10. Each step is a near-linear size cut.
4. **Colors**: `max_colors` 256 → 128 → 64. Below ~64 it deep-fries; flat
   content tolerates lower.
5. **Dither**: switch error-diffusion → `bayer` → `none` (each smaller).
6. **Lossy post-pass**: gifsicle (below). Last, because it's the most visible.

**gifsicle is the GIF-native size tool** (operates on an existing `.gif`; install
`npm i gifsicle` and use `require('gifsicle').default` for the binary path (the
package is ESM, so the path is on `.default`), or system `apt install gifsicle` /
`brew install gifsicle` if the npm binary download is blocked):

```bash
gifsicle -O3 in.gif -o out.gif                 # lossless: frame dedupe, transparency, LZW
gifsicle -O3 --lossy=80 in.gif -o out.gif      # lossy LZW: 30-50% smaller, mild artifacts; raise to 120-200 for more
gifsicle -O3 --colors 64 in.gif -o out.gif     # drop palette after the fact
gifsicle --resize-width 480 -O3 in.gif -o out.gif   # resize an existing gif
```

`-O3` is free (lossless); always run it. `--lossy=N` (N≈30 subtle … 200
aggressive) is the knob that hits a stubborn budget without re-encoding.

**ImageMagick** for image-frame sources or synthetic content:

```bash
magick -delay 6 -loop 0 frame*.png anim.gif            # delay in centiseconds (6cs ≈ 16fps)
magick anim.gif -fuzz 5% -layers Optimize smaller.gif  # dedupe near-identical pixels/frames
```

`-fuzz N% -layers Optimize` merges almost-equal regions across frames; large
wins on content with a static background, free of quality cost up to a few %.

---

## Tool selection (quick matrix)

| Source | Content | Tool | Why |
|--------|---------|------|-----|
| video/webm | anything | ffmpeg palettegen | one pass, dither control, the default |
| PNG frames | flat / UI / line art | ffmpeg `dither=none` or ImageMagick | crisp, tiny |
| PNG frames | gradients / glow / photo | **gifski** | per-frame palettes beat one global palette |
| any `.gif` | too big | **gifsicle `-O3 [--lossy]`** | GIF-native, no re-encode |
| image frames | static background | ImageMagick `-layers Optimize` | cross-frame dedupe |

---

## The target-size workflow (the anti-guessing loop)

Don't pick numbers blindly. Encode good, measure, then trade in §3 order:

```bash
encode at 720px / 16fps / 256-color / bayer  ->  measure bytes
while size > budget:
  apply the next cheapest cut (dims -> duration -> fps -> colors -> dither -> --lossy)
  re-measure
stop at the first version under budget; don't over-compress
```

Always **print the byte size** and **Read the GIF back** (vision) before
shipping: confirm it isn't banded (deep-fried), isn't stuttering (janky), and is
under the destination's limit. Common budgets: GitHub README/issue inline ≤ ~10 MB
(smaller loads better); Slack message GIF ≤ a few MB at 480²; Slack emoji 128²,
< 3 s, 48–128 colors.

## Craft notes

- **Lines/outlines need width ≥ 2 px** before downscale; 1px strokes alias to
  choppy fragments at GIF scale and palette depth.
- High **contrast** (dark on light / light on dark) survives palette reduction;
  low-contrast adjacent colors merge into mud.
