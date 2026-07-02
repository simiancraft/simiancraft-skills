---
title: Raster - cookbook
status: draft
---

# Raster: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Commands are unverified until run and
measured; **Gains** are `est` until a real before/after lands in [`expectations.md`](expectations.md).

## Inspect first

### Read an image's shape (no change)
**For** every optimization; decide fidelity and format from facts. **Validate** n/a. **Gains** none.
```sh
identify -verbose IN.png | sed -n '1,20p'
exiftool -ColorSpace -ICC_Profile:all -Orientation -ImageSize IN.png
```

## PNG

### Shrink a PNG-24 losslessly (lossless)
**For** flat UI, screenshots, any PNG where a pixel is load-bearing. **Validate** `pngcheck OUT.png`. **Gains** est modest, source-dependent.
```sh
oxipng -o max --strip safe IN.png --out OUT.png
```
> Caveat: `--strip safe` keeps critical chunks; `--strip all` can drop a needed ICC profile, gamma, or DPI.

### Quantize a flat-color PNG (lossy)
**For** UI, icons, sprites with few colors that must keep alpha. **Validate** `pngcheck OUT.png`; eyeball alpha edges. **Gains** est large on 24-bit UI art.
```sh
pngquant --quality=70-90 --strip -o OUT.png IN.png && oxipng -o 4 --strip safe OUT.png
```
> Caveat: pngquant exits nonzero and writes nothing when it cannot meet the `--quality` floor (or, with `--skip-if-larger`, when the result is not smaller), so the chained `oxipng OUT.png` then fails on a missing file; guard it, or optimize `IN.png` instead.

## JPEG

### Encode a photo to JPEG (lossy)
**For** photographic content, no alpha. **Validate** reopen, or `djpeg OUT.jpg >/dev/null`. **Gains** est large vs a PNG-24 photo.
```sh
cjpegli -q 85 IN.png OUT.jpg          # jpegli (modern); or MozJPEG: cjpeg -quality 80 -optimize -progressive IN.png > OUT.jpg
```
> Note: MozJPEG's `cjpeg` reads PNG; stock libjpeg-turbo `cjpeg` does not.

### Re-pack an existing JPEG (lossless)
**For** an already-lossy JPEG you must not re-degrade. **Validate** reopen. **Gains** est small.
```sh
jpegtran -copy none -optimize -progressive IN.jpg > OUT.jpg
```

## WebP / AVIF / JXL

### Encode to WebP, lossy (lossy)
**For** the web default in 2026. **Validate** `webpinfo OUT.webp`. **Gains** est ~25-35% under comparable JPEG (confirm).
```sh
cwebp -q 82 -m 6 IN.png -o OUT.webp
```

### Encode to WebP, lossless with alpha (lossless)
**For** flat art or icons that need alpha and exact pixels. **Validate** `webpinfo OUT.webp`. **Gains** est varies.
```sh
cwebp -lossless -z 9 IN.png -o OUT.webp
```

### Encode to AVIF (lossy)
**For** progressive-enhancement web where the surface renders AVIF. **Validate** `avifdec --info OUT.avif`. **Gains** est smaller than WebP at equal quality, slower.
```sh
avifenc --codec aom --speed 6 -q 70 IN.png OUT.avif
```

### Encode to JPEG XL (lossy; only where the target renders it)
**For** a surface that provably renders JXL (not the open web or GitHub in 2026). **Validate** `jxlinfo OUT.jxl`. **Gains** est strong, but reach is thin.
```sh
cjxl -q 90 IN.png OUT.jxl
```

## Convert, resize, batch

### Convert an Apple HEIC to a web format (lossy)
**For** a HEIC or HEIF photo bound for the web, which cannot render HEIC. **Validate** `webpinfo OUT.webp`. **Gains** est situational; HEIC is already efficient, but unusable on the web.
```sh
heif-convert IN.heic tmp.png && cwebp -q 82 -m 6 tmp.png -o OUT.webp
```

### Downscale an oversized capture then encode (lossy)
**For** a full-screen or retina capture rendered small inline. **Validate** `identify OUT.webp`. **Gains** est large (dimensions dominate bytes).
```sh
vipsthumbnail IN.png --size 1600x --output 'OUT.webp[Q=82]'    # or: convert IN.png -resize 1600x OUT.webp
```

### Batch a directory to WebP (lossy)
**For** a folder of raster assets bound for the web. **Validate** `webpinfo` each output (in the loop). **Gains** est per-file; report a total.
```sh
shopt -s nullglob
for f in *.png *.jpg; do cwebp -q 82 -m 6 "$f" -o "${f%.*}.webp" && webpinfo "${f%.*}.webp" >/dev/null; done
```
> Caveat: `foo.png` and `foo.jpg` both map to `foo.webp`; disambiguate when both exist. `nullglob` stops an unmatched `*.jpg` reaching cwebp.

### Strip metadata without recompressing (lossless)
**For** shedding EXIF, GPS, and thumbnails from a JPEG with no new lossy generation. **Validate** `exiftool OUT.jpg`; `identify -format '%[orientation]'`. **Gains** est small.
```sh
exiftool -all= -o OUT.jpg IN.jpg              # copies the pixels byte-for-byte, drops metadata
# also lossless, and re-optimizes Huffman tables: jpegtran -copy none -optimize IN.jpg > OUT.jpg
```
> Caveat: this preserves the pixels and the orientation tag's value; it does not bake rotation. If a viewer ignores EXIF orientation, use the next recipe.

### Bake orientation and convert to sRGB (lossy re-encode)
**For** a delivery JPEG that must render upright and in sRGB regardless of viewer EXIF support. **Validate** `identify -format '%[orientation]'`; eyeball rotation and color; compare bytes (it may grow). **Gains** n/a (a re-encode).
```sh
convert IN.jpg -auto-orient -colorspace sRGB -quality 85 -strip OUT.jpg
```
> Caveat: `convert` decodes and re-encodes the JPEG (a new lossy generation), so set `-quality` explicitly and validate perceptually; prefer the metadata-only recipe when you do not need baked rotation.
