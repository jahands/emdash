// Main App
export { AdminApp, default as App } from "./App";

// Router
export { createAdminRouter, Link, useNavigate, useParams } from "./router";

// Live updates for native plugin pages. Queries made with these hooks share the admin's cache, so
// a query's `meta: { live: [topic] }` refetches it when the topic changes.
export { useQuery, useQueryClient } from "@tanstack/react-query";
export {
	useAnnouncePresence,
	useLiveTopic,
	usePresence,
	type PresentPerson,
} from "./lib/realtime/LiveSyncProvider";
export type { PresenceActivity } from "./lib/realtime/connection";
export { pluginTopic } from "./lib/realtime/plugin-topic";

// Components
export * from "./components";

// API client
export * from "./lib/api";

// Utilities
export { cn } from "./lib/utils";

export {
	type ContentEditorPanelContext,
	type ContentEditorPanelExtension,
} from "./lib/content-editor-panels";

// Plugin admin context (for accessing plugin components)
export {
	PluginAdminProvider,
	usePluginAdmins,
	usePluginWidget,
	usePluginPage,
	usePluginField,
	usePluginHasPages,
	usePluginHasWidgets,
	type PluginAdminModule,
	type PluginAdmins,
} from "./lib/plugin-context";

export type {
	ContentListColumnHeaderContext,
	ContentListColumnCellContext,
	ContentListColumnExtension,
} from "./lib/content-list-columns.js";

// Auth provider context (for accessing pluggable auth provider components)
export {
	AuthProviderProvider,
	useAuthProviders,
	useAuthProviderList,
	type AuthProviderModule,
	type AuthProviders,
} from "./lib/auth-provider-context";

// Admin branding context (for accessing configured white-label logo/site name)
export type { AdminBranding } from "./lib/admin-branding-context";

// Locales
export {
	useLocale,
	SUPPORTED_LOCALES,
	SUPPORTED_LOCALE_CODES,
	DEFAULT_LOCALE,
	resolveLocale,
} from "./locales/index.js";
export type { SupportedLocale } from "./locales/index.js";
