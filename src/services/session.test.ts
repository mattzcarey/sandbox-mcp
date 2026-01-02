import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SessionStorageReadError } from "../models/errors";
import type { SessionId, SessionMetadata } from "../models/session";
import { createMockR2Bucket } from "../test-utils/r2-mock";
import { makeSessionStorageLayer, SessionStorage } from "./session";

/**
 * Helper to run an effect with the SessionStorage layer
 */
function runWithStorage<A, E>(
	bucket: R2Bucket,
	effect: Effect.Effect<A, E, SessionStorage>,
): Promise<A> {
	const layer = makeSessionStorageLayer(bucket);
	return Effect.runPromise(Effect.provide(effect, layer));
}

/**
 * Helper to run an effect with the SessionStorage layer and get Exit
 */
function runWithStorageExit<A, E>(
	bucket: R2Bucket,
	effect: Effect.Effect<A, E, SessionStorage>,
): Promise<Exit.Exit<A, E>> {
	const layer = makeSessionStorageLayer(bucket);
	return Effect.runPromiseExit(Effect.provide(effect, layer));
}

describe("SessionService (R2)", () => {
	describe("getSession", () => {
		it("should store and retrieve session metadata", async () => {
			const bucket = createMockR2Bucket();

			const session: SessionMetadata = {
				sessionId: "test-session-123" as SessionId,
				sandboxId: "sandbox-123",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);
				return yield* storage.getSession(session.sessionId);
			});

			const result = await runWithStorage(bucket, program);

			expect(Option.isSome(result)).toBe(true);
			if (Option.isSome(result)) {
				expect(result.value.sessionId).toBe("test-session-123");
				expect(result.value.sandboxId).toBe("sandbox-123");
				expect(result.value.status).toBe("active");
			}
		});

		it("should return None for non-existent session", async () => {
			const bucket = createMockR2Bucket();

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.getSession("non-existent");
			});

			const result = await runWithStorage(bucket, program);

			expect(Option.isNone(result)).toBe(true);
		});

		it("should return SessionStorageReadError on R2 failure", async () => {
			const bucket = createMockR2Bucket({ failGet: true });

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.getSession("test-session");
			});

			const result = await runWithStorageExit(bucket, program);

			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				const error = result.cause;
				// Check that it's a fail with our error type
				expect(error._tag).toBe("Fail");
				if (error._tag === "Fail") {
					expect(error.error).toBeInstanceOf(SessionStorageReadError);
					expect((error.error as SessionStorageReadError).sessionId).toBe(
						"test-session",
					);
					expect((error.error as SessionStorageReadError).cause).toContain(
						"R2 get failed",
					);
				}
			}
		});

		it("should return SessionStorageReadError for invalid JSON", async () => {
			const bucket = createMockR2Bucket();
			// Manually insert invalid JSON
			bucket._store.set("sessions/bad-json.json", "not-valid-json{");

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.getSession("bad-json");
			});

			const result = await runWithStorageExit(bucket, program);

			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				const error = result.cause;
				expect(error._tag).toBe("Fail");
				if (error._tag === "Fail") {
					expect(error.error).toBeInstanceOf(SessionStorageReadError);
					expect((error.error as SessionStorageReadError).cause).toContain(
						"Invalid JSON",
					);
				}
			}
		});

		it("should return SessionStorageReadError for schema validation failure", async () => {
			const bucket = createMockR2Bucket();
			// Insert valid JSON but invalid session schema (missing required fields)
			bucket._store.set(
				"sessions/invalid-schema.json",
				JSON.stringify({ sessionId: "invalid-schema", wrongField: true }),
			);

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.getSession("invalid-schema");
			});

			const result = await runWithStorageExit(bucket, program);

			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				const error = result.cause;
				expect(error._tag).toBe("Fail");
				if (error._tag === "Fail") {
					expect(error.error).toBeInstanceOf(SessionStorageReadError);
					expect((error.error as SessionStorageReadError).cause).toContain(
						"Schema validation failed",
					);
				}
			}
		});
	});

	describe("putSession", () => {
		it("should store session at correct R2 key path", async () => {
			const bucket = createMockR2Bucket();

			const session: SessionMetadata = {
				sessionId: "key-path-test" as SessionId,
				sandboxId: "sandbox-kp",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);
			});

			await runWithStorage(bucket, program);

			expect(bucket._store.has("sessions/key-path-test.json")).toBe(true);
		});

		it("should also update the index when storing a session", async () => {
			const bucket = createMockR2Bucket();

			const session: SessionMetadata = {
				sessionId: "index-test" as SessionId,
				sandboxId: "sandbox-idx",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);
			});

			await runWithStorage(bucket, program);

			// Check that the index was created/updated
			expect(bucket._store.has("sessions/_index.json")).toBe(true);

			// Parse the index and verify the session is there
			const indexJson = bucket._store.get("sessions/_index.json");
			const index = JSON.parse(indexJson!);
			expect(index.sessions["index-test"]).toBeDefined();
			expect(index.sessions["index-test"].sessionId).toBe("index-test");
			expect(index.sessions["index-test"].status).toBe("active");
		});

		it("should return SessionStorageWriteError on R2 failure", async () => {
			const bucket = createMockR2Bucket({ failPut: true });

			const session: SessionMetadata = {
				sessionId: "fail-write" as SessionId,
				sandboxId: "sandbox",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);
			});

			const result = await runWithStorageExit(bucket, program);

			expect(Exit.isFailure(result)).toBe(true);
		});
	});

	describe("deleteSession", () => {
		it("should delete session and update index", async () => {
			const bucket = createMockR2Bucket();

			const session: SessionMetadata = {
				sessionId: "to-delete" as SessionId,
				sandboxId: "sandbox-del",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);

				// Verify session exists
				const before = yield* storage.getSession(session.sessionId);
				expect(Option.isSome(before)).toBe(true);

				yield* storage.deleteSession(session.sessionId);

				// Verify session is gone
				const after = yield* storage.getSession(session.sessionId);
				return after;
			});

			const result = await runWithStorage(bucket, program);
			expect(Option.isNone(result)).toBe(true);

			// Verify session was removed from index
			const indexJson = bucket._store.get("sessions/_index.json");
			const index = JSON.parse(indexJson!);
			expect(index.sessions["to-delete"]).toBeUndefined();
		});
	});

	describe("listSessions", () => {
		it("should list sessions from index", async () => {
			const bucket = createMockR2Bucket();

			const session1: SessionMetadata = {
				sessionId: "list-test-1" as SessionId,
				sandboxId: "sandbox-1",
				createdAt: Date.now(),
				lastActivity: Date.now() + 1000, // More recent
				status: "active",
				workspacePath: "/workspace/1",
				webUiUrl: "https://test1.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const session2: SessionMetadata = {
				sessionId: "list-test-2" as SessionId,
				sandboxId: "sandbox-2",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace/2",
				webUiUrl: "https://test2.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session1);
				yield* storage.putSession(session2);
				return yield* storage.listSessions();
			});

			const result = await runWithStorage(bucket, program);

			expect(result.sessions.length).toBe(2);
			expect(result.total).toBe(2);

			const sessionIds = result.sessions.map((s) => s.sessionId);
			expect(sessionIds).toContain("list-test-1");
			expect(sessionIds).toContain("list-test-2");

			// Sessions should be sorted by lastActivity (most recent first)
			expect(result.sessions[0].sessionId).toBe("list-test-1");
		});

		it("should return empty list when no sessions exist", async () => {
			const bucket = createMockR2Bucket();

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.listSessions();
			});

			const result = await runWithStorage(bucket, program);

			expect(result.sessions.length).toBe(0);
			expect(result.total).toBe(0);
		});

		it("should return SessionStorageReadError on R2 get failure", async () => {
			const bucket = createMockR2Bucket({ failGet: true });

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				return yield* storage.listSessions();
			});

			const result = await runWithStorageExit(bucket, program);

			expect(Exit.isFailure(result)).toBe(true);
		});

		it("should support pagination with limit and offset", async () => {
			const bucket = createMockR2Bucket();
			const layer = makeSessionStorageLayer(bucket);

			// Create 5 sessions
			for (let i = 0; i < 5; i++) {
				const session: SessionMetadata = {
					sessionId: `page-test-${i}` as SessionId,
					sandboxId: `sandbox-${i}`,
					createdAt: Date.now(),
					lastActivity: Date.now() + i * 1000, // Different activity times
					status: "active",
					workspacePath: `/workspace/${i}`,
					webUiUrl: `https://test${i}.example.com`,
					config: { defaultModel: "claude-sonnet-4-5" },
				};
				await Effect.runPromise(
					Effect.provide(
						Effect.gen(function* () {
							const storage = yield* SessionStorage;
							yield* storage.putSession(session);
						}),
						layer,
					),
				);
			}

			// Get first 2 sessions
			const page1 = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* SessionStorage;
						return yield* storage.listSessions({ limit: 2, offset: 0 });
					}),
					layer,
				),
			);
			expect(page1.sessions.length).toBe(2);
			expect(page1.total).toBe(5);

			// Get next 2 sessions
			const page2 = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* SessionStorage;
						return yield* storage.listSessions({ limit: 2, offset: 2 });
					}),
					layer,
				),
			);
			expect(page2.sessions.length).toBe(2);
			expect(page2.total).toBe(5);

			// Get last session
			const page3 = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* SessionStorage;
						return yield* storage.listSessions({ limit: 2, offset: 4 });
					}),
					layer,
				),
			);
			expect(page3.sessions.length).toBe(1);
			expect(page3.total).toBe(5);
		});
	});

	describe("update flow", () => {
		it("should update existing session", async () => {
			const bucket = createMockR2Bucket();

			const session: SessionMetadata = {
				sessionId: "update-test" as SessionId,
				sandboxId: "sandbox-up",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const program = Effect.gen(function* () {
				const storage = yield* SessionStorage;
				yield* storage.putSession(session);

				// Update the session
				const updated: SessionMetadata = {
					...session,
					status: "stopped",
					lastActivity: Date.now() + 1000,
				};
				yield* storage.putSession(updated);

				return yield* storage.getSession(session.sessionId);
			});

			const result = await runWithStorage(bucket, program);

			expect(Option.isSome(result)).toBe(true);
			if (Option.isSome(result)) {
				expect(result.value.status).toBe("stopped");
			}
		});

		it("should update index when session is updated", async () => {
			const bucket = createMockR2Bucket();
			const layer = makeSessionStorageLayer(bucket);

			const session: SessionMetadata = {
				sessionId: "index-update-test" as SessionId,
				sandboxId: "sandbox-idx-up",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status: "active",
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* SessionStorage;
						yield* storage.putSession(session);
					}),
					layer,
				),
			);

			// Update the session status
			const updated: SessionMetadata = {
				...session,
				status: "stopped",
			};
			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* SessionStorage;
						yield* storage.putSession(updated);
					}),
					layer,
				),
			);

			// Verify index was updated
			const indexJson = bucket._store.get("sessions/_index.json");
			const index = JSON.parse(indexJson!);
			expect(index.sessions["index-update-test"].status).toBe("stopped");
		});
	});
});
