/**
 * Content and media writes an owner makes, each sent once and timed like a
 * server-pass request, including the work the server does after it has
 * responded.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { loadSharp } from "./deps.mjs";
import { apiClient, longBody, mediaValue, newEntryData } from "./seed.mjs";
import { timedRequest } from "./server-pass.mjs";

let counter = 0;

export const WRITE_OPS = [
	"create",
	"update",
	"autosave",
	"publish",
	"trash",
	"media upload",
	"media delete",
];

/**
 * Create a new entry; save, autosave and publish the image-heavy entry the
 * way the editor does; move the new entry to the trash; then upload a photo
 * and delete it. Requests that only fetch what a write needs (the current
 * `_rev`, the media list) are not measured. Stops at the first failed
 * write and returns what it measured with the error.
 */
export async function measureWrites(
	site,
	{ cookies, plan, heaviest, mediaFile, phasePrefix = "write" },
) {
	const ops = [];
	try {
		await writePass(site, { cookies, plan, heaviest, mediaFile, phasePrefix, ops });
		return { ops, error: null };
	} catch (error) {
		return { ops, error: String(error?.message ?? error).slice(0, 500) };
	}
}

async function writePass(site, { cookies, plan, heaviest, mediaFile, phasePrefix, ops }) {
	const api = apiClient(site.origin, cookies);
	const run = async (op, path, init) => {
		const phase = `${phasePrefix}:${op.replaceAll(" ", "-")}:${++counter}`;
		const { result, data, text } = await timedRequest(site, path, {
			...init,
			cookies,
			phase,
			watchAfter: true,
		});
		ops.push({ op, ...result });
		if (result.status >= 400) {
			throw new Error(`${op}: ${init.method} ${path} -> ${result.status}: ${text.slice(0, 300)}`);
		}
		return data?.data ?? data;
	};
	const content = `/_emdash/api/content/${plan.collection}`;
	const revision = async (id) => {
		const current = await api("GET", `/content/${plan.collection}/${id}`);
		const item = current.item ?? current;
		return { item, rev: current._rev ?? item._rev };
	};

	const media = (await api("GET", "/media?limit=100")).items;
	const photo = media.find((m) => m.mimeType === "image/jpeg") ?? media[0];
	const created = await run("create", content, {
		method: "POST",
		json: {
			data: newEntryData(plan, {
				title: "Notes written during the write pass",
				excerpt: "A new entry with a featured image and two photos in its body.",
				image: mediaValue(photo, "Write pass photo"),
				body: longBody(media, 1, Math.min(2, media.length)),
			}),
			slug: `write-pass-${Date.now()}`,
		},
	});
	const createdId = (created.item ?? created).id;

	const heavy = await revision(heaviest.id);
	const title = plan.titleField ? heavy.item.data?.[plan.titleField] : null;
	const edit = (suffix) =>
		plan.titleField
			? { ...heavy.item.data, [plan.titleField]: `${title ?? "Entry"} ${suffix}` }
			: heavy.item.data;
	await run("update", `${content}/${heaviest.id}`, {
		method: "PUT",
		json: { data: edit("(saved)"), _rev: heavy.rev },
	});
	const saved = await revision(heaviest.id);
	await run("autosave", `${content}/${heaviest.id}`, {
		method: "PUT",
		json: { data: edit("(autosaved)"), skipRevision: true, _rev: saved.rev },
	});
	await run("publish", `${content}/${heaviest.id}/publish`, { method: "POST", json: {} });
	await run("trash", `${content}/${createdId}`, { method: "DELETE" });

	const bytes = readFileSync(mediaFile);
	const { width, height } = await loadSharp()(bytes).metadata();
	const form = new FormData();
	form.append(
		"file",
		new Blob([bytes], { type: "image/jpeg" }),
		`write-pass-${basename(mediaFile)}`,
	);
	form.append("width", String(width));
	form.append("height", String(height));
	const uploaded = await run("media upload", "/_emdash/api/media", { method: "POST", form });
	const mediaId = (uploaded.item ?? uploaded).id;
	await run("media delete", `/_emdash/api/media/${mediaId}`, { method: "DELETE" });
}
