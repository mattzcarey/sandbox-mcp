/**
 * Anthropic API proxy service configuration.
 *
 * This service proxies requests to the Anthropic API, extracting the JWT token
 * from the x-api-key header and replacing it with the real ANTHROPIC_API_KEY.
 *
 * Claude Code and the Anthropic SDK read ANTHROPIC_BASE_URL automatically,
 * so sandbox code works without modification when configured properly.
 */

import type { Sandbox } from "@cloudflare/sandbox";

import type { ServiceConfig } from "../types";

/**
 * Anthropic API proxy service configuration.
 *
 * Expects the JWT token in the `x-api-key` header (standard Anthropic header).
 */
export const anthropic: ServiceConfig<Env> = {
	target: "https://api.anthropic.com/v1",

	validate: (req) => req.headers.get("x-api-key"),

	transform: async (req, ctx) => {
		if (!ctx.env.ANTHROPIC_API_KEY) {
			return new Response("ANTHROPIC_API_KEY not configured", { status: 500 });
		}
		req.headers.set("x-api-key", ctx.env.ANTHROPIC_API_KEY);
		return req;
	},
};

/**
 * Configure a sandbox to use the Anthropic proxy.
 *
 * Sets environment variables in /workspace/.env that the Anthropic SDK
 * will automatically pick up:
 * - ANTHROPIC_BASE_URL: Points to our proxy
 * - ANTHROPIC_API_KEY: The JWT token (proxy validates and replaces)
 *
 * @param sandbox - The sandbox instance to configure
 * @param proxyBase - Base URL of the proxy (e.g., 'https://worker.dev')
 * @param token - JWT proxy token
 */
export async function configureAnthropic(
	sandbox: Sandbox,
	proxyBase: string,
	token: string,
): Promise<void> {
	await sandbox.exec(
		`echo 'ANTHROPIC_BASE_URL=${proxyBase}/proxy/anthropic' >> /workspace/.env`,
	);
	await sandbox.exec(`echo 'ANTHROPIC_API_KEY=${token}' >> /workspace/.env`);
}
