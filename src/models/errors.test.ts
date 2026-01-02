import { describe, expect, it } from "vitest";

import {
	isRunStorageError,
	isSessionError,
	isSessionStorageError,
	RunNotFoundError,
	RunStorageReadError,
	SessionNotFoundError,
	SessionStorageReadError,
} from "./errors";

describe("Error Models", () => {
	describe("Session Errors", () => {
		it("should create SessionNotFoundError with correct message", () => {
			const error = new SessionNotFoundError({ sessionId: "test-123" });

			expect(error._tag).toBe("SessionNotFoundError");
			expect(error.sessionId).toBe("test-123");
			expect(error.message).toContain("test-123");
		});

		it("should create RunNotFoundError with correct message", () => {
			const error = new RunNotFoundError({ runId: "run-456" });

			expect(error._tag).toBe("RunNotFoundError");
			expect(error.runId).toBe("run-456");
			expect(error.message).toContain("run-456");
		});

		it("should identify session errors with type guard", () => {
			const sessionError = new SessionNotFoundError({ sessionId: "test" });
			const runError = new RunNotFoundError({ runId: "run" });

			expect(isSessionError(sessionError)).toBe(true);
			expect(isSessionError(runError)).toBe(true);
			expect(isSessionError(new Error("random"))).toBe(false);
		});
	});

	describe("Session Storage Errors", () => {
		it("should create SessionStorageReadError with correct message", () => {
			const error = new SessionStorageReadError({
				sessionId: "session-123",
				cause: "R2 get failed",
			});

			expect(error._tag).toBe("SessionStorageReadError");
			expect(error.sessionId).toBe("session-123");
			expect(error.message).toContain("session-123");
			expect(error.message).toContain("R2 get failed");
		});

		it("should identify session storage errors with type guard", () => {
			const error = new SessionStorageReadError({
				sessionId: "test",
				cause: "test",
			});

			expect(isSessionStorageError(error)).toBe(true);
			expect(isSessionStorageError(new Error("random"))).toBe(false);
		});
	});

	describe("Run Storage Errors", () => {
		it("should create RunStorageReadError with runId", () => {
			const error = new RunStorageReadError({
				runId: "run-456",
				cause: "R2 get failed",
			});

			expect(error._tag).toBe("RunStorageReadError");
			expect(error.runId).toBe("run-456");
			expect(error.message).toContain("run-456");
		});

		it("should create RunStorageReadError without runId", () => {
			const error = new RunStorageReadError({
				cause: "R2 get failed",
			});

			expect(error._tag).toBe("RunStorageReadError");
			expect(error.runId).toBeUndefined();
			expect(error.message).toContain("Failed to read runs");
		});

		it("should identify run storage errors with type guard", () => {
			const error = new RunStorageReadError({
				cause: "test",
			});

			expect(isRunStorageError(error)).toBe(true);
			expect(isRunStorageError(new Error("random"))).toBe(false);
		});
	});
});
