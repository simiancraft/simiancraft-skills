---
title: Raster - targets
status: draft
---

# Raster: targets

Once the surface is known ([`../../surface.md`](../../surface.md)), map it to a raster format:

| Surface | Default | Progressive / conditional | Avoid |
|---------|---------|---------------------------|-------|
| Web (2026) | **WebP** | AVIF via `<picture>` with a WebP/JPEG fallback | HEIC, JXL |
| GitHub inline | PNG / JPEG / **WebP** | none | HEIC, JXL, AVIF |
| Mobile app bundle | **WebP** | AVIF where the RN image stack supports it | oversized PNG |
| Apple-native | **HEIC**, or PNG/JPEG | JXL where the deployment target supports it | assuming HEIC travels |
| Print / design master | lossless PNG/TIFF | none | lossy re-encode of a master |

**HEIC / JXL:** strong encoders, thin reach. HEIC is the iOS default since iOS 11 but near-useless
off Apple; JXL support is still narrow in 2026. Emit either only when the surface provably renders
it. On the open web or GitHub, funnel to WebP with AVIF as progressive enhancement.
