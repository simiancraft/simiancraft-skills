---
title: Model - size expectations
status: draft
---

# Model: size expectations

Data-driven and greenfield. Populate from real runs. Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Loads? | Notes |
|--------|-----------------|--------|-------|---------|--------|-------|
| _e.g. GLB with 2K textures_ | `gltf-transform optimize (draco + ktx2)` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | textures dominate |
| _same source_ | `gltfpack -cc -tc` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | aggressive |
| … | | | | | | |

Qualitative expectation (confirm with data): geometry compression (Draco/meshopt) helps, but the
dominant win on a textured GLB is almost always KTX2 texture supercompression.
