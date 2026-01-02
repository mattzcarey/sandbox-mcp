// src/workflows/helpers/run.ts

import * as Effect from "effect/Effect";

import type { RunRecord } from "../../models/run";
import { makeRunStorageLayer, RunStorage } from "../../services/run";
import {
	makeSessionStorageLayer,
	SessionStorage,
} from "../../services/session";

/**
 * Run workflow helpers - async wrappers around Effect services for use in workflow steps.
 *
 * These functions provide a simple async/await interface for Cloudflare Workflows,
 * which don't use Effect. They delegate all logic to the Effect-based services,
 * ensuring a single source of truth for storage operations.
 *
 * Storage layout (see src/storage/keys.ts):
 * - runs/_index.json      <- Global index of all runs
 * - runs/{runId}.json     <- Full run record
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a new run record in R2.
 *
 * Called from the workflow's "create-run" step after proxy configuration.
 * Delegates to RunStorage.putRun for actual storage logic.
 */
export async function createRun(
	bucket: R2Bucket,
	run: RunRecord,
): Promise<void> {
	const layer = makeRunStorageLayer(bucket);
	await Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const storage = yield* RunStorage;
				yield* storage.putRun(run);
			}),
			layer,
		),
	);
}

/**
 * Update a run with completion result.
 *
 * Called from the workflow's "complete-run" step after task execution.
 * Delegates to RunStorage.completeRun for actual storage logic.
 */
export async function completeRun(
	bucket: R2Bucket,
	runId: string,
	result: {
		success: boolean;
		output?: string;
		error?: string;
		title?: string;
	},
): Promise<void> {
	const layer = makeRunStorageLayer(bucket);
	await Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const storage = yield* RunStorage;
				yield* storage.completeRun(runId, result);
			}),
			layer,
		),
	);
}

/**
 * Update session metadata after run completion.
 *
 * Called from the workflow's "complete-run" step to persist
 * opencodeSessionId and workspacePath back to the session.
 * Also updates the session index so lastActivity is reflected in listings.
 */
export async function updateSessionAfterRun(
	bucket: R2Bucket,
	sessionId: string,
	updates: {
		opencodeSessionId?: string;
		workspacePath?: string;
	},
): Promise<void> {
	const layer = makeSessionStorageLayer(bucket);
	await Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const storage = yield* SessionStorage;
				const existing = yield* storage.getSession(sessionId);

				if (existing._tag === "None") {
					// Session not found - this shouldn't happen in normal flow
					// but we don't want to fail the workflow for this
					console.warn(
						`Session ${sessionId} not found when updating after run`,
					);
					return;
				}

				const session = existing.value;
				const updatedSession = {
					...session,
					opencodeSessionId:
						updates.opencodeSessionId ?? session.opencodeSessionId,
					workspacePath: updates.workspacePath ?? session.workspacePath,
					lastActivity: Date.now(),
				};

				yield* storage.putSession(updatedSession);
			}),
			layer,
		),
	);
}
