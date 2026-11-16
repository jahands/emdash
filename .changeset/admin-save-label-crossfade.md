---
"@emdash-cms/admin": patch
---

Fixes the editor's toolbar shifting while saving. The Save button label now fades in place between Save, Saving... and Saved instead of sliding, and the Publish changes button keeps the width of the Unpublish button it replaces.

When edits save on their own, through autosave or a co-editing room, the button now keeps one look in every state instead of changing color and emphasis on each edit, stays in place showing Saved between edits, and shows Saving... only when a save takes longer than 400 ms. A typical edit goes from Saved to Save and back.
