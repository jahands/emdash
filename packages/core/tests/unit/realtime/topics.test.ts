import { Role } from "@emdash-cms/auth";
import { describe, expect, it } from "vitest";

import { maySubscribe, parseTopic, topicAndAncestors } from "../../../src/realtime/topics.js";

describe("parseTopic", () => {
	it.each([
		"content/posts",
		"content/posts/01J9ABCDEF",
		"comments",
		"menus",
		"menus/main",
		"users/01USER",
	])("reads %s", (topic) => {
		expect(parseTopic(topic)).not.toBeNull();
	});

	it.each([
		["an unknown namespace", "plugins/forms"],
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
	});
});
