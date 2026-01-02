// src/workflows/helpers/sandbox.ts
import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";

import {
	configureAnthropic,
	configureGithub,
	toContainerUrl,
} from "../../proxy";
import { restoreSession } from "./backup";
import type { WorkflowDeps } from "./types";

/**
 * Parameters for ensuring sandbox is ready for use.
 */
interface SandboxReadyParams {
	sandbox: Sandbox<unknown>;
	sessionId: string;
	bucket: R2Bucket;
	proxyBaseUrl: string;
	proxyToken: string;
	repository?: {
		url: string;
		branch?: string;
	};
}

/**
 * Result of ensuring sandbox is ready.
 */
interface SandboxReadyResult {
	/** Working directory path ("/workspace" or "/workspace/{repo}") */
	workspacePath: string;
	/** Whether OpenCode state was restored from backup */
	restoredBackup: boolean;
	/** Whether repository was cloned */
	clonedRepo: boolean;
	/** Whether proxy was configured */
	configuredProxy: boolean;
}

/**
 * Ensure sandbox is ready for use - idempotent initialization.
 *
 * This is the main entry point for sandbox initialization. It checks the
 * current state and only performs actions that are needed:
 *
 * 1. Configures proxy if environment is not set up (MUST be first for git auth)
 * 2. Restores OpenCode backup if storage directory is missing
 * 3. Clones repository if .git directory is missing
 *
 * Safe to call multiple times - each step checks before acting.
 * Used by both workflow (execute-task.ts) and web UI (index.ts).
 */
export async function ensureSandboxReady(
	params: SandboxReadyParams,
): Promise<SandboxReadyResult> {
	const { sandbox, sessionId, bucket, proxyBaseUrl, proxyToken, repository } =
		params;

	const result: SandboxReadyResult = {
		workspacePath: "/workspace",
		restoredBackup: false,
		clonedRepo: false,
		configuredProxy: false,
	};

	// 1. Check & configure proxy FIRST (required for git clone to authenticate)
	// Check if ANTHROPIC_BASE_URL is set in the environment
	const proxyCheck = await sandbox.exec(
		"grep -q ANTHROPIC_BASE_URL /workspace/.env 2>/dev/null && echo exists || echo missing",
	);
	if (proxyCheck.stdout.trim() === "missing") {
		await configureSandboxProxy(sandbox, proxyBaseUrl, proxyToken);
		await setupGitConfig(sandbox);
		result.configuredProxy = true;
	}

	// 2. Check & restore OpenCode backup
	const storageCheck = await sandbox.exec(
		"test -d ~/.local/share/opencode/storage && echo exists || echo missing",
	);
	if (storageCheck.stdout.trim() === "missing") {
		const restored = await restoreSession(sandbox, sessionId, bucket);
		result.restoredBackup = restored;
	}

	// 3. Check & clone repository (now proxy is configured for git auth)
	if (repository) {
		const repoName = getRepoName(repository.url);
		const targetDir = `/workspace/${repoName}`;

		const repoCheck = await sandbox.exec(
			`test -d ${targetDir}/.git && echo exists || echo missing`,
		);
		if (repoCheck.stdout.trim() === "missing") {
			await cloneRepository(sandbox, repository.url, repository.branch);
			result.clonedRepo = true;
		}

		result.workspacePath = targetDir;
	}

	return result;
}

/**
 * Get a sandbox instance from the binding.
 * IMPORTANT: Must be called fresh in each workflow step - DO stubs are NOT serializable.
 */
export function getSandbox(
	deps: WorkflowDeps,
	sandboxId: string,
): Sandbox<unknown> {
	return cfGetSandbox(deps.sandboxBinding, sandboxId, {
		normalizeId: true,
	});
}

/**
 * Configure sandbox to use proxy for all external services.
 *
 * This sets up:
 * - Anthropic SDK to use proxy (via environment variables)
 * - Git to use proxy for github.com operations (via URL rewriting)
 *
 * After calling this, the sandbox can make authenticated API calls
 * without having access to real credentials.
 */
async function configureSandboxProxy(
	sandbox: Sandbox<unknown>,
	proxyBaseUrl: string,
	proxyToken: string,
): Promise<void> {
	const containerProxyUrl = toContainerUrl(proxyBaseUrl);
	await configureAnthropic(sandbox, containerProxyUrl, proxyToken);
	await configureGithub(sandbox, containerProxyUrl, proxyToken);
}

/**
 * Set up basic git configuration (user info for commits).
 * Authentication is handled by the proxy via configureGithub().
 */
async function setupGitConfig(sandbox: Sandbox<unknown>): Promise<void> {
	await sandbox.exec(
		`git config --global user.email "opencode@sandbox.workers.dev"`,
	);
	await sandbox.exec(`git config --global user.name "OpenCode Bot"`);
}

/**
 * Extract repository name from URL for use as subdirectory.
 * e.g., "https://github.com/owner/repo" -> "repo"
 *       "https://github.com/owner/repo.git" -> "repo"
 */
function getRepoName(url: string): string {
	const match = url.match(/\/([^/]+?)(\.git)?$/);
	return match ? match[1] : "repo";
}

/**
 * Clone a git repository into /workspace/{repo-name}
 */
async function cloneRepository(
	sandbox: Sandbox<unknown>,
	url: string,
	branch?: string,
): Promise<string> {
	const repoName = getRepoName(url);
	const targetDir = `/workspace/${repoName}`;

	// Check if already cloned
	const checkResult = await sandbox.exec(
		`test -d ${targetDir}/.git && echo exists || echo missing`,
	);

	if (checkResult.stdout.trim() === "exists") {
		// Already cloned, just fetch latest
		await sandbox.exec(`cd ${targetDir} && git fetch origin`);
		if (branch) {
			await sandbox.exec(`cd ${targetDir} && git checkout ${branch}`);
		}
		return targetDir;
	}

	// Clone the repository
	await sandbox.gitCheckout(url, {
		branch: branch ?? "main",
		targetDir,
	});

	return targetDir;
}
