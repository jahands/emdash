---
"@emdash-cms/admin": patch
---

Makes the entry editor's taxonomy pickers load sooner. They take the taxonomy definitions from the admin manifest instead of first requesting `/_emdash/api/taxonomies`, so each taxonomy's terms are requested as soon as the editor opens.
