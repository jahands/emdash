---
"@emdash-cms/admin": patch
---

Fixes the content editor moving under the writer while they edit and save. The toolbar actions no longer jump sideways when the first change, an autosave, or a save shows or hides **Save**, or when saving a published entry turns **Unpublish** into **Publish changes**. A failed save and a save conflict no longer push the fields down. In the settings panel, the sections below **Publish** no longer move down on the first save of a published entry.

To keep that space steady, a published entry's publishing summary always shows its draft row, and **Schedule** stays visible but disabled until there are draft changes to schedule. On phones, **Unpublish** takes the same two cells as **Publish changes**, and the toolbar keeps a cell for **Save** in collections that show it there.

A failed save or autosave is now reported in one error notification, which stays open until a save succeeds, instead of a banner below the toolbar plus a toast, and screen readers hear it once. A save conflict is reported the same way, with **Save anyway** in the notification. On phones, these errors no longer add a **Save** button to the toolbar: retry with **Settings** > **Save draft**.

#### Browser tests

Tests that found a save error with `getByRole("alert")` or closed it with **Dismiss save error** should look for the message in the notifications region instead. Notifications use the `dialog` role, so locate other dialogs by name. While there is nothing to save, the toolbar's **Save** button stays in the page but is hidden from the accessibility tree, so role queries don't find it.
