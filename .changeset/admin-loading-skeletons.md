---
"@emdash-cms/admin": patch
---

Updates the admin's loading states so each screen draws what it already knows at once and loads the rest in place, instead of showing spinners or "Loading..." text. Headings, labels, buttons and table headers appear straight away. Only the values still on their way show as placeholders sized like what replaces them, so nothing moves when they arrive. Empty and error messages appear in the same place, and load errors in tables offer a retry. Placeholders stay still when the system is set to reduce motion, and each loading area announces itself once to screen readers.

#### Changes you may notice

- While a screen's code loads, the admin shows its real heading, and the admin's frame shows its header buttons and sidebar footer. Sign-in and other standalone screens show their card in outline instead of a blank page. An error during startup shows inside the frame.
- The dashboard always shows a Scheduled count, including 0. Its Content card lists collections in the sidebar's order, and plugin widgets appear without waiting for the dashboard's stats.
- Searches and filters in content, media, user, byline, redirect, marketplace, section and command palette lists keep the current results on screen until new ones arrive.
- Translation panels offer no Translate or Edit action until the entry's translations have loaded, so they no longer offer to translate into a locale that already has a translation.
- Content, media and comment lists keep their page controls while their first page loads.
- The media library remembers, in each browser, whether folders, provider tabs or a usage notice sat above the grid, so the next visit draws them in place.
- A registry plugin's banner now sits below its header.
