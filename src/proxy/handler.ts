/**
 * Promise-based proxy handler for HTTP layer.
 *
 * This handler validates JWT tokens, resolves service configurations, transforms
 * requests by injecting real credentials, and forwards to external services.
 *
 * Kept Promise-based (rather than Effect) because it's the HTTP boundary layer
 * and benefits from straightforward request/response flow.
 */

import type { ProxyError } from "./errors";
import {
	isProxyError,
	ProxyPathInvalidError,
	ProxyServiceNotFoundError,
	ProxyTargetError,
	ProxyTokenMissingError,
} from "./errors";
import { verifyProxyTokenAsync } from "./token";
import type {
	ProxyContext,
	ProxyHandler,
	ProxyHandlerConfig,
	ServiceConfig,
} from "./types";

/**
 * Parse the proxy path to extract service name and target path.
 *
 * @param pathname - Full request pathname (e.g., '/proxy/anthropic/v1/messages')
 * @param mountPath - Proxy mount path (e.g., '/proxy')
 * @returns Object with service name and remaining path
 * @throws ProxyPathInvalidError if path doesn't match expected format
 */
function parseProxyPath(
	pathname: string,
	mountPath: string,
): { service: string; path: string } {
	// Normalize mount path to have leading slash but no trailing slash
	const normalizedMount = `/${mountPath.replace(/^\/|\/$/g, "")}`;

	if (!pathname.startsWith(normalizedMount)) {
		throw new ProxyPathInvalidError({
			path: pathname,
			mountPath: normalizedMount,
		});
	}

	const afterMount = pathname.slice(normalizedMount.length);

	// Must have at least /{service}
	if (!afterMount.startsWith("/") || afterMount === "/") {
		throw new ProxyPathInvalidError({
			path: pathname,
			mountPath: normalizedMount,
		});
	}

	const parts = afterMount.slice(1).split("/");
	const service = parts[0];
	const path = `/${parts.slice(1).join("/")}`;

	if (!service) {
		throw new ProxyPathInvalidError({
			path: pathname,
			mountPath: normalizedMount,
		});
	}

	return { service, path };
}

/**
 * Build the target URL for the proxied request.
 *
 * Uses URL API with relative path resolution. The path must NOT start with "/"
 * because absolute paths replace the entire base path:
 *   new URL("/messages", "https://api.anthropic.com/v1/") → .../messages (wrong!)
 *   new URL("messages", "https://api.anthropic.com/v1/")  → .../v1/messages (correct!)
 */
function buildTargetUrl(targetBase: string, path: string, query: string): URL {
	// Ensure base ends with "/" for proper URL resolution
	const base = targetBase.endsWith("/") ? targetBase : `${targetBase}/`;
	// Make path relative (remove leading "/") so URL resolution appends rather than replaces
	const relativePath = path.startsWith("/") ? path.slice(1) : path;
	const url = new URL(relativePath, base);
	url.search = query;
	return url;
}

/**
 * Convert a ProxyError to an HTTP Response.
 */
function errorResponse(error: ProxyError): Response {
	return new Response(
		JSON.stringify({ error: error.message, code: error.code }),
		{
			status: error.httpStatus,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * Create a proxy handler with the given configuration.
 *
 * @example
 * ```ts
 * const proxyHandler = createProxyHandler<Env>({
 *   mountPath: '/proxy',
 *   jwtSecret: (env) => env.PROXY_JWT_SECRET,
 *   services: { anthropic, github, r2 },
 * });
 *
 * // In fetch handler:
 * if (url.pathname.startsWith('/proxy/')) {
 *   return proxyHandler(request, env);
 * }
 * ```
 */
export function createProxyHandler<TEnv = unknown>(
	config: ProxyHandlerConfig<TEnv>,
): ProxyHandler<TEnv> {
	const { mountPath, jwtSecret, services } = config;
	const serviceNames = Object.keys(services);

	return async (request: Request, env: TEnv): Promise<Response> => {
		const url = new URL(request.url);

		try {
			// Parse the proxy path to get service and target path
			const { service, path } = parseProxyPath(url.pathname, mountPath);

			// Look up service configuration
			const serviceConfig = services[service] as
				| ServiceConfig<TEnv>
				| undefined;
			if (!serviceConfig) {
				throw new ProxyServiceNotFoundError({
					service,
					available: serviceNames,
				});
			}

			// Extract token from request using service's validate function
			const token = await serviceConfig.validate(request);
			if (!token) {
				throw new ProxyTokenMissingError({ service });
			}

			// Verify the JWT token
			const jwt = await verifyProxyTokenAsync({
				secret: jwtSecret(env),
				token,
			});

			// Build the target URL
			const targetUrl = buildTargetUrl(serviceConfig.target, path, url.search);

			// Create proxy request (copy original request with new URL)
			// Note: body must be null for GET/HEAD requests
			const hasBody = !["GET", "HEAD"].includes(request.method);
			const requestInit: RequestInit & { duplex?: string } = {
				method: request.method,
				headers: new Headers(request.headers),
				body: hasBody ? request.body : null,
				redirect: "manual",
			};
			// duplex required for streaming request bodies in Cloudflare Workers
			if (hasBody) {
				requestInit.duplex = "half";
			}
			const proxyRequest = new Request(targetUrl.toString(), requestInit);

			// Build context for transform function
			const ctx: ProxyContext<TEnv> = { jwt, env, service, request };

			// Transform the request (inject credentials)
			const result = await serviceConfig.transform(proxyRequest, ctx);

			// If transform returns a Response, return it directly (error case)
			if (result instanceof Response) {
				return result;
			}

			// Forward to target service
			const response = await fetch(result);

			// Return response (preserve status, headers, body)
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			// Handle known proxy errors
			if (isProxyError(error)) {
				return errorResponse(error);
			}

			// Handle fetch errors (target unreachable)
			if (error instanceof TypeError && error.message.includes("fetch")) {
				return errorResponse(
					new ProxyTargetError({
						service: "unknown",
						target: "unknown",
						cause: error.message,
					}),
				);
			}

			// Re-throw unknown errors
			throw error;
		}
	};
}
