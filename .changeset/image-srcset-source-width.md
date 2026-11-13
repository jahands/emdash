---
"emdash": patch
---

Fixes responsive images offering `srcset` candidates wider than the uploaded file. Candidates now stop at the image's original width, so browsers no longer download upscaled files or files whose `w` descriptor claims more pixels than they contain.
