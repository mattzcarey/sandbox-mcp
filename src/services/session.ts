// src/services/session.ts
import {
	Context,
	Effect,
	Layer,
	Option,
	ParseResult,
	Schedule,
	Schema,
} from "effect";

import {
	SessionStorageReadError,
	SessionStorageWriteError,
} from "../models/errors";
import { SessionMetadata } from "../models/session";
import { StorageKeys } from "../storage/keys";

/**
 * Session service that uses R2 as the storage backend.
 *
 * Storage layout (see src/storage/keys.ts):
 * - sessions/_index.json      <- Index of all sessions (for efficient listing)
 * - sessions/{sessionId}.json <- Full session data
 *
 * This provides a single source of truth for session metadata that can be
 * accessed from any worker or DO instance, solving the cross-DO access problem
 * inherent in the MCP library's per-connection DO model.
 *
 * Note: Run records are stored separately in R2 via RunStorage
 * (see src/services/run.ts) using a global runs index.
 */

// =============================================================================
// Index Schema
// =============================================================================

/**
 * Lightweight session entry for the index
 */
const SessionIndexEntry = Schema.Struct({
	sessionId: Schema.String,
	status: Schema.String,
	createdAt: Schema.Number,
	lastActivity: Schema.Number,
	title: Schema.optionalWith(Schema.String, { exact: true }),
});
type SessionIndexEntry = typeof SessionIndexEntry.Type;

/**
 * The session index stored at sessions/_index.json
 */
const SessionIndex = Schema.Struct({
	version: Schema.Literal(1),
	sessions: Schema.Record({ key: Schema.String, value: SessionIndexEntry }),
	updatedAt: Schema.Number,
});
type SessionIndex = typeof SessionIndex.Type;

// =============================================================================
// Constants
// =============================================================================

// Use StorageKeys for single source of truth
const INDEX_KEY = StorageKeys.sessionIndex();

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Result of listing sessions
 */
interface ListSessionsResult {
	/** Session entries from the index */
	sessions: SessionIndexEntry[];
	/** Total count of sessions */
	total: number;
}

/**
 * Session storage service interface
 */
interface SessionStorageService {
	/**
	 * Get a session by ID
	 * Returns Option.none() if not found
	 */
	readonly getSession: (
		sessionId: string,
	) => Effect.Effect<Option.Option<SessionMetadata>, SessionStorageReadError>;

	/**
	 * Save a session (creates or updates)
	 * Also updates the session index
	 */
	readonly putSession: (
		session: SessionMetadata,
	) => Effect.Effect<void, SessionStorageWriteError | SessionStorageReadError>;

	/**
	 * Delete a session by ID
	 * Also removes from the session index
	 *
	 * IMPORTANT: Callers should delete all runs for this session first
	 * using RunStorage.deleteAllRuns(sessionId) to avoid orphaned run data.
	 */
	readonly deleteSession: (
		sessionId: string,
	) => Effect.Effect<void, SessionStorageWriteError | SessionStorageReadError>;

	/**
	 * List all sessions from the index
	 * This is O(1) - reads a single index object
	 */
	readonly listSessions: (options?: {
		limit?: number;
		offset?: number;
	}) => Effect.Effect<ListSessionsResult, SessionStorageReadError>;
}

// =============================================================================
// Service Tag
// =============================================================================

/**
 * Effect Context tag for SessionStorageService
 */
export class SessionStorage extends Context.Tag("SessionStorage")<
	SessionStorage,
	SessionStorageService
>() {}

// =============================================================================
// Implementation Helpers
// =============================================================================

/**
 * Format parse errors for human-readable messages
 */
