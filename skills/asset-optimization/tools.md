---
title: Tool manifest
summary: the registry of every CLI tool the executors use, defined once (what it does, install, official docs, key facts and footguns) and referenced by name; a tool may serve more than one kind
status: draft
---

# Tool manifest

Every executor's prerequisites point here. A tool is defined once and reused across kinds (ffmpeg
serves video, audio, and animation; ImageMagick and libvips serve raster and cross-kind inspection).
We keep the useful facts and a link to the authoritative docs, not every switch; the curated commands
live in each executor's `cookbook.md`, and the exhaustive surface lives behind the docs link.

Columns: **Kinds** it serves, **What** it does, **Install** hint, **Docs**, and **Key facts** (the
gotchas worth knowing before you run it). Install shows `brew` and `apt` separately where the package
names diverge.

## Orchestrators and inspection (cross-kind)

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **ffmpeg** | video, audio, animation | the A/V workhorse: transcode, scale, resample, trim, normalize, strip streams, video-to-GIF | `brew/apt install ffmpeg` | ffmpeg.org/ffmpeg.html | exposes x264/x265/vp9/av1/aac/opus/mp3/flac; check `-encoders` for what this build has |
| **ffprobe** | all | machine-readable inspection (codec, bitrate, duration, dims, fps, pix_fmt, color, streams) | ships with ffmpeg | ffmpeg.org/ffprobe.html | house query style: `-of default=noprint_wrappers=1:nokey=1` and `-of csv=p=0` for single fields |
| **MediaInfo** | video, audio | cleaner high-level reports; good for repo inventory and before/after manifests | `brew/apt install mediainfo` | mediaarea.net/MediaInfo | `--Output=JSON` for structured reports |
| **ImageMagick** | raster | universal raster orchestration: convert, resize, crop, composite, inspect, compare | `brew/apt install imagemagick` | imagemagick.org | recipes use `convert`, `identify`, `compare`, `mogrify` (run on v6 and v7); v7 also offers the unified `magick`; **`mogrify` edits in place** |
| **libvips** | raster | high-throughput resize/convert for large images and big batches | brew: `vips`; apt: `libvips-tools` | libvips.org | `vips`, `vipsheader`, `vipsthumbnail`; faster and lower-memory than ImageMagick at scale |
| **ExifTool** | all | read/copy/rewrite/strip EXIF, XMP, ICC, GPS, thumbnails | brew: `exiftool`; apt: `libimage-exiftool-perl` | exiftool.org | metadata strip is a real byte win; do not strip a needed ICC profile or the orientation tag |
| **libheif** (`heif-convert`) | raster | decode HEIC/HEIF input to PNG/JPEG for re-encoding | brew: `libheif`; apt: `libheif-examples` | github.com/strukturag/libheif | HEIC is the Apple default; decode it to a web format before optimizing |
| **chromaprint** (`fpcalc`) | audio, video | acoustic fingerprint; content-identity before/after check | brew: `chromaprint`; apt: `libchromaprint-tools` | acoustid.org/chromaprint | via ffmpeg `-f chromaprint -fp_format base64`, or `fpcalc -raw` |

## Raster: PNG

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **oxipng** | raster, animation | best general lossless PNG optimizer, multithreaded (+ limited APNG) | `brew install oxipng` / `cargo install oxipng` | github.com/oxipng/oxipng | modern default over optipng; `--strip safe` keeps meaningful chunks (`--strip all` drops them) |
| **pngquant** | raster | lossy palette reduction, alpha-aware; UI/screenshots/sprites | `brew/apt install pngquant` | pngquant.org | `--quality=min-max` exits nonzero and writes nothing if the floor is unmet; do not use on photos that need full color |
| **optipng** | raster | established lossless (filters + Deflate) | `brew/apt install optipng` | optipng.sourceforge.net | superseded by oxipng for new work |
| **zopflipng** | raster | exhaustive lossless, very slow; final release builds | part of google/zopfli | github.com/google/zopfli | archived upstream; not a primary default |
| **pngcheck** | raster, animation | validate CRC, chunk structure, APNG integrity | `brew/apt install pngcheck` | libpng.org/pub/png/apps/pngcheck.html | the PNG and APNG validate gate |

