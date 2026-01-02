// src/storage/keys.ts
/**
 * Single source of truth for R2 storage key patterns.
 *
 * Storage layout:
 * - sessions/_index.json           <- Index of all sessions
 * - sessions/{sessionId}.json      <- Full session data
 * - runs/_index.json               <- Global index of all runs
 * - runs/{runId}.json              <- Full run record
 */

export const StorageKeys = {
	/** Index of all sessions: sessions/_index.json */
	sessionIndex: () => "sessions/_index.json",

	/** Session data: sessions/{sessionId}.json */
	session: (sessionId: string) => `sessions/${sessionId}.json`,

	/** Global index of all runs: runs/_index.json */
	runIndex: () => "runs/_index.json",

	/** Run data: runs/{runId}.json */
	run: (runId: string) => `runs/${runId}.json`,
} as const;
