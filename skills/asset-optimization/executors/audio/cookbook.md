---
title: Audio - cookbook
status: draft
---

# Audio: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Commands unverified until measured.

## Measure first

### Read levels before encoding (no change)
**For** choosing loudnorm target and bitrate from facts. **Validate** n/a. **Gains** none.
```sh
ffmpeg -i IN.wav -af "astats=metadata=1:reset=1" -f null -     # RMS, peak, crest, bit depth
ffmpeg -i IN.wav -af "ebur128=peak=true" -f null -            # integrated LUFS, LRA, true peak
ffmpeg -i IN.wav -af "silencedetect=noise=-30dB:d=0.5" -f null -
```

## Prepare (SoX)

### High-quality resample and dither before encoding (lossy)
**For** changing sample rate or bit depth cleanly before a lossy encode. **Validate** `soxi OUT.wav`; listen. **Gains** n/a (prep).
```sh
sox IN.wav -b 16 OUT.wav rate -v 48000 dither      # HQ resample plus TPDF dither on downconvert
```

## Normalize

### Two-pass measured loudness normalize (lossy)
**For** hitting a loudness target accurately. **Validate** re-run `ebur128`; confirm the target. **Gains** n/a (loudness, not size).
```sh
ffmpeg -i IN.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -   # pass 1: prints measured_*
ffmpeg -i IN.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true -ar 48000 OUT.wav
```
> Caveat: pin `-ar 48000` after loudnorm or it resamples to 192k.

### Batch a folder to a loudness target (lossy)
**For** normalizing many files to the same target (for true album-relative loudness use ReplayGain: rsgain or loudgain). **Validate** `ebur128` per track. **Gains** n/a (loudness).
```sh
ffmpeg-normalize *.wav -c:a libopus -b:a 96k -t -14 -of out/
```

## Encode

### Encode to Opus (lossy)
**For** web or app, best quality-per-byte. **Validate** `ffprobe OUT.opus`; listen. **Gains** est large vs WAV.
```sh
ffmpeg -i IN.wav -c:a libopus -b:a 96k OUT.opus
opusenc --bitrate 96 --vbr --comp 10 IN.wav OUT.opus          # opusenc alternative; --downmix-mono for voice
```

### Encode to AAC or MP3 for reach (lossy)
**For** maximum player compatibility. **Validate** `ffprobe`; listen. **Gains** est large vs WAV.
```sh
ffmpeg -i IN.wav -c:a aac -b:a 128k OUT.m4a
ffmpeg -i IN.wav -c:a libmp3lame -q:a 4 OUT.mp3               # VBR; libmp3lame is the LAME encoder
```

### Voice: downmix to mono, low bitrate (lossy)
**For** speech or narration where stereo and high bitrate are wasted. **Validate** listen. **Gains** est large.
```sh
ffmpeg -i IN.wav -ac 1 -c:a libopus -b:a 64k OUT.opus
```

### Max lossless FLAC (lossless)
**For** a delivery copy that must stay lossless. **Validate** `flac --test OUT.flac`. **Gains** est ~40-60% vs WAV (confirm).
```sh
flac -8 -A "subdivide_tukey(5)" -o OUT.flac IN.wav
```
> Note: `-8` already implies `-A tukey(0.5)`; `subdivide_tukey(5)` (or `-8ep`) is what actually beats the default.

## Trim, strip, verify

### Trim silence head and tail (lossy for lossy inputs)
**For** shaving dead air to cut duration and bytes. **Validate** listen for clipped starts. **Gains** est proportional to silence removed.
```sh
ffmpeg -i IN.wav -af "silenceremove=start_periods=1:start_silence=0.5:start_threshold=-50dB:stop_periods=1:stop_silence=0.5:stop_threshold=-50dB" OUT.wav
```

### Strip metadata and cover art (lossless for the audio stream)
**For** shedding tags and embedded art bytes. **Validate** `ffprobe` / `metaflac --list`. **Gains** est small to large (art dominates).
```sh
ffmpeg -i IN.mp3 -map 0:a -map_metadata -1 -c:a copy OUT.mp3
cp IN.flac OUT.flac && metaflac --remove --block-type=PADDING,PICTURE OUT.flac
```

### Verify the audio is unchanged after a lossless op (no change)
**For** confirming a strip or remux did not alter the decoded samples. **Validate** the two digests match. **Gains** none (check).
```sh
ffmpeg -i IN.flac -map 0:a -f framemd5 - ; ffmpeg -i OUT.flac -map 0:a -f framemd5 -   # decoded-PCM per-frame MD5; must be identical
```
> This is an exact-sample check. `fpcalc` (chromaprint) is a perceptual fingerprint for fuzzy content-identity, not a lossless proof.

### Extract audio from a video, copy (lossless)
**For** pulling a track without re-encoding. **Validate** `ffprobe`. **Gains** n/a.
```sh
ffmpeg -i IN.mp4 -vn -c:a copy OUT.m4a
```
> Caveat: `-c:a copy` into `.m4a` only works if the source audio is AAC or ALAC; for another codec pick a matching container (`.opus`, `.mka`) or re-encode.
