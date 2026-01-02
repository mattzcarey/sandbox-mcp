// src/services/run.ts
import {
	Context,
	Effect,
	Layer,
	Option,
	ParseResult,
	Schedule,
	Schema,
} from "effect";

import { RunStorageReadError, RunStorageWriteError } from "../models/errors";
import { RunRecord } from "../models/run";
import { StorageKeys } from "../storage/keys";

/**
 * Run storage service that uses R2 as the storage backend.
 *
 * Storage layout (see src/storage/keys.ts):
 * - runs/_index.json      <- Global index of all runs
 * - runs/{runId}.json     <- Full run record
 *
 * This provides a single source of truth for run records that can be
 * accessed from any worker or DO instance, solving the cross-DO access problem
 * inherent in the MCP library's per-connection DO model.
 *
 * The global index enables cross-session queries without knowing sessionIds.
 *
 * Concurrency: Index updates use optimistic locking with etags. On concurrent
 * modification, the operation retries with exponential backoff. This ensures
 * consistency without distributed locks.
 */

// =============================================================================
// Constants
// =============================================================================

/** Maximum retries for index updates on concurrent modification */
const MAX_INDEX_RETRIES = 3;

/** Base delay for exponential backoff (doubles on each retry) */
const RETRY_BASE_DELAY = "10 millis";

// =============================================================================
// Index Schema
// =============================================================================

/**
 * Lightweight run entry for the index
 */
const RunIndexEntry = Schema.Struct({
	runId: Schema.String,
	sessionId: Schema.String, // Enables session filtering
	status: Schema.String,
	title: Schema.String,
	startedAt: Schema.Number,
	completedAt: Schema.optionalWith(Schema.Number, { exact: true }),
});
type RunIndexEntry = typeof RunIndexEntry.Type;

/**
 * The global run index stored at runs/_index.json
 */
const RunIndex = Schema.Struct({
	version: Schema.Literal(1),
	runs: Schema.Record({ key: Schema.String, value: RunIndexEntry }),
	updatedAt: Schema.Number,
});
type RunIndex = typeof RunIndex.Type;

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Result of listing runs from the global index
 */
interface ListRunsResult {
	/** Run entries matching the filters, sorted by startedAt descending */
	runs: RunIndexEntry[];
	/** Total count of matching runs (before limit applied) */
	total: number;
}

/**
 * Options for filtering and paginating run listings.
 * All filters are optional - omit all to list all runs.
 */
interface ListRunsOptions {
	/** Filter to runs belonging to this session */
	sessionId?: string;
	/** Filter to runs with this status (started, running, completed, failed) */
	status?: string;
	/** Maximum number of runs to return (default: 100) */
	limit?: number;
	/** Unix timestamp cursor - returns runs started before this time */
	before?: number;
}

/**
 * Result of completing a run
 */
interface CompleteRunResult {
	success: boolean;
	output?: string;
	error?: string;
	title?: string;
}

/**
 * Run storage service interface
 */
interface RunStorageService {
	/**
	 * Get a run by ID
	 * Returns Option.none() if not found
	 */
	readonly getRun: (
		runId: string,
	) => Effect.Effect<Option.Option<RunRecord>, RunStorageReadError>;

	/**
	 * Save a run (creates or updates)
	 * Also updates the global run index
	 */
	readonly putRun: (
		run: RunRecord,
	) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

	/**
	 * Complete a run with success/failure result.
	 * Reads the run, updates status and result fields, writes back.
	 * This is an atomic read-modify-write operation.
	 */
	readonly completeRun: (
		runId: string,
		result: CompleteRunResult,
	) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

	/**
	 * List runs with optional filters
	 * This is O(1) - reads a single global index object
	 */
	readonly listRuns: (
		options?: ListRunsOptions,
	) => Effect.Effect<ListRunsResult, RunStorageReadError>;

	/**
	 * Delete a run by ID
	 * Also removes from the global run index
	 */
	readonly deleteRun: (
		runId: string,
	) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

	/**
	 * Delete all runs for a session (cascade delete)
	 * Reads global index, filters by sessionId, deletes matching runs
	 */
	readonly deleteRunsForSession: (
		sessionId: string,
	) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;
}

// =============================================================================
// Service Tag
// =============================================================================

/**
 * Effect Context tag for RunStorageService
 */
export class RunStorage extends Context.Tag("RunStorage")<
	RunStorage,
	RunStorageService
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
 * Read the global run index from R2
 * Returns an empty index if it doesn't exist
 */
