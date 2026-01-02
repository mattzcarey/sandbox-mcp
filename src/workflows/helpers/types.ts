// src/workflows/helpers/types.ts

/**
 * Parameters for task execution workflow.
 *
 * Uses proxy tokens instead of real credentials for zero-trust security.
 * The proxy validates JWT tokens and injects real credentials.
 */
export interface TaskParams {
	sessionId: string;
	sandboxId: string;
	task: string;
	model: string;
	runId: string;
	/**
	 * Short label for the task (2-5 words).
	 * Passed from MCP tool for initial run record.
	 */
	title: string;
	repositoryUrl?: string;
	branch?: string;
	/**
	 * JWT proxy token for authenticated API calls.
	 * Used for Anthropic, GitHub, and R2 access through the proxy.
	 */
	proxyToken: string;
	/**
	 * Base URL of the proxy (e.g., 'https://sandbox-mcp.workers.dev')
	 */
	proxyBaseUrl: string;
	/**
	 * Existing OpenCode session ID for conversation continuation.
	 * If provided, the workflow will continue the existing session.
	 */
	existingOpencodeSessionId?: string;
}

/**
 * Result of task execution - simplified to unstructured output
 */
export interface TaskResult {
	success: boolean;
	/** Summary text from the AI's response (unstructured) */
	output?: string;
	error?: string;
	/** Title from OpenCode (auto-generated or provided) */
	title?: string;
	/** OpenCode session ID for future continuation */
	opencodeSessionId?: string;
	/** Working directory where the task was executed */
	workspacePath?: string;
	/** Token usage from the LLM */
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
	};
}

/**
 * Dependencies required by workflow helpers.
 *
 * Simplified for zero-trust model - no secrets needed here.
 * All authentication is handled by the proxy using JWT tokens
 * passed in TaskParams.
 */
export interface WorkflowDeps {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sandboxBinding: DurableObjectNamespace<any>;
	sessionsBucket: R2Bucket;
}

/**
 * OpenCode SDK response types
 */
export interface OpenCodeSessionListResponse {
	data?: Array<{ id: string }>;
}

export interface OpenCodeSessionCreateResponse {
	data?: { id: string };
}

export interface OpenCodeSessionGetResponse {
	data?: {
		id: string;
		title?: string;
	};
}

/**
 * Tool state in OpenCode response
 */
interface OpenCodeToolState {
	status: "pending" | "running" | "completed" | "error";
	input?: Record<string, unknown>;
	output?: string;
	title?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Part types in OpenCode response
 */
export interface OpenCodePart {
	type: string;
	text?: string;
	tool?: string;
	state?: OpenCodeToolState;
}

/**
 * Assistant message info
 */
interface OpenCodeAssistantInfo {
	id: string;
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
	};
	cost?: number;
	finish?: string;
	error?: {
		name: string;
		data: { message: string };
	};
}

export interface OpenCodePromptResponse {
	data?: {
		info?: OpenCodeAssistantInfo;
		parts?: OpenCodePart[];
	};
}

/**
 * Result of OpenCode task execution - simplified to unstructured output
 */
export interface OpenCodeTaskResult {
	success: boolean;
	/** Summary text from the AI's response */
	output: string;
	error?: string;
	/** Token usage from the LLM */
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
	};
}
