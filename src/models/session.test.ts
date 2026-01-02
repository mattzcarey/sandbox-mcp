import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { SessionMetadata } from "./session";

describe("Session Model", () => {
	it("should parse valid session metadata", () => {
		const input = {
			sessionId: "my-session-123",
			sandboxId: "my-session-123",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: "active",
			workspacePath: "/workspace",
			webUiUrl: "https://my-session-123.sandbox.example.com",
			config: {
				defaultModel: "claude-sonnet-4-5",
			},
		};

		const result = Schema.decodeUnknownSync(SessionMetadata)(input);

		expect(result.sessionId).toBe("my-session-123");
		expect(result.status).toBe("active");
	});

	it("should reject invalid session ID format", () => {
		const input = {
			sessionId: "INVALID_ID!", // uppercase and special chars
			sandboxId: "test",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: "active",
			workspacePath: "/workspace",
			webUiUrl: "https://test.example.com",
			config: { defaultModel: "claude-sonnet-4-5" },
		};

		expect(() => Schema.decodeUnknownSync(SessionMetadata)(input)).toThrow();
	});

	it("should accept optional repository field", () => {
		const input = {
			sessionId: "test",
			sandboxId: "test",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: "active",
			workspacePath: "/workspace",
			webUiUrl: "https://test.example.com",
			repository: {
				url: "https://github.com/user/repo",
				branch: "main",
			},
			config: { defaultModel: "claude-sonnet-4-5" },
		};

		const result = Schema.decodeUnknownSync(SessionMetadata)(input);

		expect(result.repository?.url).toBe("https://github.com/user/repo");
	});

	it("should validate all session status values", () => {
		const statuses = ["creating", "active", "idle", "stopped", "error"];

		for (const status of statuses) {
			const input = {
				sessionId: "test",
				sandboxId: "test",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				status,
				workspacePath: "/workspace",
				webUiUrl: "https://test.example.com",
				config: { defaultModel: "claude-sonnet-4-5" },
			};

			const result = Schema.decodeUnknownSync(SessionMetadata)(input);
			expect(result.status).toBe(status);
		}
	});
});
