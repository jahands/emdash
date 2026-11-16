---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
---

Adds live updates to the admin on sites with `coEditing: true`. Content lists, the comments inbox and the menus list refresh within a few seconds when someone changes them in another tab, through the REST API, MCP, a plugin, the scheduler or a co-edited entry's autosave. A tab doesn't refetch for its own changes, and new public comments still appear on the next refresh, since only moderation sends updates.

Each admin tab holds one WebSocket on `/_emdash/api/realtime`, with a short-lived ticket from `POST /_emdash/api/realtime`. Sites without co-editing see no change.

- **Cloudflare:** the hub runs as one more object in the existing `EMDASH_ROOMS` binding, so `wrangler.jsonc` and the Worker entry point need no change. `handleRoomUpgrade` forwards the new path. The hub stores nothing and hibernates between changes, but each admin write request makes one more Durable Object request.
- **Node.js:** a reverse proxy must forward WebSocket upgrades on `/_emdash/api/realtime` as well as room paths. For nginx, widen the room location to `location ~ ^/_emdash/api/(content/[^/]+/[^/]+/room|realtime)$`. Until it does, tabs stop trying after three failed connections and the admin refreshes as before. With several processes, a change reaches only the tabs connected to the process that handled it.

Disabling a user or changing their role closes their live updates connections at once.
