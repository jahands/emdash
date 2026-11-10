---
"@emdash-cms/admin": patch
---

Reduces image downloads when opening content in the editor. Local images load a resized preview once their current media version is known, and images with known dimensions load as they approach the viewport. Replaced media still refreshes, and previews fall back to the original if resizing fails.
