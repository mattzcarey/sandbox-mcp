// src/agent/mcp-agent.ts
import type { Connection, ConnectionContext } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	isRunStorageError,
	isSessionError,
	isSessionStorageError,
	RunNotFoundError,
	SessionNotFoundError,
} from "../models/errors";
import {
	DEFAULT_MODEL,
	SessionId,
	type SessionMetadata,
} from "../models/session";
import { createProxyToken } from "../proxy";
import { makeRunStorageLayer, RunStorage } from "../services/run";
import { makeSessionStorageLayer, SessionStorage } from "../services/session";
import { ToolCallEventBuilder } from "../services/telemetry";
import {
	formatErrorResponse,
	formatToolResponse,
	getResultInputSchema,
	listRunsInputSchema,
	runTaskInputSchema,
	type GetResultInput,
	type ListRunsInput,
	type RunTaskInput,
} from "./tools";

/**
 * State managed by the MCP Agent
 */
interface AgentState {
	initialized: boolean;
}

/**
 * Error thrown when runtime is not initialized
 */
class RuntimeNotInitializedError extends Error {
	constructor() {
		super("MCP Agent runtime not initialized. Call init() first.");
		this.name = "RuntimeNotInitializedError";
	}
}

/**
 * Combined service type for the MCP Agent runtime
 * - SessionStorage: R2 for sessions (persistent, cross-DO)
 * - RunStorage: R2 for runs (persistent, cross-DO)
 */
type AgentServices = SessionStorage | RunStorage;

/**
 * Get the runtime, throwing if not initialized
 */
function getRuntime(
	runtime: ManagedRuntime.ManagedRuntime<AgentServices, never> | null,
): ManagedRuntime.ManagedRuntime<AgentServices, never> {
	if (runtime === null) {
		throw new RuntimeNotInitializedError();
	}
	return runtime;
}

/**
 * Format error for MCP response, preserving domain error information
 */
function formatDomainError(
	error: unknown,
): ReturnType<typeof formatErrorResponse> {
	// Check for domain-specific errors and use their tags
	if (isSessionError(error)) {
		return formatErrorResponse({
			code: error._tag,
			message: error.message,
		});
	}
	if (isSessionStorageError(error)) {
		return formatErrorResponse({
			code: error._tag,
			message: error.message,
		});
	}
	if (isRunStorageError(error)) {
		return formatErrorResponse({
			code: error._tag,
			message: error.message,
		});
	}

	// Fallback for unknown errors
	return formatErrorResponse({
		code: "UNKNOWN_ERROR",
		message: error instanceof Error ? error.message : String(error),
	});
}

/**
 * OpenCode MCP Agent - Durable Object that handles MCP protocol
 *
 * Storage architecture:
 * - Sessions: Stored in R2 (shared across all DO instances)
 * - Runs: Stored in R2 (shared across all DO instances)
 *
 * Both sessions and runs are stored in R2 so they can be accessed from any
 * DO instance, solving the cross-DO access problem inherent in the MCP
 * library's per-connection DO model.
 */
export class OpenCodeMcpAgent extends McpAgent<Env, AgentState> {
	server = new McpServer({
		name: "opencode-sandbox",
		version: "1.0.0",
	});

	/** @public Required by McpAgent base class */
	initialState: AgentState = {
		initialized: false,
	};

	private runtime: ManagedRuntime.ManagedRuntime<AgentServices, never> | null =
		null;

	/**
	 * Get the R2 bucket for storage
	 */
	private get sessionsBucket(): R2Bucket {
		return this.env.SESSIONS_BUCKET;
	}

	/**
	 * Initialize the MCP server with tools
	 * @public Called by McpAgent framework on DO start
	 */
	async init(): Promise<void> {
		// Create combined layer with both R2 storage services
		const sessionLayer = makeSessionStorageLayer(this.sessionsBucket);
		const runLayer = makeRunStorageLayer(this.sessionsBucket);
		const combinedLayer = Layer.merge(sessionLayer, runLayer);
		this.runtime = ManagedRuntime.make(combinedLayer);

		// Register MCP tools
		this.registerRunTaskTool();
		this.registerGetResultTool();
		this.registerListRunsTool();

		this.setState({ initialized: true });
	}

	/**
	 * Emit telemetry for a tool call
	 */
	private emitToolTelemetry(
		builder: ToolCallEventBuilder,
		success: boolean,
	): void {
		if (success) {
			builder.setOutcome("success");
		}
		const event = builder.finalize();
		console.log(
			JSON.stringify({
				level: success ? "info" : "error",
				type: "tool.call",
				...event,
			}),
		);
	}

	/** Cached base URL, set during onConnect */
	private baseUrl: string | null = null;

	/**
	 * Called when a client connects. We capture the base URL from the request
	 * so we can use it later in tool handlers (which don't have request context).
	 */
	override async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		// Extract and cache the base URL from the connection request
		const url = new URL(ctx.request.url);
		this.baseUrl = `${url.protocol}//${url.host}`;

