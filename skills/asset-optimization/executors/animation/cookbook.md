---
title: Animation - cookbook
status: draft
---

# Animation: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Commands unverified until measured.

### Optimize an APNG (lossless)
**For** an animated PNG you must keep as APNG. **Validate** `pngcheck -v OUT.png`. **Gains** est modest.
```sh
oxipng -o max --strip safe IN.png --out OUT.png
```
> Caveat: oxipng optimizes APNG frames losslessly but will not drop frames; for a big win convert to animated WebP or video.

### Optimize an existing GIF (lossy)
**For** a GIF you must keep as GIF. **Validate** play through; `gifsicle --info OUT.gif`. **Gains** est moderate.
```sh
gifsicle -O3 --lossy=80 --colors 128 IN.gif -o OUT.gif
```

### Reduce colors and resize a GIF (lossy)
**For** an oversized GIF where palette and dimensions dominate. **Validate** `gifsicle --info OUT.gif`. **Gains** est large.
```sh
gifsicle -O3 --colors 64 --resize-width 480 IN.gif -o OUT.gif
```

### Cap a GIF's frame rate (lossy)
**For** a high-fps GIF whose motion tolerates fewer frames. **Validate** play through. **Gains** est proportional to frames dropped.
```sh
ffmpeg -i IN.gif -vf "fps=10" OUT.gif
```

### Convert a GIF to animated WebP (lossy)
**For** the web, where animated WebP is far smaller and still inline. **Validate** `webpinfo OUT.webp`. **Gains** est large vs GIF.
```sh
gif2webp -q 70 -m 6 IN.gif -o OUT.webp
```

### Make a GIF from video, single-pass palette (lossy)
**For** turning a clip into an inline GIF. **Validate** play through. **Gains** n/a (creation).
```sh
ffmpeg -ss 00:00:10 -t 5 -i IN.mp4 \
  -vf "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" OUT.gif
```

### Tune the GIF palette deliberately (lossy)
**For** squeezing a GIF the defaults left large. **Validate** eyeball banding. **Gains** est moderate.
```sh
ffmpeg -ss 00:00:10 -t 5 -i IN.mp4 \
  -vf "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" OUT.gif
```

### Convert a GIF to MP4, the big win (lossy)
**For** any GIF longer than a couple seconds or photographic. **Validate** `ffprobe OUT.mp4`. **Gains** est very large; GIF has no interframe compression.
```sh
ffmpeg -i IN.gif -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p -c:v libx264 -crf 23 -movflags +faststart OUT.mp4
```
> Caveat: drops alpha and looping metadata; `yuv420p` needs even dimensions, so the `scale=trunc(...)` guard rounds an odd GIF size down. See the redirect in `procedure.md` and `../video/`.

### High-quality GIF from a PNG sequence (lossy)
**For** when GIF is required and quality matters more than size. **Validate** play through. **Gains** n/a (creation).
```sh
gifski --fps 20 --width 480 -o OUT.gif frame-*.png
```
