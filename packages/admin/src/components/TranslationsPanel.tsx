/**
 * Shared "Translations" sidebar panel. Matches the look of the translations
 * section in ContentEditor — reused across content edit, menu edit and
 * taxonomy term edit so the admin shows one consistent affordance.
 */

import { Banner, Button, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { cn } from "../lib/utils.js";

interface PanelTranslation {
	id: string;
	locale: string;
}

export interface TranslationsPanelProps {
	/** Heading shown above the list (default: "Translations"). */
	title?: string;
	/** Extra classes for the heading, e.g. the content editor's muted panel label style. */
	headingClassName?: string;
	/** All configured locales. */
	locales: string[];
	/** Marked as "(default)" in the list. */
	defaultLocale: string;
	/** Locale of the row being edited — rendered with the "current" highlight. */
	currentLocale: string | undefined;
	/** Locale variants that already exist (may include the current locale).
	 * The panel only needs `id` + `locale`; callers may pass richer summaries. */
	translations: PanelTranslation[];
	/** The translations are still loading, so which locales exist is unknown. */
	loading?: boolean;
	/** The translations failed to load. Ignored while `loading`. */
	error?: boolean;
	onRetry?: () => unknown;
	/** Called when the user clicks "Edit" on a sibling translation. */
	onOpen?: (summary: PanelTranslation) => void;
	/** Called when the user clicks "Translate" for a missing locale. */
	onCreate?: (locale: string) => void;
	/** Locale currently being created; used to disable its button. */
	pendingLocale?: string | null;
}

export function TranslationsPanel({
	title,
	headingClassName,
	locales,
	defaultLocale,
	currentLocale,
	translations,
	loading = false,
	error = false,
	onRetry,
	onOpen,
	onCreate,
	pendingLocale,
}: TranslationsPanelProps) {
	const { t } = useLingui();
	const failed = error && !loading;
	const byLocale = React.useMemo(
		() => new Map(translations.map((tr) => [tr.locale, tr])),
		[translations],
	);

	return (
		<div>
			<Text as="h3" DANGEROUS_className={cn("mb-4 font-semibold", headingClassName)}>
				{title ?? t`Translations`}
			</Text>
			{loading && (
				<span role="status" className="sr-only">
					{t`Loading translations...`}
				</span>
			)}
			{failed && (
				<Banner
					variant="error"
					role="alert"
					title={t`Couldn’t load translations.`}
					action={
						onRetry ? (
							<Button size="sm" variant="secondary" onClick={() => onRetry()}>
								{t`Try again`}
							</Button>
						) : undefined
					}
				/>
			)}
			<div className="space-y-2" aria-busy={loading || undefined} hidden={failed}>
				{locales.map((locale) => {
					const translation = byLocale.get(locale);
					const isCurrent = locale === currentLocale;
					return (
						<div
							key={locale}
							className={cn(
								"-mx-3 flex items-center justify-between rounded-md px-3 py-2 text-base",
								isCurrent
									? "bg-kumo-brand/10 font-medium"
									: loading
										? undefined
										: translation
											? "hover:bg-kumo-tint/50"
											: "text-kumo-subtle",
							)}
						>
							<div className="flex items-center gap-2">
								<span className="text-xs font-semibold uppercase">{locale}</span>
								{locale === defaultLocale && (
									<span className="text-xs leading-4 text-kumo-subtle">{t` (default)`}</span>
								)}
								{isCurrent && (
									<span className="text-xs leading-4 text-kumo-link">{t`current`}</span>
								)}
							</div>
							{isCurrent ? null : loading ? (
								<div aria-hidden="true" className="skeleton-line h-6 w-14 rounded-md" />
							) : translation && onOpen ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-auto px-2 py-1 text-xs"
									onClick={() => onOpen(translation)}
								>
									{t`Edit`}
								</Button>
							) : !translation && onCreate ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-auto px-2 py-1 text-xs"
									disabled={pendingLocale === locale}
									onClick={() => onCreate(locale)}
								>
									{pendingLocale === locale ? t`Translating...` : t`Translate`}
								</Button>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
