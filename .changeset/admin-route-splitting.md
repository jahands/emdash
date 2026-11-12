---
"@emdash-cms/admin": minor
"emdash": patch
---

Speeds up the admin's first load. Each admin screen's code now loads when the screen opens, and the rich text editor loads only on screens that edit content, so the dashboard, content lists, media and settings download about a third of the JavaScript they did before. The admin page preloads the opened screen's code together with the rest of the admin, and while no editor is open, the other screens load in the background once the page is idle, so moving between sections does not wait for a download.

The admin's client code is also grouped into fewer files. Sites that configure their own chunking in `vite.build.rolldownOptions.output` keep it.

Adds `@emdash-cms/admin/app`, which exports `AdminApp` without the editor and other components that the package root exports.
