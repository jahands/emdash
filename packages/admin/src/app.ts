// The admin app alone. Importing it instead of the package root keeps the
// root's component exports, such as the editor, out of the boot bundle.
export { AdminApp, type AdminAppProps } from "./App";
export type { AdminBranding } from "./lib/admin-branding-context";
export type { AuthProviders } from "./lib/auth-provider-context";
export type { PluginAdmins } from "./lib/plugin-context";
