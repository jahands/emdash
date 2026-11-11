/**
 * Sign-in on production builds, where the dev bypass returns 403.
 *
 * The first admin is created through the real setup wizard routes with a
 * Chromium virtual authenticator answering the passkey prompt. Later
 * sign-ins write a single-use magic-link token row, the same row
 * `createMagicLinkUrl()` writes, and exchange it at the real verify route.
 */

import { createHash, randomBytes } from "node:crypto";

export const ADMIN_EMAIL = "owner@perf-audit.local";

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** Token and hash in the format `@emdash-cms/auth` issues and checks. */
export function generateSignInToken() {
	const bytes = randomBytes(32);
	return { token: base64url(bytes), hash: base64url(createHash("sha256").update(bytes).digest()) };
}

export async function createFirstAdmin(browser, origin) {
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("WebAuthn.enable");
		await cdp.send("WebAuthn.addVirtualAuthenticator", {
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		});
		await page.goto(`${origin}/_emdash/api/setup/status`);
		const result = await page.evaluate(async (email) => {
			const headers = { "Content-Type": "application/json", "X-EmDash-Request": "1" };
			const start = await fetch("/_emdash/api/setup/admin", {
				method: "POST",
				headers,
				body: JSON.stringify({ email, name: "Perf Owner" }),
			});
			const startBody = await start.json();
			if (!start.ok) return { ok: false, step: "admin", status: start.status, body: startBody };
			const options = PublicKeyCredential.parseCreationOptionsFromJSON(startBody.data.options);
			const credential = await navigator.credentials.create({ publicKey: options });
			const verify = await fetch("/_emdash/api/setup/admin/verify", {
				method: "POST",
				headers,
				body: JSON.stringify({ credential: credential.toJSON() }),
			});
			return { ok: verify.ok, step: "verify", status: verify.status, body: await verify.json() };
		}, ADMIN_EMAIL);
		if (!result.ok) {
			throw new Error(
				`Admin setup failed at ${result.step} (${result.status}): ${JSON.stringify(result.body).slice(0, 300)}`,
			);
		}
		return result.body.data.user;
	} finally {
		await context.close();
	}
}

/** Write a magic-link token row for the admin. Returns the raw token. */
export async function issueSignInToken(site, email = ADMIN_EMAIL) {
	const users = await site.sql("SELECT id FROM users WHERE email = ?", [email]);
	if (users.length === 0) throw new Error(`No user ${email} in ${site.profile.id}`);
	const { token, hash } = generateSignInToken();
	const now = new Date();
	await site.sql(
		"INSERT INTO auth_tokens (hash, user_id, email, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		[
			hash,
			users[0].id,
			email,
			"magic_link",
			new Date(now.getTime() + 24 * 3600_000).toISOString(),
			now.toISOString(),
		],
	);
	return token;
}

/** Exchange a token at the sign-in route. Returns Playwright cookies. */
export async function exchangeSignInToken(origin, token) {
	const response = await fetch(`${origin}/_emdash/api/auth/magic-link/verify`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
			Origin: origin,
		},
		body: JSON.stringify({ token }),
		redirect: "manual",
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Sign-in failed (${response.status}): ${body.slice(0, 300)}`);
	}
	const { hostname } = new URL(origin);
	return response.headers.getSetCookie().map((header) => {
		const [pair, ...attrs] = header.split(";").map((part) => part.trim());
		const eq = pair.indexOf("=");
		const lower = new Set(attrs.map((a) => a.toLowerCase()));
		const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
		return {
			name: pair.slice(0, eq),
			value: pair.slice(eq + 1),
			domain: hostname,
			path,
			httpOnly: lower.has("httponly"),
			secure: lower.has("secure"),
			sameSite: "Lax",
			expires: -1,
		};
	});
}

export function cookieHeader(cookies) {
	return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
