/**
 * SandboxedPluginWidget
 *
 * Renders a plugin's dashboard widget using Block Kit. Sends a page_load
 * interaction with page="widget:<widgetId>" to the plugin's admin route, and
 * again when one of the plugin's `refreshOn` channels changes.
 */

import { SkeletonLine } from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";
import { useLiveTopic } from "../lib/realtime/LiveSyncProvider.js";
import { pluginTopic } from "../lib/realtime/plugin-topic.js";
import { cn } from "../lib/utils.js";

const PLACEHOLDER_WIDTHS = [80, 60, 70];

interface SandboxedPluginWidgetProps {
	pluginId: string;
	widgetId: string;
	/** The plugin's realtime channels whose changes reload the widget. */
	refreshOn?: readonly string[];
}

export function SandboxedPluginWidget({
	pluginId,
	widgetId,
	refreshOn,
}: SandboxedPluginWidgetProps) {
	const { t } = useLingui();
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const page = `widget:${widgetId}`;
	const requestGeneration = useRef(0);

	const sendInteraction = useCallback(
		async (interaction: BlockInteraction, showLoading = false) => {
			const generation = ++requestGeneration.current;
			if (showLoading) {
				setLoading(true);
				setError(null);
			} else {
				setPending(true);
			}
			try {
				const requestInteraction =
					interaction.type === "page_load" ? interaction : { ...interaction, page };
				const response = await apiFetch(`${API_BASE}/plugins/${pluginId}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestInteraction),
				});
				if (generation !== requestGeneration.current) return;

				if (!response.ok) {
					setError(t`Plugin error (${response.status})`);
					return;
				}

				const body = (await response.json()) as { data: BlockResponse };
				if (generation !== requestGeneration.current) return;
				const data = body.data;
				setBlocks(data.blocks);
				setError(null);
			} catch {
				if (generation === requestGeneration.current) setError(t`Failed to load widget`);
			} finally {
				if (generation === requestGeneration.current) {
					if (showLoading) setLoading(false);
					setPending(false);
				}
			}
		},
		[page, pluginId, t],
	);

	// Initial widget load
	useEffect(() => {
		void sendInteraction({ type: "page_load", page }, true);
		return () => {
			requestGeneration.current++;
		};
	}, [page, sendInteraction]);

	const refreshKey = refreshOn?.join("\n") ?? "";
	const liveTopics = useMemo(
		() =>
			refreshKey ? refreshKey.split("\n").map((channel) => pluginTopic(pluginId, channel)) : [],
		[pluginId, refreshKey],
	);
	useLiveTopic(liveTopics, () => void sendInteraction({ type: "page_load", page }));

	const handleAction = useCallback(
		(interaction: BlockInteraction) => {
			void sendInteraction(interaction);
		},
		[sendInteraction],
	);

	if (loading) {
		return (
			<div className="py-1">
				<span role="status" className="sr-only">
					{t`Loading...`}
				</span>
				<div aria-hidden="true" className="space-y-3">
					{PLACEHOLDER_WIDTHS.map((width, i) => (
						<SkeletonLine key={i} blockHeight={24} minWidth={width} maxWidth={width} />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return <p className="text-sm text-kumo-subtle">{error}</p>;
	}

	if (blocks.length === 0) {
		return <p className="text-sm text-kumo-subtle">{t`No content`}</p>;
	}

	return (
		<div>
			<div
				aria-busy={pending || undefined}
				className={cn("transition-opacity motion-reduce:transition-none", pending && "opacity-60")}
			>
				<BlockRenderer
					blocks={blocks}
					onAction={handleAction}
					resolveLinkTarget={(target) => resolvePluginLinkTarget(pluginId, target)}
				/>
			</div>
			<span role="status" className="sr-only">
				{pending ? t`Updating...` : ""}
			</span>
		</div>
	);
}
