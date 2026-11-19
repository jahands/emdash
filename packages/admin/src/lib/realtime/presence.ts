/**
 * Who the hub says is where, as the tab last heard it. Someone who leaves stays listed for a
 * moment: the hub closes every socket after 15 minutes and the tab reconnects within a second or
 * two, which would otherwise make each person blink out and back.
 */

import type { LivePresenceEntry, LivePresencePlace } from "./connection.js";

export const LEAVE_GRACE_MS = 2500;

/** A tab at a place. */
export interface PresenceAt extends LivePresenceEntry {
	topic: string;
}

const NOBODY: readonly PresenceAt[] = Object.freeze([]);

export class PresenceStore {
	readonly #places = new Map<string, LivePresenceEntry[]>();
	/** Tabs the hub took off, by key, until they are dropped. */
	readonly #leaving = new Map<string, { at: PresenceAt; until: number }>();
	readonly #listeners = new Set<() => void>();
	#shown: readonly PresenceAt[] = NOBODY;
	#timer: ReturnType<typeof setTimeout> | undefined;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Everyone shown, in the order the hub listed them. A new array only when it changes. */
	readonly snapshot = (): readonly PresenceAt[] => this.#shown;

	apply(places: readonly LivePresencePlace[], all: boolean): void {
		const before = this.#present();
		if (all) this.#places.clear();
		for (const { topic, people } of places) {
			if (people.length > 0) this.#places.set(topic, people);
			else this.#places.delete(topic);
		}
		const after = this.#present();
		const until = Date.now() + LEAVE_GRACE_MS;
		for (const [key, at] of before) {
			if (!after.has(key) && !this.#leaving.has(key)) this.#leaving.set(key, { at, until });
		}
		for (const key of after.keys()) this.#leaving.delete(key);
		this.#update();
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#listeners.clear();
	}

	#present(): Map<string, PresenceAt> {
		const present = new Map<string, PresenceAt>();
		for (const [topic, people] of this.#places) {
			for (const entry of people) present.set(keyOf(topic, entry), { ...entry, topic });
		}
		return present;
	}

	#update(): void {
		clearTimeout(this.#timer);
		const now = Date.now();
		let next = Infinity;
		for (const [key, { until }] of this.#leaving) {
			if (until <= now) this.#leaving.delete(key);
			else next = Math.min(next, until);
		}
		if (next !== Infinity) this.#timer = setTimeout(() => this.#update(), next - now);
		const shown = [
			...this.#present().values(),
			...Array.from(this.#leaving.values(), ({ at }) => at),
		];
		if (sameTabs(shown, this.#shown)) return;
		this.#shown = shown.length === 0 ? NOBODY : shown;
		for (const listener of this.#listeners) listener();
	}
}

function keyOf(topic: string, entry: LivePresenceEntry): string {
	return `${topic}\n${entry.clientId}`;
}

function sameTabs(a: readonly PresenceAt[], b: readonly PresenceAt[]): boolean {
	return (
		a.length === b.length &&
		a.every((at, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				other.topic === at.topic &&
				other.clientId === at.clientId &&
				other.userId === at.userId &&
				other.name === at.name &&
				other.activity === at.activity
			);
		})
	);
}
