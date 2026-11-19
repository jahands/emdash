---
"@emdash-cms/admin": patch
---

Speeds up typing in long rich text entries. A keystroke now converts, serializes and checks only the block it changed, and no longer re-renders the whole editor and the other fields. In a 600-paragraph post with a 4x slower CPU, the 95th-percentile delay from key press to screen update drops from about 85–145 ms to about 35–50 ms. Autosave, Save, undo and the word count work as before.
