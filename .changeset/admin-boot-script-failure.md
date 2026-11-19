---
"emdash": patch
---

Fixes the admin showing a loading spinner forever when its code fails to load, for example after a deploy removes a file an open page still asks for. The page now shows "Failed to load admin" with a Try again button that reloads it, in the admin's language.
