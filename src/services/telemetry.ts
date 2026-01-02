// src/services/telemetry.ts
/**
 * Wide Event / Canonical Log Line implementation
 *
 * Inspired by https://loggingsucks.com/ - instead of scattered log lines,
 * we emit ONE comprehensive event per request with all context.
 *
 * This module provides event builders for MCP tool calls and workflow
 * execution. Callers use console.log(JSON.stringify(event)) to emit.
 */

/**
 * Wide event structure for MCP tool calls
 */
interface ToolCallEvent {
	// Identifiers
	timestamp: string;
	requestId: string;
	tool: string;

	// Service info
	service: "sandbox-mcp";
	version: string;

	// Timing
	durationMs?: number;
	phases?: Record<string, number>; // phase name -> duration in ms

	// Outcome
	outcome: "success" | "error";

	// Error details (if outcome === "error")
	error?: {
		type: string;
		code: string;
		message: string;
		retriable: boolean;
	};

	// Additional context
	metadata?: Record<string, unknown>;
}

/**
 * Wide event structure for workflow execution
 */
export interface WorkflowEvent {
	// Identifiers
	timestamp: string;
	workflowId: string;
	runId: string;
	sessionId: string;

	// Service info
	service: "sandbox-mcp";
	version: string;

	// Timing
	durationMs?: number;

	// Outcome
	outcome: "success" | "error" | "timeout";

	// Error details
	error?: {
		type: string;
		code: string;
		message: string;
		phase: string;
		retriable: boolean;
	};

	// Additional context
	metadata?: Record<string, unknown>;
}

/**
 * Mutable event builder - accumulates context throughout request lifecycle
 */
export class ToolCallEventBuilder {
	private event: ToolCallEvent;
	private startTime: number;
	private phaseTimers: Map<string, number> = new Map();

	constructor(tool: string, requestId: string) {
		this.startTime = Date.now();
		this.event = {
			tool,
			requestId,
			timestamp: new Date().toISOString(),
			service: "sandbox-mcp",
			version: "1.0.0",
			outcome: "success",
		};
	}

	setOutcome(outcome: "success" | "error"): this {
		this.event.outcome = outcome;
		return this;
	}

	setError(error: ToolCallEvent["error"]): this {
		this.event.error = error;
		this.event.outcome = "error";
		return this;
	}

	setMetadata(metadata: Record<string, unknown>): this {
		this.event.metadata = { ...this.event.metadata, ...metadata };
		return this;
	}

	startPhase(name: string): this {
		this.phaseTimers.set(name, Date.now());
		return this;
	}

	endPhase(name: string): this {
		const start = this.phaseTimers.get(name);
		if (start) {
			const duration = Date.now() - start;
			this.event.phases = { ...this.event.phases, [name]: duration };
			this.phaseTimers.delete(name);
		}
		return this;
	}

	finalize(): ToolCallEvent {
		this.event.durationMs = Date.now() - this.startTime;
		return this.event;
	}
}

/**
 * Workflow event builder
 */
export class WorkflowEventBuilder {
	private event: WorkflowEvent;
	private startTime: number;

	constructor(workflowId: string, runId: string, sessionId: string) {
		this.startTime = Date.now();
		this.event = {
			workflowId,
			runId,
			sessionId,
			timestamp: new Date().toISOString(),
			service: "sandbox-mcp",
			version: "1.0.0",
			outcome: "success",
		};
	}

	setOutcome(outcome: "success" | "error" | "timeout"): this {
		this.event.outcome = outcome;
		return this;
	}

	setError(error: WorkflowEvent["error"]): this {
		this.event.error = error;
		this.event.outcome = "error";
		return this;
	}

	setMetadata(metadata: Record<string, unknown>): this {
		this.event.metadata = { ...this.event.metadata, ...metadata };
		return this;
	}

	finalize(): WorkflowEvent {
		this.event.durationMs = Date.now() - this.startTime;
		return this.event;
	}
}
