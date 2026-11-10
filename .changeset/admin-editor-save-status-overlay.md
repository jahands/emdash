---
"@emdash-cms/admin": patch
---

Fixes the content editor jumping when a save, autosave, or edit conflict fails: the error now appears over the top of the page and stays in view while you scroll, instead of pushing the editor down. On phones, the toolbar no longer gains a Save button that wrapped it onto a second row. Retry a failed save with Try again in the error notice, or resolve a conflict with Save anyway in the conflict notice. Save returns to the toolbar if you dismiss the error notice.
