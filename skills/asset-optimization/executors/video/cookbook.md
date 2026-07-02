---
title: Video - cookbook
status: draft
---

# Video: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Verify codec availability with
`ffmpeg -encoders`; commands unverified until measured.

## Inspect

### Read codec, dimensions, duration, HDR (no change)
**For** every job; drives codec, sizing, and the HDR guard. **Validate** n/a. **Gains** none.
```sh
ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=noprint_wrappers=1:nokey=1 IN.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 IN.mp4
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 IN.mp4
```

## Encode

### H.264 MP4 web finish (lossy)
**For** the reach baseline: broad playback, progressive start. **Validate** `ffprobe OUT.mp4`; VMAF-gate. **Gains** est large from a raw capture.
```sh
ffmpeg -i IN.mov -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart OUT.mp4
```

### HEVC / H.265 (lossy)
**For** smaller output where the surface decodes HEVC. **Validate** `ffprobe`; VMAF-gate. **Gains** est ~20-30% under x264 (confirm).
```sh
ffmpeg -i IN.mov -c:v libx265 -crf 28 -preset slow -tag:v hvc1 -c:a aac -b:a 128k OUT.mp4
```

### VP9 / WebM constant quality (lossy)
**For** royalty-free web delivery. **Validate** `ffprobe`. **Gains** est similar to HEVC.
```sh
ffmpeg -i IN.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -c:a libopus OUT.webm
```
> Caveat: `-b:v 0` is REQUIRED for true CRF in VP9; omitting it silently caps quality.

### AV1 (SVT-AV1) (lossy)
**For** the smallest tier where AV1 decodes and encode time is acceptable. **Validate** `ffprobe`; VMAF-gate. **Gains** est smallest, slow.
```sh
ffmpeg -i IN.mov -c:v libsvtav1 -crf 35 -preset 6 -c:a aac -b:a 128k OUT.mp4
```

### Downscale to a max dimension (lossy)
**For** an oversized source rendered small. **Validate** `ffprobe` dims. **Gains** est large (resolution dominates bitrate).
```sh
ffmpeg -i IN.mp4 -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 23 -movflags +faststart OUT.mp4
```

### Two-pass to a size ceiling (lossy)
**For** a hard max-bytes target (an upload limit). **Validate** `ffprobe` size + VMAF. **Gains** hits the target by construction.
```sh
# video_kbps = (target_bytes*8/duration_s/1000) - audio_kbps - mux_overhead
ffmpeg -i IN.mp4 -c:v libx264 -b:v ${VIDEO_KBPS}k -pass 1 -an -f null /dev/null
ffmpeg -i IN.mp4 -c:v libx264 -b:v ${VIDEO_KBPS}k -pass 2 -c:a aac -b:a 128k -movflags +faststart OUT.mp4
```
> Caveat: subtract the audio budget or the file overshoots the target by the audio track.

### HandBrake preset one-shot (lossy)
**For** an ordinary job where a curated preset beats hand-tuning. **Validate** `ffprobe`. **Gains** est preset-dependent.
```sh
HandBrakeCLI --preset-list                          # list this build's presets, then pick one
HandBrakeCLI --preset "Fast 1080p30" -i IN.mp4 -o OUT.mp4
```

## Non-destructive

### Remux to faststart without re-encoding (lossless)
**For** a correctly-encoded MP4 that needs web-ready headers. **Validate** `ffprobe`. **Gains** none (bytes about equal); enables progressive play.
```sh
ffmpeg -i IN.mp4 -c copy -movflags +faststart OUT.mp4
```

### Extract audio, copy or re-encode (lossless copy / lossy)
**For** pulling the audio track. **Validate** `ffprobe OUT`. **Gains** n/a.
```sh
ffmpeg -i IN.mp4 -vn -c:a copy OUT.m4a                         # keep original codec
ffmpeg -i IN.mp4 -vn -c:a libopus -b:a 96k OUT.opus            # re-encode smaller
```

### Poster / first frame (lossy)
**For** an inline still preview of a video. **Validate** `identify`. **Gains** n/a.
```sh
ffmpeg -i IN.mp4 -vframes 1 -q:v 3 OUT.jpg
```

## Guard and assemble

### HDR to SDR tonemap (lossy)
**For** delivering an HDR (PQ/HLG) source to an **SDR** target only. This is a deliberate, irreversible color conversion, not a correctness guard: **preserve HDR when the target supports it**, and tonemap only when SDR delivery is explicitly chosen. Prepend it to the video filter chain. **Validate** eyeball vs source; confirm the output is bt709/SDR. **Gains** n/a (format conversion).
```sh
-vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
```
> The `tonemap` operator and the float `gbrpf32le` working format are load-bearing; without them the chain hard-clips highlights instead of compressing them. Tonemapping is one-way; never apply it to an HDR-capable delivery.

### Assemble without re-encoding (lossless)
**For** stitching pre-encoded segments. **Validate** `ffprobe` duration equals the sum. **Gains** none (copy).
```sh
ffmpeg -ss 00:00:05 -i IN.mp4 -t 5 -c copy part.mp4           # -ss before -i = fast seek; -c copy snaps the start to the nearest keyframe
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart OUT.mp4   # list.txt: file 'abs/path'
```
