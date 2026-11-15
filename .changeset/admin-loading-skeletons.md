---
"@emdash-cms/admin": patch
"emdash": patch
---

Updates the admin's loading states so each screen draws what it already knows at once and loads the rest in place, instead of showing spinners or "Loading..." text. Headings, labels, buttons and table headers appear straight away. Only the values still on their way show as placeholders sized like what replaces them, so nothing moves when they arrive. Empty and error messages appear in the same place, and load errors in tables offer a retry. Placeholders and spinners stay still when the system is set to reduce motion, and each loading area announces itself once to screen readers.

#### Changes you may notice

- While a screen's code loads, the admin shows its real heading, and the admin's frame shows its header buttons and sidebar footer. Sign-in and other standalone screens show their card in outline instead of a blank page. An error during startup shows inside the frame.
- The dashboard always shows a Scheduled count, including 0. Its Content card lists collections in the sidebar's order, and plugin widgets appear without waiting for the dashboard's stats.
- Searches and filters in content, media, user, byline, redirect, marketplace, section and command palette lists keep the current results on screen until new ones arrive.
- Translation panels offer no Translate or Edit action until the entry's translations have loaded, so they no longer offer to translate into a locale that already has a translation. If the translations fail to load, the panel says so and offers a retry.
- Content, media and comment lists keep their page controls while their first page loads.
- List tables give their columns fixed widths, so the columns stay put when rows, an empty-list message or a load error replace the placeholders. The name column takes the remaining width.
- The Redirects tab keeps its width while its count loads, so the 404 Errors tab and the filters beside it stay put.
- Buttons keep their size while they work. The spinner shows over the button's label instead of beside it.
- General settings show the note about a site URL set by the deployment configuration straight away. The admin manifest now carries `siteDomain`, the same `configuredUrl` and `siteOrigin` that `GET /_emdash/api/settings/domain` returns.
- The media library draws its toolbar and tiles in outline where they will stay. It remembers, in each browser, whether folders, provider tabs or a usage notice sat above the grid, so later visits draw the outline at once. On the first visit in a browser, the outline appears once the library knows whether a usage notice or provider tabs go above it.
- The plugin registry keeps its current results on screen while a new search loads.
- When a plugin's settings fail to load, the page keeps its header and offers a retry.
- The sign-in page shows its card straight away when the server sends the sign-in options with the page.
- A registry plugin's banner now sits below its header.
