---
"emdash": patch
---

Fixes slow content lists on PostgreSQL. Lists sorted by date, such as the admin content list, dashboard recent items and latest-post queries on public pages, read every entry in the collection and then sorted them. A new migration adds indexes that let PostgreSQL read just one page. With 50,000 posts, the admin list query drops from 70–110 ms to under 0.1 ms. Later pages of the admin content list also skip straight to their position instead of scanning from the start. SQLite and D1 already read these lists from existing indexes, so the migration does nothing there.

#### Large PostgreSQL tables

The migration builds three indexes on each content table. While it runs, the site can still read that table, but writes to it wait until the migration finishes. With 50,000 entries this took about 3 seconds on a test machine, and it grows with the number of entries. To avoid the wait, create the indexes yourself before upgrading. `CONCURRENTLY` builds them without blocking writes, and the migration then skips them. Repeat this for each content table (`ec_` followed by the collection slug):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ec_posts_live_crt ON ec_posts (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ec_posts_live_upd ON ec_posts (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ec_posts_live_pub ON ec_posts (status, published_at DESC, id DESC) WHERE deleted_at IS NULL;
```

If a concurrent build is interrupted and leaves an invalid index, the migration rebuilds it.
