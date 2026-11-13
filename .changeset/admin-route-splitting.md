---
"@emdash-cms/admin": minor
"emdash": patch
---

Speeds up the admin's first load. Each admin screen's code now loads when the screen opens, and the rich text editor loads only on screens that edit content, so the dashboard, content lists, media and settings download about a third of the JavaScript they did before. The admin page preloads the opened screen's code together with the rest of the admin. Once a screen has its data and images, the admin downloads the content list and the editor in the background, so opening an entry rarely waits and works offline once they have loaded. These downloads stop as soon as you open another screen, so they never slow the screen you asked for, and they are skipped when Data Saver is on or the connection is 2G. Other screens load when you hover, focus or touch a link to them. A screen whose code is still downloading shows its outline or a loading indicator straight away. If a deploy replaces the admin's files while the admin is open, the next screen that needs new code reloads the page once to get it. A screen that still can't load says whether the browser is offline, the server can't be reached, or the admin was updated, and offline it loads by itself once the connection returns.

The admin's client code is also grouped into fewer files. Sites that configure their own chunking in `vite.build.rolldownOptions.output` keep it.

Adds `@emdash-cms/admin/app`, which exports `AdminApp` without the editor and other components that the package root exports. `AdminApp` takes an optional `routePrefetchFiles` prop, the files to download ahead, which EmDash fills in from the build; without it, screens load when opened or on intent.
