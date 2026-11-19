import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareApiError, teardownRun } from "./cloudflare.mjs";

const includes = (text) => new RegExp(RegExp.escape(text));

const notFound = () => new CloudflareApiError("GET", "/x", 404, []);

/** In-memory stand-in for the Cloudflare account, recording every deletion. */
function fakeAccount({ domains = [], scripts = [], buckets = {}, d1 = [], kv = [] }) {
	const deleted = [];
	return {
		deleted,
		isNotFound: (error) => error instanceof CloudflareApiError && error.status === 404,
		async getDomain(id) {
			const domain = domains.find((d) => d.id === id);
			if (!domain) throw notFound();
			return domain;
		},
		async listDomains({ hostname } = {}) {
			return domains.filter((d) => !hostname || d.hostname === hostname);
		},
		async deleteDomain(id) {
			deleted.push(`domain:${id}`);
		},
		async deleteScript(name) {
			if (!scripts.includes(name)) throw notFound();
			deleted.push(`worker:${name}`);
		},
		async listBuckets(nameContains) {
			return Object.keys(buckets)
				.filter((name) => name.includes(nameContains))
				.map((name) => ({ name }));
		},
		async listObjects(bucket) {
			return { objects: buckets[bucket].map((key) => ({ key })) };
		},
		async deleteObject(bucket, key) {
			buckets[bucket] = buckets[bucket].filter((k) => k !== key);
			deleted.push(`object:${bucket}/${key}`);
		},
		async deleteBucket(name) {
			deleted.push(`bucket:${name}`);
		},
		async getD1(uuid) {
			const db = d1.find((item) => item.uuid === uuid);
			if (!db) throw notFound();
			return db;
		},
		async listD1(name) {
			return d1.filter((db) => db.name.includes(name));
		},
		async deleteD1(uuid) {
			deleted.push(`d1:${uuid}`);
		},
		async getKv(id) {
			const ns = kv.find((item) => item.id === id);
			if (!ns) throw notFound();
			return ns;
		},
		async listKv() {
			return kv;
		},
		async deleteKv(id) {
			deleted.push(`kv:${id}`);
		},
	};
}

const RUN = "abcd1234";
const HOST = "perf.example.com";

void test("deletes every resource of the run, emptying the bucket first", async () => {
	const cf = fakeAccount({
		domains: [{ id: "dom1", hostname: HOST, service: `emdash-perf-${RUN}` }],
		scripts: [`emdash-perf-${RUN}`],
		buckets: { [`emdash-perf-${RUN}`]: ["a.jpg", "b.png"] },
		d1: [{ uuid: "db1", name: `emdash-perf-${RUN}` }],
		kv: [{ id: "kv1", title: `emdash-perf-${RUN}-session` }],
	});
	const steps = await teardownRun(cf, {
		runId: RUN,
		hostname: HOST,
		resources: { domain: { id: "dom1" }, d1: { uuid: "db1" }, kv: { id: "kv1" } },
	});
	assert.deepEqual(
		steps.map((s) => `${s.kind}:${s.status}`),
		["custom-domain:deleted", "worker:deleted", "r2:deleted", "d1:deleted", "kv:deleted"],
	);
	assert.deepEqual(cf.deleted, [
		"domain:dom1",
		`worker:emdash-perf-${RUN}`,
		`object:emdash-perf-${RUN}/a.jpg`,
		`object:emdash-perf-${RUN}/b.png`,
		`bucket:emdash-perf-${RUN}`,
		"d1:db1",
		"kv:kv1",
	]);
});

void test("refuses recorded IDs that resolve to resources outside the run", async () => {
	const cf = fakeAccount({
		domains: [{ id: "prod-domain", hostname: HOST, service: "astroblog" }],
		d1: [{ uuid: "prod-db", name: "astroblog" }],
		kv: [{ id: "prod-kv", title: "astroblog-sessions" }],
	});
	const steps = await teardownRun(cf, {
		runId: RUN,
		hostname: HOST,
		resources: { domain: { id: "prod-domain" }, d1: { uuid: "prod-db" }, kv: { id: "prod-kv" } },
	});
	assert.deepEqual(cf.deleted, []);
	const byKind = Object.fromEntries(steps.map((s) => [s.kind, s]));
	assert.equal(byKind["custom-domain"].status, "absent");
	assert.equal(byKind.d1.status, "error");
	assert.match(byKind.d1.error, includes('belongs to "astroblog"'));
	assert.equal(byKind.kv.status, "error");
});

void test("finds unrecorded resources by exact name only, so other runs are untouched", async () => {
	const cf = fakeAccount({
		domains: [{ id: "other", hostname: HOST, service: "emdash-perf-zzzz9999" }],
		buckets: { "emdash-perf-abcd12345": ["x"] },
		d1: [
			{ uuid: "longer", name: `emdash-perf-${RUN}-old` },
			{ uuid: "mine", name: `emdash-perf-${RUN}` },
		],
		kv: [{ id: "other-kv", title: "emdash-perf-zzzz9999-session" }],
	});
	const steps = await teardownRun(cf, { runId: RUN, hostname: HOST, resources: {} });
	assert.deepEqual(cf.deleted, ["d1:mine"]);
	assert.deepEqual(
		steps.map((s) => `${s.kind}:${s.status}`),
		["custom-domain:absent", "worker:absent", "r2:absent", "d1:deleted", "kv:absent"],
	);
});
