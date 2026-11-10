---
"@emdash-cms/admin": patch
---

Fixes Back from an entry returning the content list to page 1. The page number and page size are now part of the list URL, for example `/_emdash/admin/content/posts?page=3&perPage=50`, so a list page can be reloaded or shared. Back also restores the list's filters, search, sort and scroll position. Existing list URLs keep opening page 1.
