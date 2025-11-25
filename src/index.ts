import { type Sandbox, getSandbox } from "@cloudflare/sandbox";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Agent, getAgentByName } from "agents";
import {
  createMcpHandler,
  WorkerTransport,
  type TransportState,
} from "agents/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { nanoid } from "nanoid";

export { Sandbox } from "@cloudflare/sandbox";

const STATE_KEY = "mcp_transport_state";

interface State {
  sandboxId: string | null;
}

export class SandboxMcpServer extends Agent<Env, State> {
  server = new McpServer({
    name: "sandbox-mcp",
    version: "1.0.0",
  });

  initialState: State = {
    sandboxId: null,
  };

  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => {
        return this.ctx.storage.kv.get<TransportState>(STATE_KEY);
      },
      set: (state: TransportState) => {
        this.ctx.storage.kv.put<TransportState>(STATE_KEY, state);
      },
    },
  });

  onStart() {
    // Tool 1: createSandbox - Get or create a sandbox instance
    this.server.registerTool(
      "createSandbox",
      {
        description:
          "Creates a new sandbox instance. Returns sandbox ID and status. We can only use a limited number of sandboxes, so if you already have a sandbox, you should use it. If you pass a sandboxId we will validate it and return it if it exists.",
        inputSchema: {
          sandboxId: z.string().optional(),
        },
      },
      async ({ sandboxId }) => {
        try {
          const id = sandboxId || nanoid(16).toLowerCase();

          console.log(`Creating sandbox with id: ${id}`);
          const sandbox = getSandbox(this.env.SANDBOX, id);
          this.setState({ sandboxId: id });

          console.log("Got sandbox, executing test command...");
          // Verify sandbox is accessible - sandbox.exec is Cloudflare Sandbox SDK method
          const result = await sandbox.exec("echo 'sandbox ready'");
          console.log("Exec result:", JSON.stringify(result));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId: id,
                    status: result.success ? "ready" : "error",
                    message: result.success
                      ? "Sandbox is ready for code execution"
                      : `Sandbox initialization failed: ${result.stderr}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          console.error("createSandbox error:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create sandbox: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 2: exec - Run any bash command in the sandbox
    this.server.registerTool(
      "exec",
      {
        description:
          "Run any bash command in the sandbox. Returns stdout, stderr, and exit code.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox to execute in"),
          command: z.string().describe("Bash command to execute"),
          timeout: z
            .number()
            .optional()
            .default(30000)
            .describe("Maximum execution time in milliseconds"),
          envVars: z
            .record(z.string())
            .optional()
            .describe("Additional environment variables for execution"),
        }),
      },
      async ({ sandboxId, command, timeout, envVars }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          // sandbox.exec is the Cloudflare Sandbox SDK method for isolated execution
          const result = await sandbox.exec(command, {
            timeout,
            env: {
              ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
              ...envVars,
            },
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    success: result.success,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Execution failed: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 3: startProcess - Start a long-running process
    this.server.registerTool(
      "startProcess",
      {
        description:
          "Starts a long-running background process in the sandbox. The process continues running independently of the MCP connection.",
        inputSchema: z.object({
          sandboxId: z
            .string()
            .describe("ID of the sandbox to start the process in"),
          command: z
            .string()
            .describe("Command to run as a background process"),
          envVars: z
            .record(z.string())
            .optional()
            .describe("Environment variables for the process"),
        }),
      },
      async ({ sandboxId, command, envVars }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          const proc = await sandbox.startProcess(command, {
            env: envVars,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    processId: proc.id,
                    pid: proc.pid,
                    command: proc.command,
                    status: proc.status,
                    message: "Background process started successfully",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to start background process: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 4: listProcesses - List all running processes in a sandbox
    this.server.registerTool(
      "listProcesses",
      {
        description:
          "Lists all running background processes in a sandbox. Returns process IDs, commands, and status.",
        inputSchema: z.object({
          sandboxId: z
            .string()
            .describe("ID of the sandbox to list processes from"),
        }),
      },
      async ({ sandboxId }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
          const processes = await sandbox.listProcesses();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    processes: processes.map((p) => ({
                      processId: p.id,
                      pid: p.pid,
                      command: p.command,
                      status: p.status,
                    })),
                    count: processes.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list processes: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 5: getProcessLogs - Get logs from a background process
    this.server.registerTool(
      "getProcessLogs",
      {
        description:
          "Gets accumulated log output from a running or completed background process.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox"),
          processId: z.string().describe("ID of the process to get logs from"),
        }),
      },
      async ({ sandboxId, processId }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
          const logs = await sandbox.getProcessLogs(processId);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    processId,
                    logs,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to get process logs: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 6: killProcess - Kill a specific background process
    this.server.registerTool(
      "killProcess",
      {
        description: "Terminates a specific background process in the sandbox.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox"),
          processId: z.string().describe("ID of the process to kill"),
          signal: z
            .string()
            .optional()
            .describe(
              "Signal to send (e.g., 'SIGTERM', 'SIGKILL'). Defaults to SIGTERM."
            ),
        }),
      },
      async ({ sandboxId, processId, signal }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
          await sandbox.killProcess(processId, signal);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    processId,
                    status: "killed",
                    signal: signal || "SIGTERM",
                    message: "Process terminated successfully",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to kill process: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 7: destroySandbox - Terminate and cleanup a sandbox
    this.server.registerTool(
      "destroySandbox",
      {
        description:
          "Terminates a sandbox and deletes all associated state, files, and processes. This action cannot be undone.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox to destroy"),
        }),
      },
      async ({ sandboxId }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          await sandbox.destroy();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    status: "destroyed",
                    message: "Sandbox terminated and all state deleted",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to destroy sandbox: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 8: gitCheckout - Clone a git repository into the sandbox
    this.server.registerTool(
      "gitCheckout",
      {
        description:
          "Clones a git repository into the sandbox. Supports public repos and private repos with token auth. Use this instead of manually running git clone.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox to clone into"),
          repositoryUrl: z
            .string()
            .describe(
              "Git repository URL. For private repos, include token: https://TOKEN@github.com/user/repo.git"
            ),
          branch: z
            .string()
            .optional()
            .describe(
              "Specific branch to checkout. Defaults to default branch."
            ),
          targetDir: z
            .string()
            .optional()
            .describe(
              "Directory to clone into. Defaults to repo name in /workspace."
            ),
        }),
      },
      async ({ sandboxId, repositoryUrl, branch, targetDir }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          // Use the Cloudflare Sandbox gitCheckout API
          await sandbox.gitCheckout(repositoryUrl, {
            branch,
            targetDir,
          });

          // Get the directory that was created
          const repoName =
            targetDir ||
            repositoryUrl.split("/").pop()?.replace(".git", "") ||
            "repo";
          const clonePath = targetDir || `/workspace/${repoName}`;

          // Verify the clone succeeded
          const lsResult = await sandbox.exec(`ls -la ${clonePath}`);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    status: "cloned",
                    repositoryUrl: repositoryUrl.replace(
                      /https:\/\/[^@]+@/,
                      "https://***@"
                    ), // Hide tokens
                    branch: branch || "default",
                    path: clonePath,
                    files: lsResult.stdout,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to clone repository: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 9: runClaudeCode - Run Claude Code in headless mode
    this.server.registerTool(
      "runClaudeCode",
      {
        description:
          "Runs Claude Code (AI coding assistant) in headless mode to complete a coding task. Starts as a background process that can be monitored with listProcesses and getProcessLogs. Claude Code is pre-installed in the sandbox container.",
        inputSchema: z.object({
          sandboxId: z
            .string()
            .describe("ID of the sandbox to run Claude Code in"),
          prompt: z
            .string()
            .describe("The task/prompt for Claude Code to complete"),
          workingDirectory: z
            .string()
            .optional()
            .default("/workspace")
            .describe(
              "Working directory for Claude Code. Defaults to /workspace."
            ),
          allowedTools: z
            .string()
            .optional()
            .default(
              "Bash,Glob,Grep,LS,exit_plan_mode,Read,Edit,MultiEdit,Write,NotebookRead,NotebookEdit,WebFetch,TodoRead,TodoWrite,WebSearch"
            )
            .describe(
              "Comma-separated list of tools Claude Code can use. Defaults to all tools."
            ),
          outputFormat: z
            .enum(["text", "json", "stream-json"])
            .optional()
            .default("text")
            .describe(
              "Output format: text (human readable, default), json (final result), stream-json (streaming progress, requires verbose)"
            ),
          maxTurns: z
            .number()
            .optional()
            .describe(
              "Maximum number of agentic turns. If not set, Claude Code uses its default."
            ),
        }),
      },
      async ({
        sandboxId,
        prompt,
        workingDirectory,
        allowedTools,
        outputFormat,
        maxTurns,
      }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          // Build the Claude Code command with proper flags
          // Claude is installed via bun at /root/.bun/bin/claude
          // The sandbox runs as root, so this path is accessible
          const claudePath = "/root/.bun/bin/claude";

          // Escape the prompt for shell
          const escapedPrompt = prompt
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/`/g, "\\`")
            .replace(/\$/g, "\\$");

          let command = `cd ${workingDirectory} && ${claudePath} -p "${escapedPrompt}"`;

          // Add allowed tools (--dangerously-skip-permissions cannot be used as sandbox runs as root)
          command += ` --allowedTools "${allowedTools}"`;

          // Add output format
          command += ` --output-format ${outputFormat}`;

          // Add max turns if specified
          if (maxTurns) {
            command += ` --max-turns ${maxTurns}`;
          }

          // Redirect stderr to stdout for complete output
          command += " 2>&1";

          // Start Claude Code as a background process
          const proc = await sandbox.startProcess(command, {
            env: {
              ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
              PATH: "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              HOME: "/root",
            },
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    processId: proc.id,
                    pid: proc.pid,
                    status: proc.status,
                    workingDirectory,
                    prompt:
                      prompt.slice(0, 200) + (prompt.length > 200 ? "..." : ""),
                    message:
                      "Claude Code started. Use listProcesses to check status and getProcessLogs to get output.",
                    tips: [
                      "Monitor progress with: getProcessLogs(sandboxId, processId)",
                      "Check completion with: listProcesses(sandboxId)",
                      "Output is in stream-json format - look for 'result' type messages",
                    ],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to start Claude Code: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );

    // Tool 10: exposePort - Expose a port from the sandbox as a public URL
    this.server.registerTool(
      "exposePort",
      {
        description:
          "Exposes a port from the sandbox container as a publicly accessible preview URL. Use this when you need to access a web server, API, or other service running in the sandbox from outside. The URL format is {port}-{sandboxId}.{domain}.",
        inputSchema: z.object({
          sandboxId: z.string().describe("ID of the sandbox"),
          port: z
            .number()
            .describe(
              "Port number to expose (e.g., 3000, 8080). Must be a port that a service is listening on inside the sandbox."
            ),
        }),
      },
      async ({ sandboxId, port }) => {
        try {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

          // exposePort returns a URL that can be used to access the port
          const previewUrl = await sandbox.exposePort(port, {
            hostname: "sandbox.mcp.mattzcarey.com",
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sandboxId,
                    port,
                    previewUrl,
                    message: `Port ${port} is now accessible at the preview URL`,
                    tips: [
                      "Make sure a service is actually running on this port inside the sandbox",
                      "Use startProcess to start a web server before exposing the port",
                      "The preview URL will remain active as long as the sandbox is running",
                    ],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to expose port: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }
    );
  }

  async ensureDestroy() {
    const schedules = this.getSchedules().filter(
      (s) => s.callback === "destroySandbox"
    );
    if (schedules.length > 0) {
      // Cancel previously set destroy schedules
      for (const s of schedules) {
        await this.cancelSchedule(s.id);
      }
    }
    // Destroy after 1 hour of inactivity
    await this.schedule(60 * 60, "destroySandbox");
  }

  async destroySandbox() {
    const sandboxId = this.state.sandboxId;
    if (sandboxId) {
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
      await sandbox.destroy();
    }

    this.destroy();
  }

  async onMcpRequest(request: Request) {
    this.ensureDestroy();
    return createMcpHandler(this.server, {
      transport: this.transport,
    })(request, this.env, {} as ExecutionContext);
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

app.use("/mcp/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== c.env.AUTH_TOKEN) {
    return c.json({ error: "Invalid authentication token" }, 401);
  }

  await next();
});

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "sandbox-mcp" });
});

app.get("/", (c) => {
  return c.json({
    name: "sandbox-mcp",
    version: "1.0.0",
    description: "MCP server for Cloudflare Sandbox code execution",
    endpoint: "/mcp",
    auth: "Bearer token required",
    tools: [
      "createSandbox",
      "exec",
      "startProcess",
      "listProcesses",
      "getProcessLogs",
      "killProcess",
      "destroySandbox",
      "gitCheckout",
      "runClaudeCode",
      "exposePort",
    ],
  });
});

// Export the combined handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Route /mcp to the MCP handler
    if (url.pathname.startsWith("/mcp")) {
      const sessionIdHeader = request.headers.get("mcp-session-id");
      const sessionId = sessionIdHeader ?? crypto.randomUUID();

      // Clone request to read body for logging without consuming it
      const clonedRequest = request.clone();
      let bodyForLog: unknown = null;
      try {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          bodyForLog = await clonedRequest.json();
        } else {
          bodyForLog = await clonedRequest.text();
        }
      } catch {
        bodyForLog = "[failed to parse body]";
      }

      // Log session ID and request details
      console.log("=== MCP Request Debug ===");
      console.log("Method:", request.method);
      console.log("Path:", url.pathname);
      console.log("mcp-session-id header:", sessionIdHeader ?? "(not set)");
      console.log("Using session ID:", sessionId);
      console.log("Request body:", JSON.stringify(bodyForLog, null, 2));
      console.log("All headers:", JSON.stringify(Object.fromEntries(request.headers.entries()), null, 2));
      console.log("=========================");

      const agent = await getAgentByName(env.MCP_SERVER, sessionId);
      return await agent.onMcpRequest(request);
    }

    // Route everything else to Hono
    return app.fetch(request, env, ctx);
  },
};