## Raster: JPEG

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **jpegli / cjpegli** | raster | modern JPEG encoder, better ratio, ordinary-JPEG compatible | via libjxl | github.com/libjxl/libjxl | strong default for new JPEG when available |
| **MozJPEG / cjpeg** | raster | perceptually tuned JPEG, progressive, optimized tables | `brew install mozjpeg` | github.com/mozilla/mozjpeg | **MozJPEG's `cjpeg` reads PNG input; stock libjpeg-turbo `cjpeg` does not** |
| **jpegtran** | raster | lossless JPEG transforms (rotate/crop/progressive/optimize) | ships with libjpeg-turbo | libjpeg-turbo.org | no re-encode; `-copy none` strips metadata |
| **jpegoptim** | raster | batch optimize, strip metadata, lossless Huffman, optional quality cap | `brew/apt install jpegoptim` | github.com/tjko/jpegoptim | good for directory sweeps |
| **libjpeg-turbo** | raster | fast `cjpeg`/`djpeg`/`jpegtran` + benchmarking | brew: `jpeg-turbo`; apt: `libjpeg-turbo-progs` | libjpeg-turbo.org | throughput + broad compat |

## Raster: WebP / AVIF / JXL

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **cwebp / dwebp** (libwebp) | raster | encode PNG/JPEG/TIFF/raw to lossy/lossless WebP; decode | `brew/apt install webp` | developers.google.com/speed/webp | `-q`, `-m 6`, `-lossless -z 9`, `-alpha_q` (lossy alpha only), target-size mode |
| **webpinfo / webpmux** | raster, animation | validate WebP; add/inspect metadata, animation frames, ICC | with libwebp | developers.google.com/speed/webp | webpinfo is the WebP validate gate |
| **img2webp / gif2webp** | animation | animated WebP from frames; GIF to animated WebP | with libwebp | developers.google.com/speed/webp | animated WebP usually far smaller than GIF |
| **avifenc / avifdec** (libavif) | raster | encode JPEG/PNG/Y4M to AVIF; decode | brew: `libavif`; apt: `libavif-bin` | github.com/AOMediaCodec/libavif | `--codec aom --speed S -q Q`; slower than WebP, smaller; `avifdec --info` validates |
| **cjxl / djxl / jxlinfo** (libjxl) | raster | JPEG XL encode (incl. lossless JPEG transcode), decode, inspect | brew: `jpeg-xl`; apt: `libjxl-tools` | github.com/libjxl/libjxl | thin viewer support in 2026; emit only where the target renders it |

## Vector: SVG

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **svgo** | vector | primary web-SVG optimizer; strips cruft, simplifies paths | `npm i -g svgo` / `bunx svgo` | svgo.dev | do NOT enable `removeViewBox`; default `cleanupIds` removes/minifies ids and cannot see external CSS/JS references, so disable it via config when ids are referenced externally |
| **scour** | vector | Python SVG cleaner; conservative pass | `pipx install scour` | github.com/scour-project/scour | when a Python-native dep is preferred |
| **Inkscape CLI** | vector, document | convert/normalize/inspect/rasterize SVG/PDF/EPS | `brew/apt install inkscape` | inkscape.org | heavy dependency; use when renderer fidelity must match Inkscape |
| **resvg** | vector | deterministic static SVG render to PNG (regression refs) | `cargo install resvg` | github.com/linebender/resvg | no scripts/events/animation by design |
| **rsvg-convert** | vector | render SVG to PNG/PDF/PS/EPS via librsvg | `brew/apt install librsvg2-bin` | gitlab.gnome.org/GNOME/librsvg | headless conversion pipelines |
| **Potrace** | vector | trace high-contrast bitmap to SVG paths | `brew/apt install potrace` | potrace.sourceforge.net | logos/line-art only, not photos |

