---
"@emdash-cms/admin": patch
---

Fixes the editor's toolbar shifting while saving. The Save button label now fades in place between Save, Saving... and Saved instead of sliding, and the Publish changes button keeps the width of the Unpublish button it replaces.

When edits save on their own, through autosave or a co-editing room, the button now reports them instead of asking for a save: it shows Saving... from the edit until the save lands, then Saved, with no change of color or emphasis. When autosave can't send the edits, for example after a failed autosave, it asks for a save as before.
