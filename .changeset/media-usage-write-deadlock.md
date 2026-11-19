---
"emdash": patch
---

Fixes content saves on PostgreSQL sometimes failing with "Failed to update content" or "Failed to publish content" (a database deadlock) when media usage tracking was processing the same collection at the same time.
