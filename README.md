# sandbox-mcp

Use this, it's better: https://github.com/ghostwriternr/sandbox-mcp

This is a fork with added Bearer token auth on the `/mcp` endpoint.

## Setup

```bash
npm install
wrangler secret put AUTH_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put PROXY_JWT_SECRET
npm run deploy
```
