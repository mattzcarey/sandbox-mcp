/**
 * Proxy types for zero-trust authentication proxy.
 *
 * These types define the contract for service configurations and proxy handling.
 * The proxy validates JWT tokens and injects real credentials before forwarding
 * requests to external services.
 */

/**
 * JWT token payload structure.
 */
export interface ProxyTokenPayload {
	/** Sandbox identifier (required claim) */
	sandboxId: string;
	/** Session identifier (optional claim) */
	sessionId?: string;
	/** Expiration time (Unix timestamp) */
	exp: number;
	/** Issued at time (Unix timestamp) */
	iat: number;
}

/**
 * Options for creating a proxy token.
 */
export interface CreateProxyTokenOptions {
	/** JWT signing secret */
	secret: string;
	/** Sandbox identifier to embed in token */
	sandboxId: string;
	/** Optional session identifier */
	sessionId?: string;
	/**
	 * Token expiration time.
	 * Supports formats: '15m', '1h', '8h', '1d', or seconds as number.
	 * Default: '15m'
	 */
	expiresIn?: string;
}

/**
 * Options for verifying a proxy token.
 */
export interface VerifyProxyTokenOptions {
	/** JWT signing secret (must match the one used to create the token) */
	secret: string;
	/** The JWT token string to verify */
	token: string;
}

/**
 * Context passed to service transform functions.
 */
export interface ProxyContext<TEnv = unknown> {
	/** Verified JWT payload */
	jwt: ProxyTokenPayload;
	/** Worker environment bindings */
	env: TEnv;
	/** Service name being proxied */
	service: string;
	/** Original incoming request */
	request: Request;
}

/**
 * Configuration for a proxied service.
 *
 * Each service defines how to:
 * 1. Extract the proxy token from incoming requests
 * 2. Transform requests by injecting real credentials
 */
export interface ServiceConfig<TEnv = unknown> {
	/** Target base URL for the service */
	target: string;

	/**
	 * Extract the proxy token from the incoming request.
	 * Return null if no token is present.
	 */
	validate: (request: Request) => string | null | Promise<string | null>;

	/**
	 * Transform the request by injecting real credentials.
	 * Return a Response to short-circuit with an error (e.g., missing env vars).
	 * Return a Request to continue proxying.
	 */
	transform: (
		request: Request,
		ctx: ProxyContext<TEnv>,
	) => Promise<Request | Response>;
}

/**
 * Configuration for the proxy handler.
 */
export interface ProxyHandlerConfig<TEnv = unknown> {
	/** Mount path for proxy routes (e.g., '/proxy') */
	mountPath: string;
	/** Function to extract JWT secret from environment */
	jwtSecret: (env: TEnv) => string;
	/** Service configurations keyed by service name */
	services: Record<string, ServiceConfig<TEnv>>;
}

/**
 * Proxy handler function signature.
 */
export type ProxyHandler<TEnv = unknown> = (
	request: Request,
	env: TEnv,
) => Promise<Response>;
