---
"emdash": patch
"@emdash-cms/admin": patch
---

Updates what the admin page shows while the admin loads. Signed-in users see an outline of the admin's sidebar and header, which the admin then fills in without moving anything. The sign-in, setup and other standalone screens show a plain background until they appear. The previous "Loading EmDash..." text was always in English and shifted sideways when the admin font loaded. Screen readers now announce the loading in the admin's language, and the admin font starts downloading with the page.

If you followed the troubleshooting step for a missing `@astrojs/react` integration, the symptom is now an admin page that stays blank, or that keeps showing the outline of its sidebar and header when you're signed in.
