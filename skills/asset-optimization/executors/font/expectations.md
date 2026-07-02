---
title: Font - size expectations
status: draft
---

# Font: size expectations

Data-driven. Populate from real runs. Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Fidelity | Notes |
|--------|-----------------|--------|-------|---------|----------|-------|
| CJK font (fonts-japanese-gothic.ttf) subset to Latin | `pyftsubset --unicodes=U+0000-00FF` (TTF) | 6,235,344 | 31,596 | 99.5% | lossy | **measured** smoke test; CJK to Latin is an extreme case, not typical |
| same source, WOFF2 output | `pyftsubset --unicodes=U+0000-00FF --flavor=woff2` | 6,235,344 | 13,980 | 99.8% | lossy | **measured**; WOFF2 roughly halves the TTF subset |
| _e.g. full Latin TTF_ | `woff2_compress` | _TBD_ | _TBD_ | _TBD_ | lossless | container only |
| … | | | | | | |

Qualitative expectation (confirm with data): WOFF2 conversion alone is a moderate lossless win;
subsetting a large multi-script font to the characters a site uses is usually the dominant reduction.
