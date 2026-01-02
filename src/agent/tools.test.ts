// src/agent/tools.test.ts
import { describe, expect, it } from "vitest";

import {
	formatToolResponse,
	getResultInputSchema,
	listRunsInputSchema,
	runTaskInputSchema,
} from "./tools";

describe("MCP Tool Schemas", () => {
	describe("runTaskInputSchema", () => {
		it("should validate run task with repository (new session)", () => {
			const valid = {
				repository: "https://github.com/user/repo",
				task: "Add authentication to the API",
			};

			const result = runTaskInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should validate run task with sessionId (continuation)", () => {
			const valid = {
				sessionId: "sess-abc123",
				task: "Continue working on authentication",
			};

			const result = runTaskInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should validate run task with all optional fields", () => {
			const valid = {
				sessionId: "sess-abc123",
				repository: "https://github.com/user/repo",
				task: "Add JWT auth",
				branch: "feature/auth",
				model: "claude-sonnet-4-5",
				title: "JWT auth",
			};

			const result = runTaskInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should reject invalid repository URL", () => {
			const invalid = {
				repository: "https://gitlab.com/user/repo",
				task: "Some task",
			};

			const result = runTaskInputSchema.safeParse(invalid);
			expect(result.success).toBe(false);
		});

		it("should require task field", () => {
			const invalid = {
				sessionId: "sess-abc123",
			};

			const result = runTaskInputSchema.safeParse(invalid);
			expect(result.success).toBe(false);
		});
	});

	describe("getResultInputSchema", () => {
		it("should validate get result input with runId only", () => {
			const valid = {
				runId: "run-abc123",
			};

			const result = getResultInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should require runId", () => {
			const invalid = {};

			const result = getResultInputSchema.safeParse(invalid);
			expect(result.success).toBe(false);
		});
	});

	describe("listRunsInputSchema", () => {
		it("should validate list runs with no filters (list all)", () => {
			const valid = {};

			const result = listRunsInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should validate list runs with optional sessionId filter", () => {
			const valid = {
				sessionId: "sess-abc123",
			};

			const result = listRunsInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should validate list runs with optional status filter", () => {
			const valid = {
				status: "completed",
			};

			const result = listRunsInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should validate list runs with all filters", () => {
			const valid = {
				sessionId: "sess-abc123",
				status: "failed",
				limit: 20,
				before: 1703260800000,
			};

			const result = listRunsInputSchema.safeParse(valid);
			expect(result.success).toBe(true);
		});

		it("should reject invalid status values", () => {
			const invalid = {
				status: "invalid-status",
			};

			const result = listRunsInputSchema.safeParse(invalid);
			expect(result.success).toBe(false);
		});

		it("should enforce limit bounds", () => {
			expect(listRunsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
			expect(listRunsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
			expect(listRunsInputSchema.safeParse({ limit: 50 }).success).toBe(true);
		});
	});

	describe("formatToolResponse", () => {
		it("should format tool response correctly", () => {
			const data = { runId: "test", status: "started" };
			const response = formatToolResponse(data);

			expect(response.content).toHaveLength(1);
			expect(response.content[0].type).toBe("text");
			expect(JSON.parse(response.content[0].text)).toEqual(data);
		});
	});
});
