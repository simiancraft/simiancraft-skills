---
title: Model - targets
status: draft
---

# Model: targets

Once the surface is known ([`../../surface.md`](../../surface.md)), the constraint is which decoders the
runtime has, not which format renders:

| Surface | Preferred | Notes |
|---------|-----------|-------|
| Web 3D (three.js, Babylon, model-viewer) | **Draco geometry + KTX2 textures** (meshopt where supported) | the loader must register the decoders |
| Editor / DCC handoff | uncompressed GLB or `.gltf`+`.bin` | keep editable; compression is a delivery step |
| Native / AR | platform-specific (USDZ territory) | out of scope for now; note and defer |

Textures usually dominate GLB weight, so the biggest win is KTX2 texture compression, which ties back
to [`../raster/procedure.md`](../raster/procedure.md) for the source images.
