import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const SessionErrorTypeId: unique symbol = Symbol.for(
	"@sandbox-mcp/SessionError",
);
export type SessionErrorTypeId = typeof SessionErrorTypeId;

export const SessionStorageErrorTypeId: unique symbol = Symbol.for(
	"@sandbox-mcp/SessionStorageError",
);
export type SessionStorageErrorTypeId = typeof SessionStorageErrorTypeId;

export const RunStorageErrorTypeId: unique symbol = Symbol.for(
	"@sandbox-mcp/RunStorageError",
);
export type RunStorageErrorTypeId = typeof RunStorageErrorTypeId;

// --- Session Errors ---

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
	"SessionNotFoundError",
	{ sessionId: Schema.String },
) {
	/** @public Used by isSessionError type guard */
	readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

	override get message(): string {
		return `Session "${this.sessionId}" not found`;
	}
}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()(
	"RunNotFoundError",
	{
		runId: Schema.String,
	},
) {
	/** @public Used by isSessionError type guard */
	readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

	override get message(): string {
		return `Run "${this.runId}" not found`;
	}
}

type SessionError = SessionNotFoundError | RunNotFoundError;

export const isSessionError = (u: unknown): u is SessionError =>
	Predicate.hasProperty(u, SessionErrorTypeId);

// --- Session Storage Errors (R2) ---

/**
 * Error reading session from R2 storage
 */
export class SessionStorageReadError extends Schema.TaggedError<SessionStorageReadError>()(
	"SessionStorageReadError",
	{
		sessionId: Schema.String,
		cause: Schema.String,
	},
) {
	/** @public Used by isSessionStorageError type guard */
	readonly [SessionStorageErrorTypeId]: SessionStorageErrorTypeId =
		SessionStorageErrorTypeId;

	override get message(): string {
		return `Failed to read session "${this.sessionId}": ${this.cause}`;
	}
}

/**
 * Error writing session to R2 storage
 */
export class SessionStorageWriteError extends Schema.TaggedError<SessionStorageWriteError>()(
	"SessionStorageWriteError",
	{
		sessionId: Schema.String,
		cause: Schema.String,
	},
) {
	/** @public Used by isSessionStorageError type guard */
	readonly [SessionStorageErrorTypeId]: SessionStorageErrorTypeId =
		SessionStorageErrorTypeId;

	override get message(): string {
		return `Failed to write session "${this.sessionId}": ${this.cause}`;
	}
}

type SessionStorageError = SessionStorageReadError | SessionStorageWriteError;

export const isSessionStorageError = (u: unknown): u is SessionStorageError =>
	Predicate.hasProperty(u, SessionStorageErrorTypeId);

// --- Run Storage Errors (R2) ---

/**
 * Error reading run from R2 storage
 */
export class RunStorageReadError extends Schema.TaggedError<RunStorageReadError>()(
	"RunStorageReadError",
	{
		runId: Schema.optionalWith(Schema.String, { exact: true }),
		cause: Schema.String,
	},
) {
	/** @public Used by isRunStorageError type guard */
	readonly [RunStorageErrorTypeId]: RunStorageErrorTypeId =
		RunStorageErrorTypeId;

	override get message(): string {
		if (this.runId) {
			return `Failed to read run "${this.runId}": ${this.cause}`;
		}
		return `Failed to read runs: ${this.cause}`;
	}
}

/**
 * Error writing run to R2 storage
 */
export class RunStorageWriteError extends Schema.TaggedError<RunStorageWriteError>()(
	"RunStorageWriteError",
	{
		runId: Schema.optionalWith(Schema.String, { exact: true }),
		cause: Schema.String,
	},
) {
	/** @public Used by isRunStorageError type guard */
	readonly [RunStorageErrorTypeId]: RunStorageErrorTypeId =
		RunStorageErrorTypeId;

	override get message(): string {
		if (this.runId) {
			return `Failed to write run "${this.runId}": ${this.cause}`;
		}
		return `Failed to write runs: ${this.cause}`;
	}
}

type RunStorageError = RunStorageReadError | RunStorageWriteError;

export const isRunStorageError = (u: unknown): u is RunStorageError =>
	Predicate.hasProperty(u, RunStorageErrorTypeId);