function formatParseError(error: ParseResult.ParseError): string {
	const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
	return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * Read the session index from R2
 * Returns an empty index if it doesn't exist
 */
function readIndex(
	bucket: R2Bucket,
): Effect.Effect<
	{ index: SessionIndex; etag?: string },
	SessionStorageReadError
> {
	return Effect.gen(function* () {
		const object = yield* Effect.tryPromise({
			try: () => bucket.get(INDEX_KEY),
			catch: (error) =>
				new SessionStorageReadError({
					sessionId: "_index",
					cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
		});

		if (!object) {
			// Return empty index
			return {
				index: {
					version: 1 as const,
					sessions: {},
					updatedAt: Date.now(),
				},
				etag: undefined,
			};
		}

		const json = yield* Effect.tryPromise({
			try: () => object.json<unknown>(),
			catch: (error) =>
				new SessionStorageReadError({
					sessionId: "_index",
					cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				}),
		});

		const index = yield* Schema.decodeUnknown(SessionIndex)(json).pipe(
			Effect.mapError(
				(parseError) =>
					new SessionStorageReadError({
						sessionId: "_index",
						cause: `Schema validation failed: ${formatParseError(parseError)}`,
					}),
			),
		);

		return { index, etag: object.etag };
	});
}

/**
 * Write the session index to R2
 * Uses conditional write with etag for optimistic concurrency
 */
function writeIndex(
	bucket: R2Bucket,
	index: SessionIndex,
	expectedEtag?: string,
): Effect.Effect<void, SessionStorageWriteError> {
	return Effect.tryPromise({
		try: async () => {
			const options: R2PutOptions = {
				httpMetadata: { contentType: "application/json" },
			};

			// Use conditional write if we have an etag (optimistic locking)
			if (expectedEtag) {
				options.onlyIf = { etagMatches: expectedEtag };
			}

			const result = await bucket.put(
				INDEX_KEY,
				JSON.stringify(index),
				options,
			);

			// If conditional write fails, result is null
			if (result === null && expectedEtag) {
				throw new Error(
					"Concurrent modification detected - index was modified by another request",
				);
			}
		},
		catch: (error) =>
			new SessionStorageWriteError({
				sessionId: "_index",
				cause: error instanceof Error ? error.message : String(error),
			}),
	});
}

/**
 * Create an index entry from full session metadata
 */
function toIndexEntry(session: SessionMetadata): SessionIndexEntry {
	return {
		sessionId: session.sessionId,
		status: session.status,
		createdAt: session.createdAt,
		lastActivity: session.lastActivity,
		title: session.title,
	};
}

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Create the SessionStorageService implementation
 */
function makeSessionStorageService(bucket: R2Bucket): SessionStorageService {
	return {
		getSession: (sessionId) =>
			Effect.gen(function* () {
				const key = StorageKeys.session(sessionId);

				const object = yield* Effect.tryPromise({
					try: () => bucket.get(key),
					catch: (error) =>
						new SessionStorageReadError({
							sessionId,
							cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				if (!object) {
					return Option.none<SessionMetadata>();
				}

				const json = yield* Effect.tryPromise({
					try: () => object.json<unknown>(),
					catch: (error) =>
						new SessionStorageReadError({
							sessionId,
							cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				const parsed = yield* Schema.decodeUnknown(SessionMetadata)(json).pipe(
					Effect.mapError(
						(parseError) =>
							new SessionStorageReadError({
								sessionId,
								cause: `Schema validation failed: ${formatParseError(parseError)}`,
							}),
					),
				);

				return Option.some(parsed);
			}),

		putSession: (session) =>
			Effect.gen(function* () {
				// Validate session before writing (defense-in-depth)
				yield* Schema.encode(SessionMetadata)(session).pipe(
					Effect.mapError(
						(parseError) =>
							new SessionStorageWriteError({
								sessionId: session.sessionId,
								cause: `Schema validation failed: ${formatParseError(parseError)}`,
							}),
					),
				);

				// Write the full session metadata
				const key = StorageKeys.session(session.sessionId);
				yield* Effect.tryPromise({
					try: () =>
						bucket.put(key, JSON.stringify(session), {
							httpMetadata: { contentType: "application/json" },
						}),
					catch: (error) =>
						new SessionStorageWriteError({
							sessionId: session.sessionId,
							cause: error instanceof Error ? error.message : String(error),
						}),
				});

				// Update the index with retry on concurrent modification
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index, etag } = yield* readIndex(bucket);

						// Update the session entry
						const updatedIndex: SessionIndex = {
							...index,
							sessions: {
								...index.sessions,
								[session.sessionId]: toIndexEntry(session),
							},
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, etag);
					}),
					// Retry up to 3 times with exponential backoff
					Schedule.intersect(
						Schedule.recurs(3),
						Schedule.exponential("10 millis", 2),
					),
				);
			}),

		deleteSession: (sessionId) =>
			Effect.gen(function* () {
				// Delete the session metadata
				const key = StorageKeys.session(sessionId);
				yield* Effect.tryPromise({
					try: () => bucket.delete(key),
					catch: (error) =>
						new SessionStorageWriteError({
							sessionId,
							cause: error instanceof Error ? error.message : String(error),
						}),
				});

				// Update the index with retry on concurrent modification
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index, etag } = yield* readIndex(bucket);

						// Remove the session entry
						// eslint-disable-next-line @typescript-eslint/no-unused-vars
						const { [sessionId]: _, ...remainingSessions } = index.sessions;

						const updatedIndex: SessionIndex = {
							...index,
							sessions: remainingSessions,
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, etag);
					}),
					// Retry up to 3 times with exponential backoff
					Schedule.intersect(
						Schedule.recurs(3),
						Schedule.exponential("10 millis", 2),
					),
				);
			}),

		listSessions: (options) =>
			Effect.gen(function* () {
				const { index } = yield* readIndex(bucket);

				// Convert to array and sort by lastActivity (most recent first)
				const allSessions = Object.values(index.sessions).sort(
					(a, b) => b.lastActivity - a.lastActivity,
				);

				// Apply pagination
				const offset = options?.offset ?? 0;
				const limit = options?.limit ?? 100;
				const sessions = allSessions.slice(offset, offset + limit);

				return {
					sessions,
					total: allSessions.length,
				};
			}),
	};
}

// =============================================================================
// Layer
// =============================================================================

/**
 * Create a Layer for SessionStorageService from an R2 bucket
 */
export function makeSessionStorageLayer(
	bucket: R2Bucket,
): Layer.Layer<SessionStorage> {
	return Layer.succeed(SessionStorage, makeSessionStorageService(bucket));
}
