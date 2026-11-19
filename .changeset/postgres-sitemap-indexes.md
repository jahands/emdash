---
"emdash": patch
---

Speeds up `/sitemap.xml` and the per-collection sitemaps on PostgreSQL. Each sitemap used to read every published entry in the collection. With 50,000 posts, the sitemap index and each sitemap page took 32–46 ms of database time on a test machine; they now read only the entries they need from a new index, in 0.3–8 ms. Sitemaps list the same URLs, in the same order and on the same pages, with the same `lastmod` values. SQLite and D1 keep their existing queries. On every database, sitemaps of sites without i18n no longer look up translations of the listed entries.

#### Large PostgreSQL tables

The migration builds one index on each content table and one on the SEO settings table. While it runs, the site can still read each table, but writes to it wait until the migration finishes. With 50,000 entries this took about 2 seconds on a test machine. To avoid the wait, create the indexes yourself before upgrading. `CONCURRENTLY` builds them without blocking writes, and the migration then skips them. Repeat the second statement for each content table (`ec_` followed by the collection slug):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_emdash_seo_no_index ON _emdash_seo (collection, content_id) WHERE seo_no_index <> 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ec_posts_sitemap ON ec_posts (id) INCLUDE (updated_at, translation_group, slug, published_at, locale) WHERE status = 'published' AND deleted_at IS NULL AND slug IS NOT NULL AND TRIM(slug) <> '';
```

If a concurrent build is interrupted and leaves an invalid index, the migration rebuilds it.
