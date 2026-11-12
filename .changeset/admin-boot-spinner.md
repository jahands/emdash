---
"emdash": patch
"@emdash-cms/admin": patch
---

Updates the screen shown while the admin loads to a spinner without text. The previous "Loading EmDash..." text was always in English and shifted sideways when the admin font loaded. Screen readers now announce the spinner as loading in the admin's language, and the admin font starts downloading with the page.

If you followed the troubleshooting step for a missing `@astrojs/react` integration, the symptom is now an admin page that keeps showing its loading spinner.
