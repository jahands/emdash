---
"emdash": patch
---

Adds each query's start time and a per-request id to the `EMDASH_QUERY_LOG` output, so performance tooling can tell sequential queries from parallel ones.
