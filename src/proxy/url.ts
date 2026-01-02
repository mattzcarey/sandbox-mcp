/**
 * URL utilities for proxy configuration.
 */

/**
 * Convert a URL to be accessible from inside a Docker container.
 *
 * In local dev, the proxy runs on the host at localhost:8788, but containers
 * can't reach "localhost" (it refers to the container itself). Docker provides
 * "host.docker.internal" as a special DNS name that resolves to the host.
 *
 * In production, URLs don't use localhost so this is a no-op.
 */
export function toContainerUrl(url: string): string {
	return url.replace(/localhost|127\.0\.0\.1/g, "host.docker.internal");
}