## Animation: GIF and animated WebP

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **gifsicle** | animation | optimize existing GIF: palette, frames, resize, crop, lossy | `brew/apt install gifsicle` | lcdf.org/gifsicle | the default for an already-made GIF; `-O3 --lossy --colors` |
| **gifski** | animation | high-quality GIF from frames/PNG sequence (per-frame palettes) | `cargo install gifski` | gif.ski | better quality, sometimes larger output |
| **ffmpeg palettegen/paletteuse** | animation | video-to-GIF with explicit fps/scale/dither/palette | ffmpeg | ffmpeg.org | single-invocation `split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse` |

## Video: encoders, containers, quality

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **x264** | video | H.264 encoder; broadest compatibility | with ffmpeg (`libx264`) | videolan.org/developers/x264.html | the reach baseline; `-pix_fmt yuv420p` + `+faststart` for web |
| **x265** | video | HEVC; better ratio, less universal, licensing | with ffmpeg (`libx265`) | videolan.org/developers/x265.html | `-tag:v hvc1` for Apple playback |
| **SVT-AV1** | video | fast scalable AV1 | ffmpeg `libsvtav1` | gitlab.com/AOMediaCodec/SVT-AV1 | best speed/size AV1 tradeoff |
| **rav1e** | video | Rust AV1, memory-safe | ffmpeg `librav1e` | github.com/xiph/rav1e | focused AV1 impl |
| **libaom / aomenc** | video | reference AV1, high quality, slow | ffmpeg `libaom-av1` | aomedia.googlesource.com/aom | quality ceiling, offline only |
| **HandBrakeCLI** | video | preset-driven H.264/H.265/AV1, device/web presets | `brew/apt install handbrake-cli` | handbrake.fr/docs | `--preset-list` to see this build's presets; easier than hand-built ffmpeg for ordinary jobs |
| **MP4Box / GPAC** | video | repackage/fragment/DASH without re-encode | `brew/apt install gpac` | gpac.io | container work, streams untouched |
| **MKVToolNix** | video | MKV/WebM container editing, stream add/remove | `brew/apt install mkvtoolnix` | mkvtoolnix.download | no transcode |
| **Bento4** | video | MP4 inspect, DASH/HLS packaging | `brew install bento4` | bento4.com | web-video pipelines |
| **AtomicParsley** | video | MP4/M4A metadata edit without recompress | `brew/apt install atomicparsley` | github.com/wez/atomicparsley | tags only |
| **libvmaf** | video | Netflix VMAF perceptual metric; drive CRF by quality | ffmpeg `libvmaf` | github.com/Netflix/vmaf | gate quality instead of trusting CRF labels |

