---
title: Model - cookbook
status: draft
---

# Model: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Greenfield; verify subcommands
and flags against your installed versions before trusting them.

### Inspect a glTF or GLB (no change)
**For** seeing where the weight is (geometry vs textures) before choosing a pass. **Validate** n/a. **Gains** none.
```sh
gltf-transform inspect IN.glb
```

### Optimize a GLB, geometry and textures (lossy)
**For** web delivery where the loader supports Draco. **Validate** `gltf-validator OUT.glb`; load in the target runtime. **Gains** est large (textures dominate).
```sh
gltf-transform optimize IN.glb OUT.glb --compress draco --texture-compress webp
```
> Caveat: `optimize --texture-compress` takes `webp` or `avif`; for KTX2/Basis textures use the `etc1s`/`uastc` recipe below instead. The runtime loader must register the Draco (and KTX2, if used) decoders or OUT will not load. Keep an uncompressed source for editing.

### Aggressive one-shot, meshopt and KTX2 (lossy)
**For** maximum compression where the runtime supports meshopt. **Validate** `gltf-validator`; load test. **Gains** est large.
```sh
gltfpack -i IN.glb -o OUT.glb -cc -tc
```

### Compress textures only to KTX2 (lossy)
**For** when geometry is fine but textures are heavy. **Validate** load test. **Gains** est large on textured models.
```sh
gltf-transform etc1s IN.glb OUT.glb        # ETC1S for size; uastc for higher quality
```
> See also [`../raster/cookbook.md`](../raster/cookbook.md) to optimize a texture source image before repacking.
