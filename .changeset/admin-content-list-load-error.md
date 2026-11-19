---
"@emdash-cms/admin": patch
---

Fixes a content list whose entries fail to load replacing the whole page with the raw server error. The page keeps its heading, tabs, filters and Add New button, and the list says the entries couldn't be loaded, with a Try again button. Screen readers announce the error.
