/**
 * GitHub git operations proxy service configuration.
 *
 * This service proxies git HTTP protocol requests (clone, push, fetch) to GitHub,
 * extracting the JWT token from the Authorization header and replacing it with
 * the real GITHUB_TOKEN using Basic authentication.
 *
 * Security: Only git-specific paths are allowed to prevent API abuse.
 */

import type { Sandbox } from "@cloudflare/sandbox";

import type { ServiceConfig } from "../types";

/**
 * Git smart HTTP protocol paths pattern.
 *
 * Matches: /{owner}/{repo}[.git]/{info/refs|git-upload-pack|git-receive-pack}
 * The .git suffix is optional.
 */
const ALLOWED_GIT_PATHS =
	/^\/.+\/.+(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * GitHub git proxy service configuration.
 *
 * Expects the JWT token in the `Authorization: Bearer {token}` header.
 * Only allows git protocol paths for security.
 */
export const github: ServiceConfig<Env> = {
	target: "https://github.com",

	validate: (req) =>
		req.headers.get("Authorization")?.replace("Bearer ", "") ?? null,

	transform: async (req, ctx) => {
		if (!ctx.env.GITHUB_TOKEN) {
			return new Response("GITHUB_TOKEN not configured", { status: 500 });
		}

		const url = new URL(req.url);

		// Only allow git-specific paths (info/refs, git-upload-pack, git-receive-pack)
		// This prevents using the proxy for arbitrary GitHub API calls
		if (!ALLOWED_GIT_PATHS.test(url.pathname)) {
			return new Response("Invalid git path", { status: 400 });
		}

		// Use Basic auth with x-access-token (GitHub's preferred method for tokens)
		req.headers.set(
			"Authorization",
			`Basic ${btoa(`x-access-token:${ctx.env.GITHUB_TOKEN}`)}`,
		);
		req.headers.set("User-Agent", "Sandbox-Git-Proxy");

		return req;
	},
};

/**
 * Configure a sandbox to use the GitHub proxy for git operations.
 *
 * Sets up git URL rewriting so all github.com URLs go through the proxy:
 * - url.*.insteadOf: Rewrites https://github.com/ to proxy URL
 * - http.*.extraheader: Adds JWT token for proxy authentication
 *
 * After calling this, normal git commands work transparently:
 * - git clone https://github.com/owner/repo
 * - git push origin main
 *
 * @param sandbox - The sandbox instance to configure
 * @param proxyBase - Base URL of the proxy (e.g., 'https://worker.dev')
 * @param token - JWT proxy token
 */
export async function configureGithub(
	sandbox: Sandbox,
	proxyBase: string,
	token: string,
): Promise<void> {
	const gitProxy = `${proxyBase}/proxy/github`;

	// Rewrite github.com URLs to go through the proxy
	await sandbox.exec(
		`git config --global url."${gitProxy}/".insteadOf "https://github.com/"`,
	);

	// Add JWT token for proxy authentication
	await sandbox.exec(
		`git config --global http.${gitProxy}/.extraheader "Authorization: Bearer ${token}"`,
	);
}
