import type { AdminRouteModule } from "./route-modules.js";

export const ROUTE_MODULE_LOADERS = {
	"components/SetupWizard": () => import("./components/SetupWizard.js"),
	"components/LoginPage": () => import("./components/LoginPage.js"),
	"components/MagicLinkConfirmPage": () => import("./components/MagicLinkConfirmPage.js"),
	"components/SignupPage": () => import("./components/SignupPage.js"),
	"components/InviteAcceptPage": () => import("./components/InviteAcceptPage.js"),
	"components/DeviceAuthorizePage": () => import("./components/DeviceAuthorizePage.js"),
	"components/Dashboard": () => import("./components/Dashboard.js"),
	"routes/calendar": () => import("./routes/calendar.js"),
	"components/ContentList": () => import("./components/ContentList.js"),
	"components/ContentEditor": () => import("./components/ContentEditor.js"),
	"components/ContentTypeList": () => import("./components/ContentTypeList.js"),
	"components/BlockTypeList": () => import("./components/BlockTypeList.js"),
	"components/ContentTypeEditor": () => import("./components/ContentTypeEditor.js"),
	"components/RelationList": () => import("./components/RelationList.js"),
	"components/MediaLibrary": () => import("./components/MediaLibrary.js"),
	"components/comments/CommentInbox": () => import("./components/comments/CommentInbox.js"),
	"components/MenuList": () => import("./components/MenuList.js"),
	"components/MenuEditor": () => import("./components/MenuEditor.js"),
	"components/PluginManager": () => import("./components/PluginManager.js"),
	"components/PluginSettings": () => import("./components/PluginSettings.js"),
	"components/RegistryBrowse": () => import("./components/RegistryBrowse.js"),
	"components/RegistryPluginDetail": () => import("./components/RegistryPluginDetail.js"),
	"components/SandboxedPluginPage": () => import("./components/SandboxedPluginPage.js"),
	"components/Redirects": () => import("./components/Redirects.js"),
	"components/Sections": () => import("./components/Sections.js"),
	"components/SectionEditor": () => import("./components/SectionEditor.js"),
	"components/TaxonomyManager": () => import("./components/TaxonomyManager.js"),
	"routes/users": () => import("./routes/users.js"),
	"routes/bylines": () => import("./routes/bylines.js"),
	"routes/byline-schema": () => import("./routes/byline-schema.js"),
	"components/Widgets": () => import("./components/Widgets.js"),
	"components/Settings": () => import("./components/Settings.js"),
	"components/settings/MediaUsageSettings": () =>
		import("./components/settings/MediaUsageSettings.js"),
	"components/settings/GeneralSettings": () => import("./components/settings/GeneralSettings.js"),
	"components/settings/SocialSettings": () => import("./components/settings/SocialSettings.js"),
	"components/settings/SeoSettings": () => import("./components/settings/SeoSettings.js"),
	"components/settings/SecuritySettings": () => import("./components/settings/SecuritySettings.js"),
	"components/settings/AllowedDomainsSettings": () =>
		import("./components/settings/AllowedDomainsSettings.js"),
	"components/settings/ApiTokenSettings": () => import("./components/settings/ApiTokenSettings.js"),
	"components/settings/EmailSettings": () => import("./components/settings/EmailSettings.js"),
	"components/settings/BackupSettings": () => import("./components/settings/BackupSettings.js"),
	"components/settings/TransferSettings": () => import("./components/settings/TransferSettings.js"),
	"components/settings/SidebarsSettings": () => import("./components/settings/SidebarsSettings.js"),
	"components/WordPressImport": () => import("./components/WordPressImport.js"),
} satisfies Record<AdminRouteModule, () => Promise<unknown>>;

export type RouteModuleExports<M extends AdminRouteModule> = Awaited<
	ReturnType<(typeof ROUTE_MODULE_LOADERS)[M]>
>;
