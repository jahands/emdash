---
"emdash": patch
---

Speeds up the first request on a new site. EmDash used to build a new database by running every migration in turn, one statement per database round trip: about 600 round trips, which took about 14 seconds on PostgreSQL with 20 ms of latency and over 20 seconds on Cloudflare D1. It now creates the whole schema at once: in 2 round trips on D1 and PostgreSQL, and in one transaction on a SQLite file. `emdash migrate` and `emdash init` against an empty database get the same speedup. libSQL databases, and D1 databases migrated with `emdash migrate`, still run each migration in turn.

Databases that already have tables, including ones with tables that EmDash did not create, upgrade exactly as before. Only a database without EmDash's migration table is set up this way.
