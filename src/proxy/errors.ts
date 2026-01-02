import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const ProxyErrorTypeId: unique symbol = Symbol.for(
	"@sandbox-mcp/ProxyError",
);
export type ProxyErrorTypeId = typeof ProxyErrorTypeId;

// --- Proxy Errors ---

export class ProxyTokenMissingError extends Schema.TaggedError<ProxyTokenMissingError>()(
	"ProxyTokenMissingError",
	{ service: Schema.String },
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_TOKEN_MISSING";
	readonly httpStatus = 401;

	override get message(): string {
		return `No authentication token provided for service '${this.service}'`;
	}
}

export class ProxyTokenInvalidError extends Schema.TaggedError<ProxyTokenInvalidError>()(
	"ProxyTokenInvalidError",
	{ reason: Schema.String },
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_TOKEN_INVALID";
	readonly httpStatus = 401;

	override get message(): string {
		return `Invalid proxy token: ${this.reason}`;
	}
}

export class ProxyTokenExpiredError extends Schema.TaggedError<ProxyTokenExpiredError>()(
	"ProxyTokenExpiredError",
	{},
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_TOKEN_EXPIRED";
	readonly httpStatus = 401;

	override get message(): string {
		return "Token has expired";
	}
}

export class ProxyServiceNotFoundError extends Schema.TaggedError<ProxyServiceNotFoundError>()(
	"ProxyServiceNotFoundError",
	{
		service: Schema.String,
		available: Schema.Array(Schema.String),
	},
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_SERVICE_NOT_FOUND";
	readonly httpStatus = 404;

	override get message(): string {
		return `Service '${this.service}' not configured. Available: ${this.available.join(", ")}`;
	}
}

export class ProxyPathInvalidError extends Schema.TaggedError<ProxyPathInvalidError>()(
	"ProxyPathInvalidError",
	{
		path: Schema.String,
		mountPath: Schema.String,
	},
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_PATH_INVALID";
	readonly httpStatus = 400;

	override get message(): string {
		return `Invalid proxy path '${this.path}'. Expected: ${this.mountPath}/{service}/{path}`;
	}
}

export class ProxyTargetError extends Schema.TaggedError<ProxyTargetError>()(
	"ProxyTargetError",
	{
		service: Schema.String,
		target: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;

	readonly code = "PROXY_TARGET_ERROR";
	readonly httpStatus = 502;

	override get message(): string {
		return `Failed to proxy to ${this.service} (${this.target}): ${this.cause}`;
	}
}

export type ProxyError =
	| ProxyTokenMissingError
	| ProxyTokenInvalidError
	| ProxyTokenExpiredError
	| ProxyServiceNotFoundError
	| ProxyPathInvalidError
	| ProxyTargetError;

export const isProxyError = (u: unknown): u is ProxyError =>
	Predicate.hasProperty(u, ProxyErrorTypeId);
