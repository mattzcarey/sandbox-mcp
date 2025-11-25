# Product Requirements Document: Cloudflare Sandbox MCP Integration

**Document Version:** 2.0  
**Last Updated:** November 25, 2025  
**Author:** Matthew Carey  
**Status:** Active Development

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Overview](#overview)
3. [Goals & Objectives](#goals--objectives)
4. [Requirements](#requirements)
5. [Technical Architecture](#technical-architecture)
6. [MCP Tool Definition Examples](#mcp-tool-definition-examples)
7. [Implementation Plan](#implementation-plan)
8. [Success Metrics](#success-metrics)
9. [Appendices](#appendices)

---

## Executive Summary

This document outlines the requirements for developing a Model Context Protocol (MCP) server that integrates with Cloudflare's Sandbox API. The solution enables AI agents to programmatically create, manage, and execute code within isolated sandbox instances powered by V8 isolates with ~1ms cold start times.

The implementation follows patterns established in the txt2mcp project, adapted specifically for sandbox functionality. Key features include persistent sandbox management via keepAlive, background process support, preview URLs for service exposure, and secure authentication using Wrangler secrets as bindings.

**Key Value Propositions:**
- Ultra-fast V8 isolate-based execution (~1ms cold starts)
- Persistent sandboxes with configurable keepAlive
- Secure AI-generated code execution environments
- Bearer token authentication with ANTHROPIC credentials
- Simplified MCP server implementation with single /mcp endpoint

---

## Overview

### Product Description

An MCP server that provides a standardized interface for managing Cloudflare sandbox environments via the Cloudflare Sandbox SDK. The server acts as a bridge between AI agents and Cloudflare's sandbox infrastructure, enabling:

- **Dynamic Sandbox Management**: Get or create sandbox instances on-demand
- **Secure Code Execution**: Execute arbitrary code within V8 isolates
- **Background Process Management**: Start and monitor long-running processes
- **Complete Lifecycle Control**: Terminate containers and delete all state

### Technical Foundation

**Built on Cloudflare Sandbox Technology:**
- V8 isolates for secure, fast execution
- ~1ms cold start times for instant responsiveness
- Global edge deployment via Cloudflare Workers
- Preview URLs for exposing sandbox services

**Key Architectural Decisions:**
- Single `/mcp` endpoint (no additional routes needed)
- `createMcpHandler` for agent state management
- Bearer token auth using Wrangler secrets as bindings
- ANTHROPIC credentials running in sandbox context
- Pattern consistency with txt2mcp implementation

### Documentation References

- **Main Documentation**: https://developers.cloudflare.com/sandbox/
- **API Reference**: https://developers.cloudflare.com/sandbox/api/
- **Lifecycle Management**: https://developers.cloudflare.com/sandbox/api/lifecycle/
- **Configuration Options**: https://developers.cloudflare.com/sandbox/configuration/sandbox-options/
- **GitHub Repository**: https://github.com/cloudflare/sandbox-sdk

### Target Users

- AI agents requiring safe code execution capabilities
- Developers building autonomous agent systems
- Teams needing isolated compute environments for testing
- Applications requiring ephemeral execution contexts with fast initialization

---

## Goals & Objectives

### Primary Goals

1. **Provide Secure Sandbox Management**: Enable creation and management of V8 isolate-based execution environments
2. **Standardize MCP Interface**: Implement consistent MCP patterns for sandbox operations
3. **Ensure Ultra-Low Latency**: Leverage V8 isolates for <1ms cold starts and rapid execution
4. **Maintain Security**: Implement robust authentication and isolation mechanisms via Cloudflare's platform

### Success Criteria

- All four core tools (getSandbox, exec, startBackgroundProcess, destroy) functional
- Cold start latency ~1ms (V8 isolate performance)
- < 50ms latency for sandbox operations
- 99.9% uptime leveraging Cloudflare's infrastructure
- Zero cross-sandbox data leakage
- Seamless ANTHROPIC credential integration
- Comprehensive documentation and examples

### Non-Goals

- General-purpose compute platform (not a replacement for traditional VMs)
- Persistent storage beyond session lifetime (unless explicitly configured)
- Multi-tenancy within single sandbox instances
- Complex orchestration beyond background processes
- Custom runtime environments outside V8

---

## Requirements

### Core Functionality

#### 1. getSandbox() - Get or Create Sandbox Instance

**Purpose:** Retrieve an existing sandbox or create a new one with specified configuration.

**Method Signature:**
```typescript
async function getSandbox(options?: {
  sandboxId?: string;
  keepAlive?: boolean;
  timeoutMs?: number;
}): Promise<Sandbox>
```

**Inputs:**
- `sandboxId` (optional): Specific sandbox identifier to retrieve
- `keepAlive` (optional): Enable persistent sandbox mode
- `timeoutMs` (optional): Timeout duration for keepAlive sessions

**Outputs:**
```json
{
  "sandboxId": "string",
  "status": "running|stopped|initializing",
  "createdAt": "ISO8601 timestamp",
  "keepAlive": "boolean",
  "expiresAt": "ISO8601 timestamp (if keepAlive enabled)",
  "environment": {
    "hasAnthropicCredentials": true,
    "v8Version": "string",
    "previewUrl": "string (if applicable)"
  },
  "coldStartTime": "duration in ms"
}
```

**Behavior:**
- If `sandboxId` provided, attempts to retrieve existing sandbox
- If sandbox doesn't exist or no ID provided, creates new V8 isolate
- Supports keepAlive configuration for persistent sandboxes
- Returns sandbox metadata including preview URLs
- Injects ANTHROPIC credentials into sandbox environment
- ~1ms cold start time for new sandboxes

---

#### 2. exec - Execute Code in Sandbox

**Purpose:** Execute code snippets or commands synchronously within a sandbox environment.

**Method Signature:**
```typescript
async function exec(params: {
  sandboxId?: string;
  code: string;
  language?: 'javascript' | 'typescript';
  timeout?: number;
  env?: Record<string, string>;
}): Promise<ExecResult>
```

**Inputs:**
- `sandboxId` (optional): Target sandbox (creates new if not provided)
- `code`: Code to execute (required)
- `language` (optional): Runtime language (default: 'javascript')
- `timeout` (optional): Maximum execution time in seconds (default: 30)
- `env` (optional): Additional environment variables

**Outputs:**
```json
{
  "exitCode": 0,
  "stdout": "string",
  "stderr": "string",
  "executionTime": "duration in ms",
  "sandboxId": "string",
  "success": true
}
```

**Behavior:**
- Creates sandbox if sandboxId not provided
- Executes code within V8 isolate
- Captures both stdout and stderr
- Enforces timeout limits
- Returns execution metrics
- Maintains sandbox state for subsequent calls
- ANTHROPIC credentials available via environment

**Example:**
```javascript
// Execute AI-generated code
const result = await exec({
  code: `
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    const response = await client.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello!' }]
    });
    console.log(response.content[0].text);
  `,
  timeout: 60
});
```

---

#### 3. startBackgroundProcess - Start Background Processes

**Purpose:** Launch long-running processes that persist independently of the MCP connection.

**Method Signature:**
```typescript
async function startBackgroundProcess(params: {
  sandboxId: string;
  command: string;
  name: string;
  env?: Record<string, string>;
  restartPolicy?: 'always' | 'on-failure' | 'never';
}): Promise<ProcessInfo>
```

**Inputs:**
- `sandboxId`: Target sandbox identifier (required)
- `command`: Command to execute as background process (required)
- `name`: Process identifier/name (required)
- `env` (optional): Environment variables for the process
- `restartPolicy` (optional): Restart behavior (default: 'never')

**Outputs:**
```json
{
  "processId": "string",
  "sandboxId": "string",
  "name": "string",
  "status": "starting|running|failed",
  "pid": 12345,
  "startTime": "ISO8601 timestamp",
  "restartPolicy": "never",
  "previewUrl": "https://preview-xyz.workers.dev (if exposes port)"
}
```

**Behavior:**
- Starts process within existing sandbox
- Process runs independently of MCP connection lifecycle
- Can expose services via preview URLs
- Supports automatic restart policies
- Monitored via getSandbox() status
- Automatically cleaned up on sandbox destruction
- Logs accessible through sandbox API

**Use Cases:**
- Running web servers for testing
- Starting database instances
- Background data processing
- Long-running AI workflows

---

#### 4. destroy() - Terminate Container and Delete All State

**Purpose:** Clean up and terminate sandbox instances, releasing all resources and deleting state.

**Method Signature:**
```typescript
async function destroy(params: {
  sandboxId: string;
  force?: boolean;
}): Promise<DestroyResult>
```

**Inputs:**
- `sandboxId`: Sandbox to destroy (required)
- `force` (optional): Force termination even with running processes (default: false)

**Outputs:**
```json
{
  "sandboxId": "string",
  "status": "destroyed",
  "stoppedProcesses": ["process-name-1", "process-name-2"],
  "resourcesReleased": true,
  "stateDeleted": true,
  "destroyedAt": "ISO8601 timestamp"
}
```

**Behavior:**
- Terminates V8 isolate
- Stops all running background processes
- Deletes all sandbox state and data
- Releases allocated resources
- Invalidates preview URLs
- Returns confirmation of complete cleanup
- Idempotent (safe to call multiple times)
- Cannot be undone - all data is permanently deleted

**Error Handling:**
- If `force: false` and processes running, returns error
- If sandbox not found, returns success (already destroyed)
- Logs all cleanup operations for audit

---

### Technical Requirements

#### V8 Isolate Architecture

**Performance Characteristics:**
- **Cold Start Time**: ~1ms (V8 isolate initialization)
- **Warm Start Time**: <100μs (reusing existing isolate)
- **Memory Footprint**: 2-10MB per sandbox
- **CPU Time**: Subject to Cloudflare Workers limits (50ms per request)

**Isolation Features:**
- Separate V8 isolates per sandbox
- No shared memory between sandboxes
- Sandboxed file system access
- Restricted network egress (configurable)
- Secure credential injection

#### keepAlive Configuration

**Purpose:** Maintain sandbox sessions for multiple operations without cold starts.

**Configuration Options:**
```typescript
interface KeepAliveConfig {
  enabled: boolean;           // Enable persistent sandbox
  timeoutMs: number;          // Session timeout (default: 300000 = 5 min)
  maxIdleTime: number;        // Max time without activity (default: 600000 = 10 min)
  maxSandboxes: number;       // Max concurrent keep-alive sandboxes (default: 100)
}
```

**Behavior:**
- Sandboxes remain active after operations complete
- Automatic cleanup after timeout period
- Efficient resource utilization
- State preserved between calls
- Background processes continue running

**Implementation:**
```typescript
// Create persistent sandbox
const sandbox = await getSandbox({ 
  keepAlive: true, 
  timeoutMs: 600000  // 10 minutes
});

// Execute multiple operations without recreating
await exec({ sandboxId: sandbox.sandboxId, code: 'console.log("First")' });
await exec({ sandboxId: sandbox.sandboxId, code: 'console.log("Second")' });
```

#### Preview URLs

**Purpose:** Expose services running in sandboxes via public URLs.

**Characteristics:**
- Automatically generated for services binding to ports
- Format: `https://{random-id}.workers.dev`
- HTTPS enabled by default
- CORS headers configurable
- Lifetime tied to sandbox lifecycle

**Use Cases:**
- Testing web applications
- Sharing API endpoints
- Temporary service hosting
- AI agent web interactions

#### Authentication & Credentials

**Bearer Token Authentication:**
- Single authentication mechanism via Authorization header
- Token stored as Wrangler secret binding
- Validated on every /mcp request
- No token expiration (managed externally)

**ANTHROPIC Credentials Injection:**
```typescript
// Credentials available in sandbox via env
process.env.ANTHROPIC_API_KEY  // Injected from Wrangler secrets

// Configured in wrangler.toml
[vars]
# Public variables

# Secrets (set via CLI)
# - SANDBOX_AUTH_TOKEN
# - ANTHROPIC_API_KEY
```

**Security Model:**
- Secrets never exposed in responses
- Isolated per sandbox execution
- Encrypted at rest via Cloudflare
- Audit logging for access

---

## Technical Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Agent (MCP Client)                   │
│                   (Claude, Custom Agents)                    │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS/MCP Protocol
                             │ Bearer Token Auth
                             │
┌────────────────────────────▼────────────────────────────────┐
│           Cloudflare Worker (MCP Server)                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Single /mcp Endpoint                                 │  │
│  │  - MCP request routing                                │  │
│  │  - Tool dispatch                                      │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  createMcpHandler (txt2mcp pattern)                   │  │
│  │  - Agent state management                             │  │
│  │  - Session handling                                   │  │
│  │  - Error handling                                     │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  Tool Handlers                                        │  │
│  │  - getSandbox()   - startBackgroundProcess            │  │
│  │  - exec           - destroy()                         │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  Sandbox Manager                                      │  │
│  │  - keepAlive tracking                                 │  │
│  │  - Resource management                                │  │
│  │  - Credential injection                               │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  Authentication Layer                                 │  │
│  │  - Bearer token validation (Wrangler secrets)         │  │
│  │  - ANTHROPIC_API_KEY binding                          │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│         Cloudflare Sandbox API (V8 Isolates)                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Sandbox 1   │  │  Sandbox 2   │  │  Sandbox N   │      │
│  │  ~1ms start  │  │  ~1ms start  │  │  ~1ms start  │      │
│  │  keepAlive   │  │  Ephemeral   │  │  Background  │      │
│  │  + ANTHROPIC │  │  + ANTHROPIC │  │  Processes   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  Preview URLs:                                               │
│  https://abc123.workers.dev -> Sandbox 1 (port 8080)        │
│  https://xyz789.workers.dev -> Sandbox N (port 3000)        │
└──────────────────────────────────────────────────────────────┘
```

### Architecture Highlights

**Single Endpoint Design:**
- Only `/mcp` endpoint needed (following txt2mcp pattern)
- All MCP tools accessible through same endpoint
- Simplifies deployment and maintenance
- Reduces routing complexity

**Agent State Management:**
- `createMcpHandler` manages agent sessions
- Tracks active sandboxes per agent
- Handles disconnections and cleanup
- Session timeout management

**Sandbox Lifecycle:**
```
1. Agent requests sandbox operation
2. MCP handler validates and routes request
3. Sandbox Manager retrieves or creates V8 isolate (~1ms)
4. Credentials injected from Wrangler secrets
5. Code executed within isolated environment
6. Results returned to agent
7. Sandbox kept alive or destroyed based on config
```

**Resource Management:**
- Automatic garbage collection of expired sandboxes
- Keep-alive tracking for active sessions
- Background process monitoring
- Memory and CPU limit enforcement

### Data Flow

**Request Flow:**
```
AI Agent 
  → HTTPS POST /mcp 
  → Bearer Token Validation 
  → MCP Protocol Parsing 
  → Tool Dispatch (getSandbox|exec|startBackgroundProcess|destroy)
  → Sandbox Manager 
  → V8 Isolate Operation
  → Response Formatting
  → HTTPS Response
```

**Credential Flow:**
```
Wrangler CLI (secret set)
  → Cloudflare Secret Store
  → Worker Env Binding
  → Sandbox Environment Injection
  → Available as process.env.ANTHROPIC_API_KEY
```

### Integration with Cloudflare Sandbox SDK

**SDK Usage:**
```typescript
import { Sandbox } from '@cloudflare/sandbox-sdk';

// Initialize sandbox (from SDK docs)
const sandbox = await Sandbox.create({
  keepAlive: true,
  timeoutMs: 300000,
  env: {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY
  }
});

// Execute code
const result = await sandbox.exec({
  code: 'console.log("Hello from V8!")'
});

// Start background process
const process = await sandbox.startBackgroundProcess({
  command: 'node server.js',
  name: 'web-server'
});

// Get sandbox info
const info = await sandbox.getSandbox();

// Cleanup
await sandbox.destroy();
```

**SDK Documentation Mapping:**
- **Lifecycle**: https://developers.cloudflare.com/sandbox/api/lifecycle/
- **Options**: https://developers.cloudflare.com/sandbox/configuration/sandbox-options/
- **API Reference**: https://developers.cloudflare.com/sandbox/api/

### Comparison with txt2mcp

**Similarities:**
- Single `/mcp` endpoint architecture
- `createMcpHandler` for agent state management
- Bearer token authentication via Wrangler secrets
- Cloudflare Workers deployment
- TypeScript implementation
- Minimal external dependencies

**Differences:**

| Aspect | txt2mcp | sandbox-mcp |
|--------|---------|-------------|
| **Purpose** | Text file to MCP conversion | Code execution in sandboxes |
| **State** | Stateless transformations | Stateful sandbox management |
| **Complexity** | Simple file operations | Complex lifecycle management |
| **Resources** | Minimal (text processing) | Managed V8 isolates |
| **Credentials** | Not required | ANTHROPIC key injection |
| **Persistence** | None | keepAlive session support |

---

## MCP Tool Definition Examples

Based on the txt2mcp repository patterns, here are examples of how the sandbox MCP tools should be defined:

```typescript
onStart() {
  // Create or get a sandbox instance
  this.server.tool({
    name: "getSandbox",
    description: "Creates or gets a sandbox instance for secure code execution",
    parameters: z.object({
      keepAlive: z.boolean().optional().describe("Whether to keep sandbox alive after execution (requires explicit destroy call)"),
      timeout: z.number().optional().describe("Maximum time in seconds to keep the sandbox alive when idle"),
      preinstall: z.array(z.string()).optional().describe("Packages to pre-install in the sandbox"),
      env: z.record(z.string()).optional().describe("Environment variables to set in the sandbox")
    }),
    handler: async (params, ctx) => {
      // Implementation using Cloudflare Sandbox SDK
      try {
        const sandbox = await this.sandboxManager.getSandbox({
          keepAlive: params.keepAlive || false,
          timeout: params.timeout,
          env: {
            ...params.env,
            ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY
          }
        });
        
        // Pre-install requested packages if specified
        if (params.preinstall && params.preinstall.length > 0) {
          // Installation logic here
        }
        
        return { 
          sandboxId: sandbox.id,
          status: "ready"
        };
      } catch (error) {
        return { 
          error: "Failed to create sandbox", 
          details: error.message 
        };
      }
    }
  });
  
  // Execute code in a sandbox
  this.server.tool({
    name: "exec",
    description: "Executes code within a sandbox environment",
    parameters: z.object({
      sandboxId: z.string().describe("ID of the sandbox to execute code in"),
      code: z.string().describe("Code to execute in the sandbox"),
      language: z.enum(["javascript", "typescript", "python"]).default("javascript").describe("Programming language of the code"),
      timeout: z.number().optional().describe("Maximum execution time in seconds")
    }),
    handler: async (params, ctx) => {
      try {
        const sandbox = this.sandboxManager.getSandboxById(params.sandboxId);
        if (!sandbox) {
          return { error: "Sandbox not found" };
        }
        
        const result = await sandbox.execute({
          code: params.code,
          language: params.language,
          timeout: params.timeout
        });
        
        return {
          output: result.output,
          error: result.error,
          executionTime: result.executionTime
        };
      } catch (error) {
        return { 
          error: "Execution failed", 
          details: error.message 
        };
      }
    }
  });
  
  // Start a background process
  this.server.tool({
    name: "startBackgroundProcess",
    description: "Starts a long-running background process in the sandbox",
    parameters: z.object({
      sandboxId: z.string().describe("ID of the sandbox to start the process in"),
      command: z.string().describe("Command to execute as a background process"),
      args: z.array(z.string()).optional().describe("Arguments to pass to the command"),
      env: z.record(z.string()).optional().describe("Additional environment variables for the process")
    }),
    handler: async (params, ctx) => {
      try {
        const sandbox = this.sandboxManager.getSandboxById(params.sandboxId);
        if (!sandbox) {
          return { error: "Sandbox not found" };
        }
        
        const process = await sandbox.startBackgroundProcess({
          command: params.command,
          args: params.args || [],
          env: params.env || {}
        });
        
        return {
          processId: process.id,
          status: "running"
        };
      } catch (error) {
        return { 
          error: "Failed to start background process", 
          details: error.message 
        };
      }
    }
  });
  
  // Destroy a sandbox
  this.server.tool({
    name: "destroy",
    description: "Terminates and destroys a sandbox instance",
    parameters: z.object({
      sandboxId: z.string().describe("ID of the sandbox to destroy")
    }),
    handler: async (params, ctx) => {
      try {
        const sandbox = this.sandboxManager.getSandboxById(params.sandboxId);
        if (!sandbox) {
          return { error: "Sandbox not found" };
        }
        
        await sandbox.destroy();
        
        return {
          status: "destroyed",
          sandboxId: params.sandboxId
        };
      } catch (error) {
        return { 
          error: "Failed to destroy sandbox", 
          details: error.message 
        };
      }
    }
  });
}
```

These examples demonstrate:
- Standard MCP tool structure following the txt2mcp patterns
- Proper parameter validation with Zod schemas
- Consistent error handling
- Integration with Cloudflare Sandbox SDK
- ANTHROPIC API key injection for AI capabilities
- Proper state management via the Durable Object

The implementation follows best practices for MCP tool definitions, ensuring clear descriptions for AI agents to understand tool capabilities and requirements.

---

## Implementation Plan

### Phase 1: Foundation (Weeks 1-2)

**Week 1: Project Setup & Authentication**
- [ ] Initialize project repository with TypeScript configuration
- [ ] Configure Wrangler for Cloudflare Workers deployment
- [ ] Set up Wrangler secrets for bearer token and ANTHROPIC key
- [ ] Implement basic `/mcp` endpoint handler
- [ ] Create bearer token authentication middleware
- [ ] Write initial unit tests for authentication

**Week 2: MCP Handler Implementation**
- [ ] Implement `createMcpHandler` following txt2mcp pattern
- [ ] Set up MCP protocol parsing and response formatting
- [ ] Create tool registration system
- [ ] Implement agent state management
- [ ] Add error handling and logging
- [ ] Document MCP handler architecture

**Deliverables:**
- Working `/mcp` endpoint with authentication
- MCP protocol handler
- Initial test suite
- Project structure documentation

---

### Phase 2: Core Sandbox Integration (Weeks 3-4)

**Week 3: Cloudflare Sandbox SDK Integration**
- [ ] Install and configure `@cloudflare/sandbox-sdk`
- [ ] Implement Sandbox Manager class
- [ ] Create sandbox instance registry
- [ ] Implement `getSandbox()` tool
  - Get existing sandbox by ID
  - Create new sandbox with V8 isolate
  - Return sandbox metadata and status
- [ ] Implement `destroy()` tool
  - Terminate V8 isolate
  - Clean up all resources
  - Delete state completely
- [ ] Write integration tests for basic lifecycle

**Week 4: Code Execution & Background Processes**
- [ ] Implement `exec` tool
  - Code execution within V8 isolate
  - stdout/stderr capture
  - Timeout enforcement
  - Error handling
- [ ] Implement `startBackgroundProcess` tool
  - Process lifecycle management
  - Preview URL generation
  - Process monitoring
  - Restart policy support
- [ ] Add ANTHROPIC credential injection
- [ ] Integration tests for all four tools

**Deliverables:**
- All four core tools functional
- Sandbox SDK integration complete
- Comprehensive test coverage
- Tool documentation with examples

---

### Phase 3: keepAlive & Advanced Features (Weeks 5-6)

**Week 5: keepAlive Implementation**
- [ ] Design keepAlive session tracking system
- [ ] Implement session timeout logic
- [ ] Create automatic garbage collection for expired sandboxes
- [ ] Add keepAlive configuration options
- [ ] Implement stale sandbox cleanup job
- [ ] Performance testing with persistent sandboxes
- [ ] Document keepAlive best practices

**Week 6: Preview URLs & Polish**
- [ ] Implement preview URL management
- [ ] Add service port detection
- [ ] Configure CORS for preview URLs
- [ ] Enhanced error messages and logging
- [ ] Rate limiting implementation
- [ ] Resource monitoring and metrics
- [ ] Load testing and optimization

**Deliverables:**
- keepAlive feature fully functional
- Preview URL support
- Performance benchmarks
- Monitoring dashboards
- Rate limiting system

---

### Phase 4: Testing & Documentation (Weeks 7-8)

**Week 7: Comprehensive Testing**
- [ ] End-to-end integration tests
- [ ] Load testing with multiple concurrent sandboxes
- [ ] Security testing and penetration testing
- [ ] Edge case handling verification
- [ ] Performance profiling and optimization
- [ ] Beta testing with AI agents
- [ ] Bug fixes from testing

**Week 8: Documentation & Launch**
- [ ] Complete API reference documentation
- [ ] Write usage examples and tutorials
- [ ] Create integration guide for AI agents
- [ ] Add troubleshooting guide
- [ ] Record demo videos
- [ ] Prepare launch announcement
- [ ] Production deployment
- [ ] Post-launch monitoring setup

**Deliverables:**
- Production-ready system
- Complete documentation
- Example integrations
- Launch materials
- Monitoring and alerting configured

---

### Post-Launch: Maintenance & Iteration

**Ongoing Activities:**
- Monitor system performance and errors
- Collect user feedback from AI agent integrations
- Bug fixes and security patches
- Performance optimizations
- Feature enhancements based on usage patterns

**Quarterly Reviews:**
- Performance analysis and optimization
- Cost analysis and optimization
- Security audits
- Feature roadmap updates
- User satisfaction assessment

---

## Success Metrics

### Performance Metrics

**Latency (Critical for AI Agents):**
- Cold start time: ~1ms (V8 isolate target)
- Warm start time: <100μs
- P50 operation latency: < 50ms
- P95 operation latency: < 100ms
- P99 operation latency: < 200ms

**Throughput:**
- 10,000+ requests per second per Worker
- 1,000+ concurrent sandboxes supported
- 100+ background processes per sandbox
- 99.95% success rate

**Resource Utilization:**
- 2-10MB memory per sandbox
- <50ms CPU time per operation (Workers limit)
- Automatic garbage collection effectiveness >95%

### Reliability Metrics

**Availability:**
- 99.9% uptime (leveraging Cloudflare infrastructure)
- <5 minutes downtime per month
- Zero data loss
- <1 second failover time

**Error Rates:**
- <0.1% error rate overall
- <0.01% timeout rate
- Zero security incidents
- Zero cross-sandbox data leakage

### Usage Metrics

**Adoption (First 3 Months):**
- 50+ AI agent integrations
- 100,000+ sandbox operations per day
- 20+ production deployments
- 10+ open-source projects using sandbox-mcp

**Engagement:**
- 80%+ retention rate for weekly active users
- Daily active agent sessions growing
- Positive developer feedback (4.5+ stars)
- Active community contributions

### Business Metrics

**Cost Efficiency:**
- <$0.005 per 1,000 requests (Cloudflare Workers pricing)
- Efficient resource utilization via keepAlive
- Predictable scaling costs
- ROI positive within 6 months

**Developer Experience:**
- <10 minutes to first sandbox execution
- <30 minutes to full integration
- 90%+ developer satisfaction
- <24 hour support response time

### Technical Quality Metrics

**Code Quality:**
- 90%+ test coverage
- Zero critical vulnerabilities
- <5% code churn per sprint
- All TypeScript strict mode enabled

**Documentation Quality:**
- 100% API documentation coverage
- 5+ detailed examples per tool
- <2 hours time-to-understanding for new developers
- Video tutorials for common use cases

---

## Appendices

### Appendix A: Tool Specifications Summary

| Tool | Purpose | Cold Start | keepAlive Support | Credentials |
|------|---------|------------|-------------------|-------------|
| `getSandbox()` | Get or create sandbox | ~1ms | ✅ Yes | ANTHROPIC injected |
| `exec` | Execute code | ~1ms (if new) | ✅ Yes | Available in env |
| `startBackgroundProcess` | Launch process | Requires existing | ✅ Yes | Available in env |
| `destroy()` | Terminate & cleanup | N/A | Ends session | N/A |

### Appendix B: Configuration Examples

**wrangler.toml:**
```toml
name = "sandbox-mcp"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "production"
MAX_SANDBOX_LIFETIME_MS = "3600000"  # 1 hour
DEFAULT_KEEP_ALIVE_MS = "300000"     # 5 minutes

# Secrets set via: wrangler secret put <NAME>
# - SANDBOX_AUTH_TOKEN
# - ANTHROPIC_API_KEY
```

**Environment Setup:**
```bash
# Set authentication token
wrangler secret put SANDBOX_AUTH_TOKEN
# Enter: your-secure-bearer-token

# Set Anthropic API key
wrangler secret put ANTHROPIC_API_KEY
# Enter: sk-ant-api-...
```

### Appendix C: Example MCP Client Integration

**Using Claude Desktop with sandbox-mcp:**

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "sandbox": {
      "url": "https://sandbox-mcp.your-subdomain.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

**Programmatic Usage:**
```typescript
import { MCPClient } from '@anthropic-ai/mcp-client';

const client = new MCPClient({
  endpoint: 'https://sandbox-mcp.your-subdomain.workers.dev/mcp',
  auth: {
    bearer: process.env.SANDBOX_AUTH_TOKEN
  }
});

// Create persistent sandbox
const sandbox = await client.callTool('getSandbox', {
  keepAlive: true,
  timeoutMs: 600000
});

// Execute code with Anthropic API
const result = await client.callTool('exec', {
  sandboxId: sandbox.sandboxId,
  code: `
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const message = await client.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Write hello world in 5 languages' }]
    });
    
    console.log(message.content[0].text);
  `,
  timeout: 60
});

console.log(result.stdout);

// Start a background web server
const process = await client.callTool('startBackgroundProcess', {
  sandboxId: sandbox.sandboxId,
  command: 'node -e "require(\'http\').createServer((req,res) => res.end(\'Hello\')).listen(8080)"',
  name: 'web-server'
});

console.log('Preview URL:', process.previewUrl);

// Cleanup when done
await client.callTool('destroy', {
  sandboxId: sandbox.sandboxId
});
```

### Appendix D: Security Best Practices

**1. Token Management:**
- Never commit tokens to version control
- Rotate tokens quarterly
- Use separate tokens for dev/staging/production
- Audit token usage regularly

**2. Sandbox Isolation:**
- Each sandbox runs in separate V8 isolate
- No shared state between sandboxes
- Network egress restrictions enforced
- File system access sandboxed

**3. Credential Handling:**
- ANTHROPIC keys stored as Wrangler secrets
- Never log credentials
- Automatic redaction in error messages
- Encrypted at rest and in transit

**4. Input Validation:**
- Sanitize all code inputs
- Enforce resource limits
- Timeout all operations
- Validate sandbox IDs

**5. Monitoring & Auditing:**
- Log all sandbox operations
- Monitor for abuse patterns
- Alert on anomalies
- Retain logs for 90 days

### Appendix E: Troubleshooting Guide

**Common Issues:**

**1. Sandbox Creation Fails**
```
Error: Failed to create sandbox
Cause: Cloudflare Workers limits exceeded
Solution: Check quota, implement rate limiting
```

**2. keepAlive Not Working**
```
Error: Sandbox expired despite keepAlive
Cause: Timeout too short or system cleanup
Solution: Increase timeoutMs, check logs
```

**3. ANTHROPIC Credentials Missing**
```
Error: ANTHROPIC_API_KEY not found
Cause: Secret not set in Wrangler
Solution: wrangler secret put ANTHROPIC_API_KEY
```

**4. Preview URL Not Generated**
```
Error: No preview URL for process
Cause: Process not binding to expected port
Solution: Check process logs, ensure port 8080
```

**5. Authentication Failures**
```
Error: 401 Unauthorized
Cause: Invalid bearer token
Solution: Verify token matches Wrangler secret
```

### Appendix F: Performance Optimization Tips

**1. Use keepAlive for Repeated Operations:**
```typescript
// ✅ Good: Reuse sandbox
const sandbox = await getSandbox({ keepAlive: true });
for (const code of codeSnippets) {
  await exec({ sandboxId: sandbox.sandboxId, code });
}

// ❌ Bad: Create new sandbox each time
for (const code of codeSnippets) {
  await exec({ code });  // New sandbox = ~1ms each time
}
```

**2. Batch Operations:**
```typescript
// Execute multiple operations before destroying
const results = [];
for (const task of tasks) {
  results.push(await exec({ sandboxId, code: task }));
}
await destroy({ sandboxId });
```

**3. Background Processes for Long Tasks:**
```typescript
// Use startBackgroundProcess for >30s tasks
await startBackgroundProcess({
  sandboxId,
  command: 'node long-running-task.js',
  name: 'background-job'
});
// Poll status via getSandbox()
```

**4. Efficient Resource Cleanup:**
```typescript
// Always destroy when done to free resources
try {
  await exec({ sandboxId, code });
} finally {
  await destroy({ sandboxId });
}
```

### Appendix G: Glossary

- **MCP**: Model Context Protocol - standardized protocol for AI agent interactions
- **V8 Isolate**: Lightweight JavaScript execution environment with strong isolation
- **keepAlive**: Feature to maintain sandbox sessions between operations
- **Wrangler**: Cloudflare's CLI tool for managing Workers and secrets
- **Bearer Token**: Authentication token passed in HTTP Authorization header
- **Preview URL**: Public URL exposing services running in sandbox
- **Background Process**: Long-running process within sandbox independent of MCP connection
- **Cold Start**: Time to initialize new V8 isolate (~1ms for sandboxes)
- **Warm Start**: Time to reuse existing isolate (<100μs)

### Appendix H: References & Links

**Official Documentation:**
- Cloudflare Sandbox: https://developers.cloudflare.com/sandbox/
- Sandbox API Reference: https://developers.cloudflare.com/sandbox/api/
- Sandbox Lifecycle: https://developers.cloudflare.com/sandbox/api/lifecycle/
- Sandbox Options: https://developers.cloudflare.com/sandbox/configuration/sandbox-options/
- Sandbox SDK GitHub: https://github.com/cloudflare/sandbox-sdk

**Related Projects:**
- Model Context Protocol: https://modelcontextprotocol.io
- txt2mcp (reference implementation): Internal reference
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/

**Community Resources:**
- MCP Discord: [Link TBD]
- Cloudflare Discord: https://discord.gg/cloudflaredev
- GitHub Discussions: [Repository TBD]
- Stack Overflow tag: [cloudflare-sandbox]

---

## Document Control

**Version History:**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Nov 25, 2025 | Matthew Carey | Initial draft |
| 2.0 | Nov 25, 2025 | Matthew Carey | Updated with corrected tool specs, V8 isolate details, keepAlive features, preview URLs, enhanced technical architecture |
| 2.1 | Nov 25, 2025 | Matthew Carey | Added MCP Tool Definition Examples section |

**Review & Approval:**
- [ ] Technical Review - Pending
- [ ] Security Review - Pending
- [ ] Architecture Review - Pending
- [ ] Final Approval - Pending

**Next Review Date:** December 25, 2025

---

*This document is maintained in the sandbox-mcp repository and should be updated as requirements evolve. For questions or clarifications, please open a GitHub issue.*