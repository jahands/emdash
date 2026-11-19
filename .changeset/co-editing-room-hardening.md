---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Hardens co-editing rooms on Cloudflare and Node.js.

- Room sockets now need a token the join route signed for that user and entry. The token lasts one minute. The Worker checks it before forwarding an upgrade, so an unauthenticated request can no longer create or wake a room's Durable Object. The signing key comes from the site's preview secret (`EMDASH_PREVIEW_SECRET`, or the generated one stored in the database), so you don't need to configure anything. A tab still holding a token from before the upgrade joins again automatically.
- A room whose Durable Object hibernated resumes from its own storage. The first keystroke after a pause no longer waits for the site to load the entry.
- An autosave that fails because the site can't be reached is tried again, up to five times with backoff, even if nobody types again.
- A site call that hasn't answered after 20 seconds now counts as failed, so one stalled database call can't hold up joins and saves for that entry.
- A user with a very long display name can now join a room. Previously the tab kept rejoining every five seconds and never got in.
- With co-editing turned off, a room's Durable Object deletes its stored state once the site already has every edit, and stops waking up every hour.
