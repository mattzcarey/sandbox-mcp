import { Schema } from "effect";

/**
 * Default AI model for OpenCode sessions
 */
export const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Validation constants for session IDs
 * Session ID: alphanumeric with hyphens, no leading/trailing hyphens
 * Allows: "abc", "a", "abc-123", "my-session-1"
 * Disallows: "-abc", "abc-", "ABC" (uppercase), "ab--cd" (consecutive hyphens)
 */
const SESSION_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SESSION_ID_MAX_LENGTH = 64;
export const GITHUB_URL_PREFIX = "https://github.com/";

/**
 * Valid session status values
 */
const SessionStatus = Schema.Literal(
	"creating",
	"active",
	"idle",
	"stopped",
	"error",
);

/**
 * Session ID must be lowercase alphanumeric with hyphens, max 64 chars
 * Uses Schema.brand() for nominal typing - prevents mixing SessionId with plain strings
 */
export const SessionId = Schema.String.pipe(
	Schema.pattern(SESSION_ID_PATTERN),
	Schema.maxLength(SESSION_ID_MAX_LENGTH),
	Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

/**
 * Repository information for cloned repos (internal to SessionMetadata)
 */
const RepositoryInfo = Schema.Struct({
	url: Schema.String.pipe(
		Schema.startsWith(GITHUB_URL_PREFIX),
		Schema.annotations({ description: "GitHub repository URL" }),
	),
	branch: Schema.String.pipe(
		Schema.annotations({ description: "Git branch name" }),
	),
});

/**
 * Session configuration (internal to SessionMetadata)
 */
const SessionConfig = Schema.Struct({
	defaultModel: Schema.String.pipe(
		Schema.annotations({ description: "Default AI model for OpenCode" }),
	),
});

/**
 * Complete session metadata stored in DO
 */
export const SessionMetadata = Schema.Struct({
	sessionId: SessionId,
	sandboxId: Schema.String,
	createdAt: Schema.Number.pipe(
		Schema.annotations({ description: "Unix timestamp of creation" }),
	),
	lastActivity: Schema.Number.pipe(
		Schema.annotations({ description: "Unix timestamp of last activity" }),
	),
	status: SessionStatus,
	workspacePath: Schema.String,
	webUiUrl: Schema.String,
	repository: Schema.optionalWith(RepositoryInfo, { exact: true }),
	title: Schema.optionalWith(Schema.String, { exact: true }),
	config: SessionConfig,
	// OpenCode session ID for conversation continuation
	opencodeSessionId: Schema.optionalWith(Schema.String, { exact: true }),
	// List of repositories that have been cloned into this sandbox
	clonedRepos: Schema.optionalWith(Schema.Array(Schema.String), {
		exact: true,
	}),
});
export type SessionMetadata = typeof SessionMetadata.Type;
