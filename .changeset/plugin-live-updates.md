---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/registry-lexicons": minor
---

Adds live updates for plugins. A plugin declares channels in `realtime.channels`, each with the permission a user needs to receive it, and publishes to them with `ctx.realtime.publish(channel, { ids, op })` under the new `realtime:publish` capability. Open admin tabs showing the plugin's data reload it within a few seconds, on sites with `coEditing: true`. Elsewhere, publishing does nothing.

```jsonc title="emdash-plugin.jsonc"
{
	"capabilities": ["realtime:publish"],
	"realtime": { "channels": { "submissions": { "permission": "content:read_drafts" } } },
	"admin": { "widgets": [{ "id": "recent", "refreshOn": ["submissions"] }] },
}
```

- Sandboxed and native plugins publish the same way. A plugin can publish only to its own declared channels, at most 20 changes per hook or route invocation, and a change made inside a database transaction goes out after it commits. Changes carry no data, so tabs refetch through the plugin's routes.
- Block Kit pages and widgets reload when a channel listed in their `refreshOn` changes.
- Native React pages can call `useLiveTopic()`, `usePresence()`, and `useAnnouncePresence()` from `@emdash-cms/admin`, and build topics with `pluginTopic()`. `@emdash-cms/admin` also exports TanStack Query's `useQuery` and `useQueryClient`, so a plugin query that sets `meta: { live: [topic] }` shares the admin's cache and refetches on a change.
- `createPluginRuntimeTestHost()` records published changes in `host.inspect.realtime()`.
- The registry release lexicon adds `realtime.publish` to declared access, and the install consent screen lists the new capability.

Existing plugins are unaffected. All new fields are optional.

#### What should I do?

Nothing, unless TypeScript code maps every plugin capability, for example a `Record<PluginCapability, string>` of labels. Add an entry for `"realtime:publish"` there.
