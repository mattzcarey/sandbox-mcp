import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { RunRecord, RunResult, RunStatus } from "./run";

describe("Run Model", () => {
	describe("RunStatus", () => {
		it("should validate all run status values", () => {
			const statuses = ["started", "running", "completed", "failed"];

			for (const status of statuses) {
				const result = Schema.decodeUnknownEither(RunStatus)(status);
				expect(result._tag).toBe("Right");
			}
		});

		it("should reject invalid status values", () => {
			const invalidStatuses = ["queued", "retrying", "pending"];

			for (const status of invalidStatuses) {
				const result = Schema.decodeUnknownEither(RunStatus)(status);
				expect(result._tag).toBe("Left");
			}
		});
	});

	describe("RunResult", () => {
		it("should parse successful result", () => {
			const input = {
				success: true,
				output: "Created README.md with project documentation",
			};

			const result = Schema.decodeUnknownSync(RunResult)(input);
			expect(result.success).toBe(true);
			expect(result.output).toContain("README.md");
		});

		it("should parse failed result with error", () => {
			const input = {
				success: false,
				output: "Attempted to complete task but failed",
				error: "Timeout after 50 minutes",
			};

			const result = Schema.decodeUnknownSync(RunResult)(input);
			expect(result.success).toBe(false);
			expect(result.error).toContain("Timeout");
		});

		it("should require output field", () => {
			const input = {
				success: true,
				// missing output
			};

			const result = Schema.decodeUnknownEither(RunResult)(input);
			expect(result._tag).toBe("Left");
		});
	});

	describe("RunRecord", () => {
		it("should parse valid run record", () => {
			const input = {
				runId: "run-abc123",
				sessionId: "my-session",
				workflowId: "wf-xyz",
				status: "running",
				task: "Add authentication to the API",
				title: "Add auth",
				model: "claude-sonnet-4-5",
				startedAt: Date.now(),
			};

			const result = Schema.decodeUnknownSync(RunRecord)(input);

			expect(result.runId).toBe("run-abc123");
			expect(result.status).toBe("running");
			expect(result.title).toBe("Add auth");
		});

		it("should parse completed run with result", () => {
			const input = {
				runId: "run-abc123",
				sessionId: "my-session",
				workflowId: "wf-xyz",
				status: "completed",
				task: "Add README",
				title: "Add README",
				model: "claude-sonnet-4-5",
				startedAt: Date.now() - 60000,
				completedAt: Date.now(),
				result: {
					success: true,
					output: "Created README.md with project documentation",
				},
			};

			const result = Schema.decodeUnknownSync(RunRecord)(input);

			expect(result.status).toBe("completed");
			expect(result.result?.success).toBe(true);
			expect(result.result?.output).toContain("README.md");
		});

		it("should parse failed run with error", () => {
			const input = {
				runId: "run-failed",
				sessionId: "my-session",
				workflowId: "wf-xyz",
				status: "failed",
				task: "Do something",
				title: "Failed task",
				model: "claude-sonnet-4-5",
				startedAt: Date.now() - 60000,
				completedAt: Date.now(),
				result: {
					success: false,
					output: "Attempted to complete but failed",
					error: "Timeout after 50 minutes",
				},
			};

			const result = Schema.decodeUnknownSync(RunRecord)(input);

			expect(result.status).toBe("failed");
			expect(result.result?.success).toBe(false);
			expect(result.result?.error).toContain("Timeout");
		});

		it("should require title field", () => {
			const input = {
				runId: "run-test",
				sessionId: "session",
				workflowId: "wf-test",
				status: "started",
				task: "Test task",
				// missing title
				model: "claude-sonnet-4-5",
				startedAt: Date.now(),
			};

			const result = Schema.decodeUnknownEither(RunRecord)(input);
			expect(result._tag).toBe("Left");
		});
	});
});