## Audio

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **SoX / sox_ng** | audio | batch prep: HQ resample, channels, trim, fades, gain, silence, effects | `brew/apt install sox` | sourceforge.net/projects/sox | dithered bit-depth reduction (`-b 16` + dither), `rate -v`, `stat`/`stats` |
| **opusenc / opus-tools** | audio | dedicated Opus encoder (WAV/AIFF/FLAC/Ogg-FLAC/raw PCM in) | `brew/apt install opus-tools` | opus-codec.org | `--vbr --comp 10 --downmix-mono`, `--discard-pictures` |
| **FLAC** | audio | lossless (WAV/AIFF/RF64/Wave64/raw PCM/FLAC) | `brew/apt install flac` | xiph.org/flac | `-8` is the max preset (implies `-A tukey(0.5)`); to beat it use `-A subdivide_tukey(5)` or `-8ep`; `--test` = the lossless validate gate |
| **metaflac** | audio | FLAC metadata without decode/re-encode | with flac | xiph.org/flac | `--remove --block-type=PADDING,PICTURE` drops padding + art (byte win) |
| **LAME** | audio | dedicated MP3 encoder | `brew/apt install lame` | lame.sourceforge.io | standalone `lame -V 0` is VBR best (ffmpeg's `libmp3lame` spells it `-q:a 0`); use only when MP3 compat is mandatory |
| **ffmpeg-normalize** | audio | batch a folder of files to a loudness target | `pipx install ffmpeg-normalize` | github.com/slhck/ffmpeg-normalize | `-of <dir>` writes to a folder, `-t -14` sets the target; for true album-relative loudness use ReplayGain (rsgain/loudgain) |

## Model / 3D (glTF, GLB, textures)

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **gltf-transform** | model | default workhorse: inspect + `optimize` (dedup/prune/weld/quantize, `--texture-compress webp`/`avif`); KTX2 via `etc1s`/`uastc` | `npm i -g @gltf-transform/cli` | gltf-transform.dev | primary; granular subcommands `draco`/`meshopt`/`etc1s`/`uastc`/`resize` |
| **gltfpack** | model | aggressive one-shot: meshopt geometry + KTX2 textures | github.com/zeux/meshoptimizer | github.com/zeux/meshoptimizer | `-cc -tc`; runtime must support meshopt/KTX2 |
| **Draco** | model | mesh geometry compression codec | github.com/google/draco | github.com/google/draco | normally invoked via gltf-transform/gltfpack, not standalone |
| **toktx** (KTX-Software) | model | KTX2 texture container encode | github.com/KhronosGroup/KTX-Software | github.com/KhronosGroup/KTX-Software | textures usually dominate GLB weight |
| **basisu** (Basis Universal) | model | Basis Universal / KTX2 supercompression | github.com/BinomialLLC/basis_universal | github.com/BinomialLLC/basis_universal | ETC1S (small) vs UASTC (quality) |
| **gltf-validator** | model | validate an optimized GLB still loads | github.com/KhronosGroup/glTF-Validator | github.com/KhronosGroup/glTF-Validator | the model validate gate |

## Document: PDF

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **Ghostscript** (`gs`) | document | rewrite/rasterize PDF/PS/EPS; subset/downsample embedded images | `brew/apt install ghostscript` | ghostscript.com | **materially alters the document; not a harmless lossless optimizer** |
| **qpdf** | document | content-preserving PDF transforms, stream recompress, linearize | `brew/apt install qpdf` | qpdf.sourceforge.io | size reduction is not its primary function; lossless structural cleanup |
| **mutool** (MuPDF) | document | content-preserving PDF clean, stream recompress, inspect | `brew/apt install mupdf-tools` | mupdf.com | `mutool clean -gggz in.pdf out.pdf` recompresses streams losslessly; an alternative to qpdf |

## Font (TTF, OTF, WOFF, WOFF2)

| Tool | Kinds | What | Install | Docs | Key facts |
|------|-------|------|---------|------|-----------|
| **fonttools / pyftsubset** | font | subset glyphs, reduce variable-font axes (`varLib.instancer`), convert to WOFF2 | `pipx install fonttools[woff]` | fonttools.readthedocs.io | subsetting is the dominant win; `--flavor=woff2` outputs WOFF2 directly |
| **woff2** (`woff2_compress`) | font | convert TTF/OTF to WOFF2 (round-trip back via `woff2_decompress`) | `brew/apt install woff2` | github.com/google/woff2 | lossless container recompression, no glyph drop |
| **glyphhanger** | font | discover the glyphs a built site actually uses | `npm i -g glyphhanger` | github.com/zachleat/glyphhanger | drives subsetting from real usage; needs a browser for spidering |
| **fontforge** | font | inspect and convert fonts (fallback) | `brew/apt install fontforge` | fontforge.org | heavyweight; scriptable when fonttools cannot |
