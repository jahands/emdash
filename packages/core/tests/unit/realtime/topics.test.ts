import { Role } from "@emdash-cms/auth";
import { describe, expect, it } from "vitest";

import {
	grantedChannels,
	maySubscribe,
	parseTopic,
	pluginTopic,
	topicAndAncestors,
} from "../../../src/realtime/topics.js";

describe("parseTopic", () => {
	it.each([
		"content/posts",
		"content/posts/01J9ABCDEF",
		"comments",
		"menus",
		"menus/main",
		"users/01USER",
		"plugins",
		"plugin/forms/submissions",
		"plugin/forms/submissions/42",
		"plugin/%40acme%2Fforms/jobs",
	])("reads %s", (topic) => {
		expect(parseTopic(topic)).not.toBeNull();
	});

	it.each([
		["an unknown namespace", "plugins-x/forms"],
		["a plugin without a channel", "plugin/forms"],
		["a plugin channel that isn't a channel name", "plugin/forms/Submissions"],
		["a plugin channel with too many keys", "plugin/forms/submissions/42/x"],
		["a namespace that needs a key", "content"],
		["too many keys", "content/posts/1/2"],
		["a collection that isn't a slug", "content/Posts"],
		["an empty key", "menus/"],
		["a key with a space", "menus/a b"],
		["a key that's too long", `menus/${"m".repeat(129)}`],
		["a prototype key", "__proto__"],
	])("refuses %s", (_name, topic) => {
		expect(parseTopic(topic)).toBeNull();
	});
});

describe("topicAndAncestors", () => {
	it("lists each ancestor that is a topic, nearest first", () => {
		expect(topicAndAncestors("content/posts/01A")).toEqual(["content/posts/01A", "content/posts"]);
		expect(topicAndAncestors("menus/main")).toEqual(["menus/main", "menus"]);
		expect(topicAndAncestors("comments")).toEqual(["comments"]);
		expect(topicAndAncestors("plugin/forms/submissions/42")).toEqual([
			"plugin/forms/submissions/42",
			"plugin/forms/submissions",
		]);
	});
});

describe("pluginTopic", () => {
	it("encodes a scoped plugin ID into one segment", () => {
		expect(pluginTopic("@acme/forms", "jobs", "7")).toBe("plugin/%40acme%2Fforms/jobs/7");
		expect(parseTopic(pluginTopic("@acme/forms", "jobs"))?.keys).toEqual([
			"%40acme%2Fforms",
			"jobs",
		]);
	});
});

describe("maySubscribe", () => {
	it("checks the namespace's permission against the role", () => {
		expect(maySubscribe(Role.CONTRIBUTOR, "content/posts")).toBe(true);
		expect(maySubscribe(Role.SUBSCRIBER, "content/posts")).toBe(false);
		expect(maySubscribe(Role.AUTHOR, "comments")).toBe(false);
		expect(maySubscribe(Role.EDITOR, "comments")).toBe(true);
		expect(maySubscribe(Role.EDITOR, "users/01USER")).toBe(false);
		expect(maySubscribe(Role.ADMIN, "users/01USER")).toBe(true);
		expect(maySubscribe(Role.AUTHOR, "plugins")).toBe(false);
		expect(maySubscribe(Role.EDITOR, "plugins")).toBe(true);
	});

	it("allows a plugin channel only when granted", () => {
		const channels = grantedChannels(Role.EDITOR, {
			"forms/submissions": "settings:read",
			"forms/audit": "plugins:manage",
			"forms/__proto__": "toString",
		});

		expect(channels).toEqual(["forms/submissions"]);
		expect(maySubscribe(Role.EDITOR, "plugin/forms/submissions/42", channels)).toBe(true);
		expect(maySubscribe(Role.EDITOR, "plugin/forms/audit", channels)).toBe(false);
		expect(maySubscribe(Role.ADMIN, "plugin/forms/submissions")).toBe(false);
	});
});
