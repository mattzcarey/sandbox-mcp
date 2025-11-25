# Cloudflare Sandbox container with Claude Code pre-installed
FROM docker.io/cloudflare/sandbox:0.5.3

# Install Claude Code globally using bun
# Claude CLI will be at /root/.bun/bin/claude
RUN bun install -g @anthropic-ai/claude-code

# Create workspace directory
RUN mkdir -p /workspace

# Ensure /root/.bun/bin is in PATH
ENV PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Set working directory
WORKDIR /workspace
