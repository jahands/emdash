---
"@emdash-cms/admin": minor
"@emdash-cms/blocks": patch
"emdash": patch
---

Reduces the JavaScript loaded by admin pages by loading uncommon navigation icons individually. Plugins can continue to use arbitrary Phosphor icon names, including legacy aliases; unknown names still use the fallback icon. Available names follow the Phosphor version included when the admin package is built. To use icons introduced by a newer Phosphor release, upgrade to an admin release that includes them.

Loads admin screens and plugin charts on demand so signing in and browsing content do not download the editor, settings screens, or chart engine in advance. Keeps navigation visible while a screen loads. The root admin package import remains supported; Astro integrations can use the new `@emdash-cms/admin/app` entry to load the app without the component barrel.

Loads the active admin translation catalog from a cacheable asset before rendering the app, reducing the HTML sent on each visit while keeping the boot indicator visible until translations are ready.
