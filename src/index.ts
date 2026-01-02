// src/index.ts
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer } from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk";
import { Effect, Option } from "effect";

import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import type { SessionMetadata } from "./models/session";
import {
  anthropic,
  createProxyHandler,
  createProxyToken,
  github,
  toContainerUrl,
} from "./proxy";
import { makeSessionStorageLayer, SessionStorage } from "./services/session";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";
import { ensureSandboxReady } from "./workflows/helpers/sandbox";

// Export Sandbox class from @cloudflare/sandbox
export { Sandbox } from "@cloudflare/sandbox";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { ExecuteTaskWorkflow };

/**
 * Create proxy handler for zero-trust authentication.
 *
 * Routes:
 * - /proxy/anthropic/* → Anthropic API (injects ANTHROPIC_API_KEY)
 * - /proxy/github/* → GitHub (injects GITHUB_TOKEN for git operations)
 */
const proxyHandler = createProxyHandler<Env>({
  mountPath: "/proxy",
  jwtSecret: (env) => env.PROXY_JWT_SECRET,
  services: { anthropic, github },
});

/**
 * Get OpenCode config that uses the proxy for API calls.
 *
 * The JWT token is passed as the API key, and the baseURL points to our proxy.
 * The proxy validates the JWT and injects the real ANTHROPIC_API_KEY.
 */
function getProxyOpencodeConfig(
  proxyBaseUrl: string,
  proxyToken: string
): Config {
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
 * Cookie name for tracking which session the web UI is viewing.
 * This is needed because OpenCode's frontend loads assets from root (/)
 * and we need to know which sandbox to proxy those requests to.
 */
const SESSION_COOKIE_NAME = "opencode_session_id";

/**
 * Get session ID from cookie
 */
function getSessionFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === SESSION_COOKIE_NAME && value) {
      return value;
    }
  }
  return null;
}

/**
 * Get session metadata from R2 using the SessionStorage service.
 * Returns null if session not found or on error.
 */
function getSessionMetadata(
  bucket: R2Bucket,
  sessionId: string
): Effect.Effect<SessionMetadata | null> {
  const layer = makeSessionStorageLayer(bucket);

  return Effect.gen(function* () {
    const storage = yield* SessionStorage;
    const result = yield* storage.getSession(sessionId);
    return Option.getOrNull(result);
  }).pipe(
    Effect.provide(layer),
    Effect.catchAll(() => Effect.succeed(null))
  );
}

/**
 * Proxy request to the appropriate sandbox.
 *
 * This function ensures the sandbox is ready before proxying:
 * - Restores OpenCode backup if needed
 * - Clones repository if needed
 * - Configures proxy credentials if needed
 *
 * All initialization is idempotent - safe to call on every request.
 */
async function proxyToSandbox(
  request: Request,
  env: Env,
  sessionId: string,
  targetPath: string
): Promise<Response> {
  // Get sandbox for this session (will wake it up if sleeping)
  const sandbox = getSandbox(env.Sandbox, sessionId, {
    normalizeId: true,
  });

  // Create a short-lived proxy token for web UI access
  const proxyToken = await Effect.runPromise(
    createProxyToken({
      secret: env.PROXY_JWT_SECRET,
      sandboxId: sessionId,
      expiresIn: "15m", // Short-lived for web UI sessions
    })
  );

  // Get session metadata to know repository info
  const metadata = await Effect.runPromise(
    getSessionMetadata(env.SESSIONS_BUCKET, sessionId)
  );

  // Derive base URL from request (no need for env var)
  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

  // Ensure sandbox is ready (idempotent - checks state before acting)
  const ready = await ensureSandboxReady({
    sandbox,
    sessionId,
    bucket: env.SESSIONS_BUCKET,
    proxyBaseUrl: baseUrl,
    proxyToken,
    repository: metadata?.repository,
  });

  // Start OpenCode server with proxy-based config and correct workspace path
  const server = await createOpencodeServer(sandbox, {
    directory: ready.workspacePath,
    config: getProxyOpencodeConfig(baseUrl, proxyToken),
  });

  // Rewrite URL to the target path - OpenCode expects requests at root
  const url = new URL(request.url);
  const rewrittenUrl = new URL(targetPath, url.origin);
  rewrittenUrl.search = url.search;

  // Create new request with rewritten URL but preserve method/headers/body
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    redirect: request.redirect,
  });

  // Proxy directly to container
  return sandbox.containerFetch(rewrittenRequest, server.port);
}

// Worker fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Proxy routes - zero-trust authentication for sandbox requests
    // Must be before other routes to intercept /proxy/* paths
    if (url.pathname.startsWith("/proxy/")) {
      return proxyHandler(request, env);
    }

    // MCP endpoint - route to McpAgent
    if (url.pathname.startsWith("/mcp")) {
      return OpenCodeMcpAgent.serve("/mcp", { binding: "MCP_AGENT" }).fetch(
        request,
        env,
        ctx
      );
    }

    // Web UI entry point - /session/{sessionId} sets cookie and redirects to OpenCode
    // OpenCode expects URLs like /{base64(directory)}/session/{opencode-session-id}
    // We query R2 to get the actual OpenCode session ID and workspace path
    //
    // IMPORTANT: Don't match OpenCode's own API routes like /session/status, /session/list
    // Our session IDs are 8 hex chars (e.g., "a1b2c3d4"), so we use that pattern
    const sessionMatch = url.pathname.match(/^\/session\/([0-9a-f]{8})\/?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];

      // Look up session info from R2
      const metadata = await Effect.runPromise(
        getSessionMetadata(env.SESSIONS_BUCKET, sessionId)
      );

      if (!metadata) {
        return new Response(
          JSON.stringify({ error: "Session not found", sessionId }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Use the stored workspace path, or default to /workspace
      const workspacePath = metadata.workspacePath || "/workspace";
      const workspaceBase64 = btoa(workspacePath);

      // Build redirect URL - include OpenCode session ID if available
      let redirectPath = `/${workspaceBase64}/session`;
      if (metadata.opencodeSessionId) {
        redirectPath += `/${metadata.opencodeSessionId}`;
      }

      const redirectUrl = new URL(redirectPath, url.origin);
      redirectUrl.searchParams.set("url", url.origin);

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; SameSite=Lax`,
        },
      });
    }

    // Catch-all: Proxy ANY request to the sandbox when session cookie is present
    // This handles OpenCode API routes like /path, /project, /provider, /global/event,
    // /session/list, /session/{uuid}/prompt, etc.
    // Must come BEFORE the default JSON response
    const sessionId = getSessionFromCookie(request);
    if (sessionId) {
      try {
        return await proxyToSandbox(request, env, sessionId, url.pathname);
      } catch (error) {
        console.error("API proxy error:", error);
        return new Response(
          JSON.stringify({ error: "Failed to proxy request" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Default response
    return new Response(
      JSON.stringify({
        name: "sandbox-mcp",
        version: "1.0.0",
        endpoints: {
          health: "/health",
          mcp: "/mcp",
          webUi: "/session/{sessionId}/",
          proxy: "/proxy/{service}/*",
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};
