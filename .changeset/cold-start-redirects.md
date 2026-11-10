---
"emdash": patch
---

Removes a database round trip from the first page a visitor loads on a freshly started server or Worker isolate: published redirect rules are now read together with the other startup reads instead of after them.
