---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
---

Adds live updates to the admin on sites with `coEditing: true`. Screens refresh within a few seconds when someone changes what they show in another tab, through the REST API, MCP, a plugin, the scheduler or a co-edited entry's autosave. This covers content lists, entries open in single-editor mode, the comments inbox, menus, widgets, taxonomies and their terms, bylines, sections, the media library, redirects, settings, the content types list, users and plugins. A content list takes up to 15 seconds to show edits to entries it already lists, so a co-edited entry's autosaves don't refetch it every few seconds; new and deleted entries still appear within a few seconds. A tab doesn't refetch for its own changes, and new public comments still appear on the next refresh, since only moderation sends updates.

A form with unsaved edits keeps them when what it edits changes elsewhere. It shows **This changed somewhere else** with **Load new version**, which replaces the edits with the saved version. Entries in single-editor mode, settings, sections, menu items and widgets work this way. An entry open in a co-editing room stays current through the room.

The admin also shows who else is working where. A content list shows a circle with a person's initials beside each entry someone else has open in the editor, or a count when several people do. The menu, widgets, section and settings screens show who else has them open, as **Editing** while they have unsaved changes and **Viewing** otherwise. Live sites keep room for the circle in each list row, so it moves nothing when it appears.

Each admin tab holds one WebSocket on `/_emdash/api/realtime`, with a short-lived ticket from `POST /_emdash/api/realtime`. Sites without co-editing see no change.

- **Cloudflare:** the hub runs as one more object in the existing `EMDASH_ROOMS` binding, so `wrangler.jsonc` and the Worker entry point need no change. `handleRoomUpgrade` forwards the new path. The hub stores nothing and hibernates between changes, but each admin write request makes one more Durable Object request.
- **Node.js:** a reverse proxy must forward WebSocket upgrades on `/_emdash/api/realtime` as well as room paths. For nginx, widen the room location to `location ~ ^/_emdash/api/(content/[^/]+/[^/]+/room|realtime)$`. Until it does, tabs stop trying after three failed connections and the admin refreshes as before. With several processes, a change reaches only the tabs connected to the process that handled it.

Disabling a user or changing their role closes their live updates connections at once.
