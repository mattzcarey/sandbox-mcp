// src/workflows/helpers/opencode.ts
import type { Sandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";

import { toContainerUrl } from "../../proxy";
import type {
	OpenCodePart,
	OpenCodePromptResponse,
	OpenCodeSessionCreateResponse,
	OpenCodeSessionGetResponse,
	OpenCodeSessionListResponse,
	OpenCodeTaskResult,
	TaskParams,
} from "./types";

/**
 * Extract text output from OpenCode response parts.
 * We now use unstructured output - the AI's natural language response.
 */
function extractTextOutput(parts: OpenCodePart[]): string {
	const textParts: string[] = [];

	for (const part of parts) {
		if (part.type === "text" && part.text) {
			textParts.push(part.text);
		}
	}

	return textParts.join("\n\n");
}

/**
 * Enhance task description with output instructions.
 * This ensures the AI provides useful information in its response.
 */
function enhanceTask(task: string): string {
	return `${task}

When you're done, please summarize:
- What you accomplished
- Files created, modified, or deleted
- Any commits made (with commit hashes and which repos)
- Any issues or warnings`;
}

/**
 * Build OpenCode config that uses the proxy for API calls.
 *
 * The JWT token is passed as the API key, and the baseURL points to our proxy.
 * The proxy validates the JWT and injects the real ANTHROPIC_API_KEY.
 */
function buildProxyConfig(proxyBaseUrl: string, proxyToken: string): Config {
	const containerProxyUrl = toContainerUrl(proxyBaseUrl);
	return {
		provider: {
			anthropic: {
				options: {
					apiKey: proxyToken,
					baseURL: `${containerProxyUrl}/proxy/anthropic`,
				},
			},
		},
	};
}

/**
 * Result of executeTask including the OpenCode session ID for continuation
 */
interface ExecuteTaskResult {
	result: OpenCodeTaskResult;
	opencodeSessionId: string;
}

/**
 * Execute an OpenCode task inside the sandbox.
 *
 * Starts OpenCode server with proxy configuration, creates/gets session,
 * and executes the task. All API calls go through the proxy.
 *
 * @param sandbox - The sandbox instance
 * @param params - Task parameters (including optional existingOpencodeSessionId)
 * @param workingDirectory - The directory to run OpenCode in (e.g., /workspace/repo)
 * @returns The task result and OpenCode session ID for continuation
 */
export async function executeTask(
	sandbox: Sandbox<unknown>,
	params: TaskParams,
	workingDirectory: string,
): Promise<ExecuteTaskResult> {
	// Build proxy-based config
	const config = buildProxyConfig(params.proxyBaseUrl, params.proxyToken);

	// Start OpenCode server in the sandbox and get SDK client
	const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
		port: 4096,
		directory: workingDirectory,
		config,
	});

	try {
		let opencodeSessionId: string;

		// Check if we should continue an existing OpenCode session
		if (params.existingOpencodeSessionId) {
			// Use the existing session for continuation
			opencodeSessionId = params.existingOpencodeSessionId;
		} else {
			// Try to list existing sessions with proper directory context
			const existingSessions = (await client.session.list({
				query: { directory: workingDirectory },
			})) as OpenCodeSessionListResponse;

			if (existingSessions.data && existingSessions.data.length > 0) {
				// Use the first existing session
				opencodeSessionId = existingSessions.data[0].id;
			} else {
				// Create a new session with directory context (no title - let OpenCode auto-generate)
				const created = (await client.session.create({
					query: { directory: workingDirectory },
				})) as OpenCodeSessionCreateResponse;

				if (!created.data?.id) {
					throw new Error("Failed to create OpenCode session: no ID returned");
				}
				opencodeSessionId = created.data.id;
			}
		}

		// Execute the task with enhanced prompt for better output
		const enhancedTask = enhanceTask(params.task);

		const response = (await client.session.prompt({
			path: { id: opencodeSessionId },
			query: { directory: workingDirectory },
			body: {
				model: {
					providerID: "anthropic",
					modelID: params.model,
				},
				parts: [
					{
						type: "text",
						text: enhancedTask,
					},
				],
			},
		})) as OpenCodePromptResponse;

		// Extract text output from response
		const output = extractTextOutput(response?.data?.parts ?? []);

		// Check for errors in the response
		if (response?.data?.info?.error) {
			return {
				result: {
					success: false,
					output,
					error: response.data.info.error.data.message,
					tokens: response.data.info.tokens,
				},
				opencodeSessionId,
			};
		}

		return {
			result: {
				success: true,
				output,
				tokens: response?.data?.info?.tokens,
			},
			opencodeSessionId,
		};
	} catch (error) {
		// Return a failed result but still need to return some session ID
		// In case of error, we may not have a valid session ID
		return {
			result: {
				success: false,
				output: "",
				error: error instanceof Error ? error.message : String(error),
			},
			opencodeSessionId: params.existingOpencodeSessionId ?? "unknown",
		};
	} finally {
		// Always close the server
		await server.close();
	}
}

/**
 * Get the title of an OpenCode session.
 * OpenCode auto-generates titles based on the conversation.
 *
 * @param sandbox - The sandbox instance
 * @param opencodeSessionId - The OpenCode session ID
 * @param proxyBaseUrl - Base URL of the proxy
 * @param proxyToken - JWT proxy token
 * @param workingDirectory - The directory to run OpenCode in
 * @returns The session title or "Untitled" if not available
 */
export async function getSessionTitle(
	sandbox: Sandbox<unknown>,
	opencodeSessionId: string,
	proxyBaseUrl: string,
	proxyToken: string,
	workingDirectory: string,
): Promise<string> {
	const config = buildProxyConfig(proxyBaseUrl, proxyToken);

	const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
		port: 4096,
		directory: workingDirectory,
		config,
	});

	try {
		const session = (await client.session.get({
			path: { id: opencodeSessionId },
		})) as OpenCodeSessionGetResponse;

		return session.data?.title ?? "Untitled";
	} catch {
		return "Untitled";
	} finally {
		await server.close();
	}
}
