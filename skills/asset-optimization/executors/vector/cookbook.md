---
title: Vector - cookbook
status: draft
---

# Vector: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Commands unverified until measured.

### Minify an SVG (render-preserving)
**For** any web SVG; strips editor cruft and simplifies paths. **Validate** render before/after with resvg and `compare`. **Gains** est large on tool-exported SVGs, small on hand-tight ones.
```sh
svgo --multipass --config svgo.config.mjs IN.svg -o OUT.svg
```
with a conservative `svgo.config.mjs` that protects external references:
```js
export default { multipass: true, plugins: [{ name: 'preset-default', params: { overrides: {
  cleanupIds: false,      // SVGO cannot see ids referenced from external CSS or JS
  removeViewBox: false,   // keep responsive scaling
} } }] };
```
> Not strictly lossless: default float and path precision rounding is render-preserving, not bit-exact. `cleanupIds: false` is required whenever ids are referenced from outside the file.

### Minify a directory of SVGs (lossless)
**For** an icon set. **Validate** spot-render a few. **Gains** est per-file; report a total.
```sh
svgo --multipass -f ./icons -o ./icons-min
```

### Render an SVG to PNG for a regression check (no change to SVG)
**For** proving a minify pass did not alter rendering. **Validate** `compare before.png after.png diff.png`. **Gains** n/a.
```sh
resvg IN.svg OUT.png
```

### Trace a bitmap logo to SVG (lossy)
**For** turning a high-contrast raster logo or line-art into scalable vector. **Validate** eyeball vs source. **Gains** n/a (conversion); usually smaller and now scalable.
```sh
convert IN.png -threshold 50% IN.pbm && potrace IN.pbm -s -o OUT.svg
```
> Caveat: logos and line art only, not photographs. See also [`../raster/cookbook.md`](../raster/cookbook.md) for a photographic source.
