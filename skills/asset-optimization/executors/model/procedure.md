---
title: Model / 3D (glTF, GLB) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Model). Curated commands: cookbook.md. Greenfield; verify on real assets."
---

# Model: procedure

A 3D asset: geometry (meshes) plus textures, delivered as glTF (`.gltf` + buffers) or GLB (single
binary). A GLB's weight is usually dominated by its textures, so this kind reaches back into the raster
layer for texture compression. Greenfield relative to the media kinds; treat commands as a starting
point and verify against measured output and a load test.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): gltf-transform (default workhorse), gltfpack
(aggressive one-shot), toktx / basisu (KTX2 textures), gltf-validator (validate).

## Steps

1. **Inspect:** `gltf-transform inspect` for mesh count, texture sizes, and total weight.
2. **Geometry:** dedup, prune, weld, quantize; optionally Draco or meshopt compression.
3. **Textures:** resize to what the material needs, then KTX2 (ETC1S for size, UASTC for quality).
4. **Validate:** `gltf-validator`; confirm the runtime's loader has the matching decoders registered.
5. **Keep only if smaller AND it still loads;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **A texture is the real problem and is being optimized on its own** -> [`../raster/procedure.md`](../raster/procedure.md)
  for the source image, then repack.
