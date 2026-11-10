---
"emdash": patch
---

Speeds up saving content on remote databases while media usage tracking is not yet active. The usage refresh that runs after a save now reads the existing sources, field definitions and collection at once, and writes the live and draft projections at the same time instead of one after the other. A draft save drops from about 20 to 16 sequential database round trips.
