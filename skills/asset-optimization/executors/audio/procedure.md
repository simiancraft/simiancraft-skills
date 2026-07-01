---
title: Audio (WAV, MP3, AAC, Opus, FLAC) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Audio). Curated commands: cookbook.md."
---

# Audio: procedure

A sound asset. Optimization is transcoding to an efficient codec at a bitrate the ear cannot
distinguish from the source, plus optional loudness normalization and dead-air trimming.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): ffmpeg + ffprobe (workhorse + inspect), SoX
(prep: resample/channels/fades), opusenc, FLAC + metaflac, LAME, ffmpeg-normalize (batch/album).

## Steps

1. **Measure first:** astats / ebur128 / volumedetect / silencedetect to read levels before choosing settings.
2. **Choose codec + bitrate** for the target ([`targets.md`](targets.md)); voice tolerates far lower than music.
3. **Prepare** (optional): downmix voice to mono, trim silence, two-pass loudness normalize.
4. **Encode** ([`cookbook.md`](cookbook.md)); strip metadata and cover art for bytes.
5. **Validate:** ffprobe the output; `flac --test` for lossless; a listening spot check.
6. **Keep only if smaller AND valid;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **The audio is a track inside a video** -> optimize it in the video pass, [`../video/procedure.md`](../video/procedure.md).
- **The asset is really music that must stay lossless** (a master, not a delivery file) -> lossless-required;
  keep FLAC/WAV/AIFF and do not re-encode lossy.