		// Call parent implementation
		return super.onConnect(connection, ctx);
	}

	/**
	 * Get the base URL for this worker.
	 * Uses the URL captured during onConnect.
	 */
	private getBaseUrl(): string {
		if (!this.baseUrl) {
			throw new Error(
				"Base URL not available - onConnect must be called first",
			);
		}
		return this.baseUrl;
	}

	/**
	 * Build the absolute web UI URL for a session.
	 */
	private getWebUiUrl(sessionId: string): string {
		return `${this.getBaseUrl()}/session/${sessionId}/`;
	}

	/**
	 * Tool: opencode_run_task
	 * Execute a coding task. Creates session if needed, or continues existing session.
	 *
	 * Note: This tool only creates the session and workflow. The workflow itself
	 * creates the run record in R2 (in the "create-run" step).
	 */
	private registerRunTaskTool(): void {
		this.server.registerTool(
			"opencode_run_task",
			{
				description:
					"Execute a coding task in a sandbox. Creates session if needed, or continues existing session.",
				inputSchema: runTaskInputSchema,
			},
			async (params: RunTaskInput) => {
				const telemetry = new ToolCallEventBuilder(
					"opencode_run_task",
					params.sessionId ?? "new",
				);
				telemetry.startPhase("validate");

				try {
					const rt = getRuntime(this.runtime);
					let session: SessionMetadata;
					let isNewSession = false;

					// 1. Resolve or create session (from R2)
					if (params.sessionId) {
						// Continue existing session
						telemetry.endPhase("validate");
						telemetry.startPhase("storage");

						const existing = await rt.runPromise(
							Effect.gen(function* () {
								const sessionStorage = yield* SessionStorage;
								return yield* sessionStorage.getSession(
									params.sessionId as string,
								);
							}),
						);

						if (existing._tag === "None") {
							const error = new SessionNotFoundError({
								sessionId: params.sessionId,
							});
							telemetry.setError({
								type: error._tag,
								code: error._tag,
								message: error.message,
								retriable: false,
							});
							this.emitToolTelemetry(telemetry, false);
							return formatDomainError(error);
						}
						session = existing.value;
					} else {
						// Create new session
						isNewSession = true;
						// Generate a short session ID from UUID (8 hex chars, always lowercase alphanumeric)
						const rawSessionId = crypto.randomUUID().slice(0, 8);
						// Validate through Schema to get properly branded type
						const sessionId = Schema.decodeSync(SessionId)(rawSessionId);

						session = {
							sessionId,
							sandboxId: sessionId,
							createdAt: Date.now(),
							lastActivity: Date.now(),
							status: "active",
							workspacePath: "/workspace",
							webUiUrl: this.getWebUiUrl(sessionId),
							repository: params.repository
								? {
										url: params.repository,
										branch: params.branch ?? "main",
									}
								: undefined,
							clonedRepos: params.repository ? [params.repository] : [],
							config: {
								defaultModel: DEFAULT_MODEL,
							},
						};

						telemetry.endPhase("validate");
						telemetry.startPhase("storage");

						// Save new session to R2
						await rt.runPromise(
							Effect.gen(function* () {
								const sessionStorage = yield* SessionStorage;
								yield* sessionStorage.putSession(session);
							}),
						);
					}

					// 2. Check if additional repo needs cloning
					const needsClone =
						params.repository &&
						!session.clonedRepos?.includes(params.repository);

					// Update clonedRepos if we're adding a new repo
					if (needsClone && params.repository) {
						session = {
							...session,
							clonedRepos: [...(session.clonedRepos ?? []), params.repository],
						};
					}

					telemetry.endPhase("storage");
					telemetry.startPhase("token");

					// 3. Generate run ID and create proxy token
					const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
					const model = params.model ?? session.config.defaultModel;

					// Create proxy token for zero-trust authentication
					const proxyToken = await rt.runPromise(
						createProxyToken({
							secret: this.env.PROXY_JWT_SECRET,
							sandboxId: session.sandboxId,
							sessionId: session.sessionId,
							expiresIn: "2h",
						}),
					);

					telemetry.endPhase("token");
					telemetry.startPhase("workflow");

					// 4. Create workflow to execute task
					// Note: The workflow creates the run record in R2 (not us)
					const workflowInstance = await this.env.EXECUTE_TASK_WORKFLOW.create({
						id: runId,
						params: {
							sessionId: session.sessionId,
							sandboxId: session.sandboxId,
							task: params.task,
							model,
							runId,
							title: params.title ?? "Processing...",
							repositoryUrl: needsClone
								? params.repository
								: session.repository?.url,
							branch: params.branch ?? session.repository?.branch,
							existingOpencodeSessionId: session.opencodeSessionId,
							proxyToken,
							proxyBaseUrl: this.getBaseUrl(),
						},
					});

					telemetry.endPhase("workflow");
					telemetry.startPhase("storage");

					// 5. Update session last activity in R2
					const updatedSession = {
						...session,
						lastActivity: Date.now(),
						status: "active" as const,
					};
					await rt.runPromise(
						Effect.gen(function* () {
							const sessionStorage = yield* SessionStorage;
							yield* sessionStorage.putSession(updatedSession);
						}),
					);

					telemetry.endPhase("storage");
					telemetry.setMetadata({
						runId,
						workflowId: workflowInstance.id,
						isNewSession,
						needsClone,
					});
					this.emitToolTelemetry(telemetry, true);

					return formatToolResponse({
						runId,
						sessionId: session.sessionId,
						status: "started",
						webUiUrl: session.webUiUrl,
					});
				} catch (error) {
					const errorName =
						error instanceof Error ? error.name : "UnknownError";
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					telemetry.setError({
						type: errorName,
						code: errorName,
						message: errorMessage,
						retriable: false,
					});
					this.emitToolTelemetry(telemetry, false);
					return formatDomainError(error);
				}
			},
		);
	}

	/**
	 * Tool: opencode_get_result
	 * Get the status and result of a specific task run.
	 */
	private registerGetResultTool(): void {
		this.server.registerTool(
			"opencode_get_result",
			{
				description: "Get the status and result of a specific task run.",
				inputSchema: getResultInputSchema,
			},
			async (params: GetResultInput) => {
				const telemetry = new ToolCallEventBuilder(
					"opencode_get_result",
					params.runId,
				);
				telemetry.startPhase("storage");

				try {
					const rt = getRuntime(this.runtime);

					// Get run from R2 (no sessionId needed - flat global index)
					const run = await rt.runPromise(
						Effect.gen(function* () {
							const runStorage = yield* RunStorage;
							return yield* runStorage.getRun(params.runId);
						}),
					);

					if (run._tag === "None") {
						const error = new RunNotFoundError({ runId: params.runId });
						telemetry.setError({
							type: error._tag,
							code: error._tag,
							message: error.message,
							retriable: false,
						});
						this.emitToolTelemetry(telemetry, false);
						return formatDomainError(error);
					}

					// Get session for webUiUrl from R2 (using sessionId from the run)
					const session = await rt.runPromise(
						Effect.gen(function* () {
							const sessionStorage = yield* SessionStorage;
							return yield* sessionStorage.getSession(run.value.sessionId);
						}),
					);

					telemetry.endPhase("storage");
					this.emitToolTelemetry(telemetry, true);

					return formatToolResponse({
						runId: run.value.runId,
						sessionId: run.value.sessionId,
						status: run.value.status,
						task: run.value.task,
						title: run.value.title,
						startedAt: run.value.startedAt,
						completedAt: run.value.completedAt,
						result: run.value.result,
						webUiUrl:
							session._tag === "Some" ? session.value.webUiUrl : undefined,
					});
				} catch (error) {
					const errorName =
						error instanceof Error ? error.name : "UnknownError";
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					telemetry.setError({
						type: errorName,
						code: errorName,
						message: errorMessage,
						retriable: false,
					});
					this.emitToolTelemetry(telemetry, false);
					return formatDomainError(error);
				}
			},
		);
	}

	/**
	 * Tool: opencode_list_runs
	 * List past task runs with optional filters.
	 */
	private registerListRunsTool(): void {
		this.server.registerTool(
			"opencode_list_runs",
			{
				description:
					"List past task runs. Filter by session, status, or time. Use to discover old work or see history.",
				inputSchema: listRunsInputSchema,
			},
			async (params: ListRunsInput) => {
				const telemetry = new ToolCallEventBuilder(
					"opencode_list_runs",
					params.sessionId ?? "all",
				);
				telemetry.startPhase("storage");

				try {
					const rt = getRuntime(this.runtime);
					const limit = params.limit ?? 10;

					// Get runs from R2 with optional filters
					const result = await rt.runPromise(
						Effect.gen(function* () {
							const runStorage = yield* RunStorage;
							return yield* runStorage.listRuns({
								sessionId: params.sessionId,
								status: params.status,
								before: params.before,
								limit: limit + 1, // Fetch one extra to check hasMore
							});
						}),
					);

					const hasMore = result.runs.length > limit;
					const returnRuns = hasMore
						? result.runs.slice(0, limit)
						: result.runs;

					telemetry.endPhase("storage");
					telemetry.setMetadata({ runsCount: returnRuns.length, hasMore });
					this.emitToolTelemetry(telemetry, true);

					return formatToolResponse({
						runs: returnRuns.map((r) => ({
							runId: r.runId,
							sessionId: r.sessionId, // Now from the run entry itself
							status: r.status,
							title: r.title,
							startedAt: r.startedAt,
							completedAt: r.completedAt,
						})),
						hasMore,
					});
				} catch (error) {
					const errorName =
						error instanceof Error ? error.name : "UnknownError";
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					telemetry.setError({
						type: errorName,
						code: errorName,
						message: errorMessage,
						retriable: false,
					});
					this.emitToolTelemetry(telemetry, false);
					return formatDomainError(error);
				}
			},
		);
	}
}
