// src/agent/tools.ts
import { z } from "zod";

import { TASK_MAX_LENGTH } from "../models/run";
import { DEFAULT_MODEL, GITHUB_URL_PREFIX } from "../models/session";

/**
 * MCP tool schemas using Zod (required by MCP SDK)
 *
 * Note: We use Zod here because the MCP SDK's server.tool() method
 * only accepts Zod schemas (ZodRawShapeCompat). The canonical domain
 * models use Effect Schema in ../models/ for consistency with Effect
 * patterns. Shared validation constants are exported from the models
 * to keep the rules in sync.
 */

/**
 * Schema for opencode_run_task tool input
 * This is the main tool - it creates sessions automatically if needed
 */
export const runTaskInputSchema = z.object({
	sessionId: z
		.string()
		.optional()
		.describe("Continue existing session. Creates new session if omitted."),

	repository: z
		.string()
		.refine((url) => url.startsWith(GITHUB_URL_PREFIX), {
			message: "Must be a GitHub URL starting with https://github.com/",
		})
		.optional()
		.describe("GitHub repository URL to clone."),

	task: z
		.string()
		.max(TASK_MAX_LENGTH)
		.describe("Natural language task description."),

	branch: z
		.string()
		.optional()
		.describe("Git branch to checkout. Defaults to 'main'."),

	model: z
		.string()
		.optional()
		.describe(`AI model to use. Defaults to ${DEFAULT_MODEL}.`),

	title: z
		.string()
		.max(100)
		.optional()
		.describe(
			"Short label for this task (2-5 words). Auto-generated if omitted.",
		),
});
export type RunTaskInput = z.infer<typeof runTaskInputSchema>;

/**
 * Schema for opencode_get_result tool input
 * Only requires runId - runs are stored in a flat global index
 */
export const getResultInputSchema = z.object({
	runId: z.string().describe("Run ID from opencode_run_task."),
});
export type GetResultInput = z.infer<typeof getResultInputSchema>;

/**
 * Schema for opencode_list_runs tool input
 * Lists runs with optional filters - sessionId no longer required
 */
export const listRunsInputSchema = z.object({
	sessionId: z.string().optional().describe("Filter by session ID."),

	status: z
		.enum(["started", "running", "completed", "failed"])
		.optional()
		.describe("Filter by status."),

	limit: z
		.number()
		.int()
		.min(1)

		.max(100)
		.default(10)
		.describe("Max runs to return. Default 10."),

	before: z
		.number()
		.optional()
		.describe("Unix timestamp cursor. Returns runs started before this time."),
});
export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

/**
 * MCP tool response type - uses index signature for SDK compatibility
 */
interface ToolResponse {
	[key: string]: unknown;
	content: Array<{
		type: "text";
		text: string;
	}>;
}

/**
 * Format data as MCP tool response
 */
export const formatToolResponse = (data: unknown): ToolResponse => ({
	content: [
		{
			type: "text",
			text: JSON.stringify(data, null, 2),
		},
	],
});

/**
 * Format error as MCP tool response
 */
export const formatErrorResponse = (error: {
	code: string;
	message: string;
	details?: unknown;
}): ToolResponse => {
	const errorObj: Record<string, unknown> = {
		code: error.code,
		message: error.message,
	};
	if (error.details !== undefined) {
		errorObj.details = error.details;
	}
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ error: errorObj }, null, 2),
			},
		],
	};
};
