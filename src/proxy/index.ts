/**
 * Zero-trust authentication proxy for sandbox-mcp.
 *
 * This module provides JWT-based proxy authentication so that sandboxes
 * never receive real credentials. Instead:
 * 1. Sandbox receives a short-lived JWT token
 * 2. All external API calls go through proxy routes
 * 3. Proxy validates JWT, injects real credentials, forwards to service
 * 4. Real secrets exist only in the Worker environment
 */

// Handler
export { createProxyHandler } from "./handler";

// Services
export {
	anthropic,
	configureAnthropic,
	configureGithub,
	github,
} from "./services";

// Token (Effect-native)
export { createProxyToken } from "./token";

// URL utilities
export { toContainerUrl } from "./url";
