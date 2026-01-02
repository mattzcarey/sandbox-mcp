/**
 * Effect-native JWT token creation and verification for proxy authentication.
 *
 * These functions return Effect types for integration with the Effect-based
 * MCP agent code. Errors are typed using Schema.TaggedError classes.
 */

import { Effect } from "effect";
import { jwtVerify, SignJWT } from "jose";

import { ProxyTokenExpiredError, ProxyTokenInvalidError } from "./errors";
import type {
	CreateProxyTokenOptions,
	ProxyTokenPayload,
	VerifyProxyTokenOptions,
} from "./types";

/**
 * Parse expiration time string to seconds.
 *
 * @param expiresIn - Time string like '15m', '2h', '1d', or seconds as string
 * @returns Expiration time in seconds
 * @throws Error if format is invalid
 */
function parseExpiresIn(expiresIn: string): number {
	const match = expiresIn.match(/^(\d+)(m|h|d)?$/);
	if (!match) {
		throw new Error(
			`Invalid expiresIn format: ${expiresIn}. Use '30m', '2h', '1d', or seconds.`,
		);
	}

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case "m":
			return value * 60;
		case "h":
			return value * 60 * 60;
		case "d":
			return value * 60 * 60 * 24;
		default:
			return value;
	}
}

/**
 * Create a JWT proxy token.
 *
 * Returns an Effect that produces a signed JWT string or fails with
 * ProxyTokenInvalidError if token creation fails.
 *
 * @example
 * ```ts
 * const token = await Effect.runPromise(
 *   createProxyToken({
 *     secret: env.PROXY_JWT_SECRET,
 *     sandboxId: "sandbox-123",
 *     sessionId: "session-456",
 *     expiresIn: "2h",
 *   })
 * );
 * ```
 */
export const createProxyToken = (
	options: CreateProxyTokenOptions,
): Effect.Effect<string, ProxyTokenInvalidError> =>
	Effect.tryPromise({
		try: async () => {
			const { secret, sandboxId, sessionId, expiresIn = "15m" } = options;

			if (!secret) throw new Error("JWT secret is required");
			if (!sandboxId) throw new Error("Sandbox ID is required");

			const secretKey = new TextEncoder().encode(secret);
			const expirationSeconds = parseExpiresIn(expiresIn);
			const now = Math.floor(Date.now() / 1000);

			return new SignJWT({
				sandboxId,
				...(sessionId && { sessionId }),
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuedAt(now)
				.setExpirationTime(now + expirationSeconds)
				.sign(secretKey);
		},
		catch: (error) =>
			new ProxyTokenInvalidError({
				reason:
					error instanceof Error ? error.message : "Token creation failed",
			}),
	});

/**
 * Verify a JWT proxy token and extract its payload.
 *
 * Returns an Effect that produces the token payload or fails with:
 * - ProxyTokenExpiredError if the token has expired
 * - ProxyTokenInvalidError for other validation failures
 *
 * @example
 * ```ts
 * const payload = await Effect.runPromise(
 *   verifyProxyToken({
 *     secret: env.PROXY_JWT_SECRET,
 *     token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
 *   })
 * );
 * console.log(payload.sandboxId, payload.exp);
 * ```
 */
const verifyProxyToken = (
	options: VerifyProxyTokenOptions,
): Effect.Effect<
	ProxyTokenPayload,
	ProxyTokenExpiredError | ProxyTokenInvalidError
> =>
	Effect.tryPromise({
		try: async () => {
			const { secret, token } = options;

			if (!secret) throw new Error("JWT secret is required");
			if (!token) throw new Error("Token is required");

			const secretKey = new TextEncoder().encode(secret);
			const { payload } = await jwtVerify(token, secretKey, {
				algorithms: ["HS256"],
			});

			// Validate required claims
			if (typeof payload.sandboxId !== "string") {
				throw new Error("Missing sandboxId in token");
			}
			if (typeof payload.exp !== "number") {
				throw new Error("Missing expiration in token");
			}
			if (typeof payload.iat !== "number") {
				throw new Error("Missing issued-at in token");
			}

			return {
				sandboxId: payload.sandboxId,
				sessionId:
					typeof payload.sessionId === "string" ? payload.sessionId : undefined,
				exp: payload.exp,
				iat: payload.iat,
			};
		},
		catch: (error) => {
			const message = error instanceof Error ? error.message : "Unknown error";

			// Map specific JWT errors to appropriate error types
			if (message.includes("expired")) {
				return new ProxyTokenExpiredError({});
			}
			if (message.includes("signature")) {
				return new ProxyTokenInvalidError({
					reason: "Invalid token signature",
				});
			}
			if (message.includes("malformed")) {
				return new ProxyTokenInvalidError({ reason: "Malformed token" });
			}

			return new ProxyTokenInvalidError({ reason: message });
		},
	});

/**
 * Promise-based token verification for use in the HTTP handler layer.
 *
 * This is a convenience wrapper for use in Promise-based code (like the proxy handler).
 * Throws ProxyTokenExpiredError or ProxyTokenInvalidError on failure.
 */
export function verifyProxyTokenAsync(
	options: VerifyProxyTokenOptions,
): Promise<ProxyTokenPayload> {
	return Effect.runPromise(verifyProxyToken(options));
}