function readIndex(
	bucket: R2Bucket,
): Effect.Effect<{ index: RunIndex; etag?: string }, RunStorageReadError> {
	return Effect.gen(function* () {
		const key = StorageKeys.runIndex();
		const object = yield* Effect.tryPromise({
			try: () => bucket.get(key),
			catch: (error) =>
				new RunStorageReadError({
					cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
		});

		if (!object) {
			// Return empty index
			return {
				index: {
					version: 1 as const,
					runs: {},
					updatedAt: Date.now(),
				},
				etag: undefined,
			};
		}

		const json = yield* Effect.tryPromise({
			try: () => object.json<unknown>(),
			catch: (error) =>
				new RunStorageReadError({
					cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				}),
		});

		const index = yield* Schema.decodeUnknown(RunIndex)(json).pipe(
			Effect.mapError(
				(parseError) =>
					new RunStorageReadError({
						cause: `Schema validation failed: ${formatParseError(parseError)}`,
					}),
			),
		);

		return { index, etag: object.etag };
	});
}

/**
 * Write the global run index to R2
 * Uses conditional write with etag for optimistic concurrency
 */
function writeIndex(
	bucket: R2Bucket,
	index: RunIndex,
	expectedEtag?: string,
): Effect.Effect<void, RunStorageWriteError> {
	return Effect.tryPromise({
		try: async () => {
			const key = StorageKeys.runIndex();
			const options: R2PutOptions = {
				httpMetadata: { contentType: "application/json" },
			};

			// Use conditional write if we have an etag (optimistic locking)
			if (expectedEtag) {
				options.onlyIf = { etagMatches: expectedEtag };
			}

			const result = await bucket.put(key, JSON.stringify(index), options);

			// If conditional write fails, result is null
			if (result === null && expectedEtag) {
				throw new Error(
					"Concurrent modification detected - index was modified by another request",
				);
			}
		},
		catch: (error) =>
			new RunStorageWriteError({
				cause: error instanceof Error ? error.message : String(error),
			}),
	});
}

/**
 * Create an index entry from full run record
 */
function toIndexEntry(run: RunRecord): RunIndexEntry {
	return {
		runId: run.runId,
		sessionId: run.sessionId,
		status: run.status,
		title: run.title,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
	};
}

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Create the RunStorageService implementation
 */
function makeRunStorageService(bucket: R2Bucket): RunStorageService {
	return {
		getRun: (runId) =>
			Effect.gen(function* () {
				const key = StorageKeys.run(runId);

				const object = yield* Effect.tryPromise({
					try: () => bucket.get(key),
					catch: (error) =>
						new RunStorageReadError({
							runId,
							cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				if (!object) {
					return Option.none<RunRecord>();
				}

				const json = yield* Effect.tryPromise({
					try: () => object.json<unknown>(),
					catch: (error) =>
						new RunStorageReadError({
							runId,
							cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				const parsed = yield* Schema.decodeUnknown(RunRecord)(json).pipe(
					Effect.mapError(
						(parseError) =>
							new RunStorageReadError({
								runId,
								cause: `Schema validation failed: ${formatParseError(parseError)}`,
							}),
					),
				);

				return Option.some(parsed);
			}),

		putRun: (run) =>
			Effect.gen(function* () {
				const runId = run.runId;

				// Validate run before writing (defense-in-depth)
				yield* Schema.encode(RunRecord)(run).pipe(
					Effect.mapError(
						(parseError) =>
							new RunStorageWriteError({
								runId,
								cause: `Schema validation failed: ${formatParseError(parseError)}`,
							}),
					),
				);

				// Write the full run record
				const key = StorageKeys.run(runId);
				yield* Effect.tryPromise({
					try: () =>
						bucket.put(key, JSON.stringify(run), {
							httpMetadata: { contentType: "application/json" },
						}),
					catch: (error) =>
						new RunStorageWriteError({
							runId,
							cause: error instanceof Error ? error.message : String(error),
						}),
				});

				// Update the global index with retry on concurrent modification
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index, etag } = yield* readIndex(bucket);

						// Update the run entry
						const updatedIndex: RunIndex = {
							...index,
							runs: {
								...index.runs,
								[runId]: toIndexEntry(run),
							},
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, etag);
					}),
					Schedule.intersect(
						Schedule.recurs(MAX_INDEX_RETRIES),
						Schedule.exponential(RETRY_BASE_DELAY, 2),
					),
				);
			}),

		completeRun: (runId, result) =>
			Effect.gen(function* () {
				// Read existing run
				const key = StorageKeys.run(runId);
				const object = yield* Effect.tryPromise({
					try: () => bucket.get(key),
					catch: (error) =>
						new RunStorageReadError({
							runId,
							cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				if (!object) {
					return yield* Effect.fail(
						new RunStorageReadError({
							runId,
							cause: "Run not found",
						}),
					);
				}

				const json = yield* Effect.tryPromise({
					try: () => object.json<unknown>(),
					catch: (error) =>
						new RunStorageReadError({
							runId,
							cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
						}),
				});

				const existingRun = yield* Schema.decodeUnknown(RunRecord)(json).pipe(
					Effect.mapError(
						(parseError) =>
							new RunStorageReadError({
								runId,
								cause: `Schema validation failed: ${formatParseError(parseError)}`,
							}),
					),
				);

				// Build updated run with completion data
				const completedAt = Date.now();
				const updatedRun: typeof RunRecord.Type = {
					...existingRun,
					status: result.success ? "completed" : "failed",
					completedAt,
					title: result.title ?? existingRun.title,
					result: {
						success: result.success,
						output: result.output ?? "",
						error: result.error,
					},
				};

				// Write updated run
				yield* Effect.tryPromise({
					try: () =>
						bucket.put(key, JSON.stringify(updatedRun), {
							httpMetadata: { contentType: "application/json" },
						}),
					catch: (error) =>
						new RunStorageWriteError({
							runId,
							cause: error instanceof Error ? error.message : String(error),
						}),
				});

				// Update the global index with retry on concurrent modification
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index, etag } = yield* readIndex(bucket);

						const updatedIndex: RunIndex = {
							...index,
							runs: {
								...index.runs,
								[runId]: toIndexEntry(updatedRun),
							},
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, etag);
					}),
					Schedule.intersect(
						Schedule.recurs(MAX_INDEX_RETRIES),
						Schedule.exponential(RETRY_BASE_DELAY, 2),
					),
				);
			}),

		listRuns: (options) =>
			Effect.gen(function* () {
				const { index } = yield* readIndex(bucket);

				// Convert to array
				let allRuns = Object.values(index.runs);

				// Apply filters
				if (options?.sessionId) {
					allRuns = allRuns.filter((r) => r.sessionId === options.sessionId);
				}
				if (options?.status) {
					allRuns = allRuns.filter((r) => r.status === options.status);
				}
				if (options?.before) {
					allRuns = allRuns.filter((r) => r.startedAt < options.before!);
				}

				// Sort by startedAt (most recent first)
				allRuns.sort((a, b) => b.startedAt - a.startedAt);

				const total = allRuns.length;

				// Apply limit
				const limit = options?.limit ?? 100;
				const runs = allRuns.slice(0, limit);

				return { runs, total };
			}),

		deleteRun: (runId) =>
			Effect.gen(function* () {
				// Delete the run record
				const key = StorageKeys.run(runId);
				yield* Effect.tryPromise({
					try: () => bucket.delete(key),
					catch: (error) =>
						new RunStorageWriteError({
							runId,
							cause: error instanceof Error ? error.message : String(error),
						}),
				});

				// Update the global index with retry on concurrent modification
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index, etag } = yield* readIndex(bucket);

						// Remove the run entry
						// eslint-disable-next-line @typescript-eslint/no-unused-vars
						const { [runId]: _, ...remainingRuns } = index.runs;

						const updatedIndex: RunIndex = {
							...index,
							runs: remainingRuns,
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, etag);
					}),
					Schedule.intersect(
						Schedule.recurs(MAX_INDEX_RETRIES),
						Schedule.exponential(RETRY_BASE_DELAY, 2),
					),
				);
			}),

		deleteRunsForSession: (sessionId) =>
			Effect.gen(function* () {
				// Read index to find runs for this session
				const { index } = yield* readIndex(bucket);
				const runsToDelete = Object.values(index.runs).filter(
					(r) => r.sessionId === sessionId,
				);
				const runIdsToDelete = runsToDelete.map((r) => r.runId);

				if (runIdsToDelete.length === 0) {
					return; // Nothing to delete
				}

				// Update the index first with retry on concurrent modification
				// This makes the runs "invisible" even if subsequent file deletes fail.
				// Orphaned run files are less problematic than index entries pointing to deleted runs.
				yield* Effect.retry(
					Effect.gen(function* () {
						const { index: currentIndex, etag: currentEtag } =
							yield* readIndex(bucket);

						// Filter out runs belonging to this session
						const remainingRuns = Object.fromEntries(
							Object.entries(currentIndex.runs).filter(
								([_, entry]) => entry.sessionId !== sessionId,
							),
						);

						const updatedIndex: RunIndex = {
							...currentIndex,
							runs: remainingRuns,
							updatedAt: Date.now(),
						};

						yield* writeIndex(bucket, updatedIndex, currentEtag);
					}),
					Schedule.intersect(
						Schedule.recurs(MAX_INDEX_RETRIES),
						Schedule.exponential(RETRY_BASE_DELAY, 2),
					),
				);

				// Delete all run files (best effort after index is updated)
				for (const runId of runIdsToDelete) {
					const key = StorageKeys.run(runId);
					yield* Effect.tryPromise({
						try: () => bucket.delete(key),
						catch: (error) =>
							new RunStorageWriteError({
								runId,
								cause: error instanceof Error ? error.message : String(error),
							}),
					});
				}
			}),
	};
}

// =============================================================================
// Layer
// =============================================================================

/**
 * Create a Layer for RunStorageService from an R2 bucket
 */
export function makeRunStorageLayer(bucket: R2Bucket): Layer.Layer<RunStorage> {
	return Layer.succeed(RunStorage, makeRunStorageService(bucket));
}
