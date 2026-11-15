---
"@emdash-cms/admin": patch
---

Updates the admin's loading states to placeholders shaped like what they stand for, instead of spinners and "Loading..." rows. The tables of users, comments, relations, block types, taxonomy terms and byline fields show placeholder rows. Settings pages show an outline of a settings section, and screens loading inside the admin hold their title's place.

Fixes the comments page swapping its table for a separate empty message once comments load. A tab with no comments now shows its empty message in the table right away, and a tab with comments holds a row for each one coming. The users page also keeps its header, search and role filter in place while users load, instead of replacing the whole page.
