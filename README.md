# Agent Ready

[![CI](https://github.com/prajapatimehul/agent-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/prajapatimehul/agent-ready/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agent-ready-cli.svg)](https://www.npmjs.com/package/agent-ready-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Generate **agent-first CLIs** from any OpenAPI spec — with built-in safety rails, schema introspection, and MCP server generation.

## Copy-Paste Prompt for AI Agents

Drop this into Claude Code, Codex, or any coding agent. Replace the placeholder with your OpenAPI spec path or URL. The agent will do everything — no docs needed.

```
Generate a CLI from my OpenAPI spec using agent-ready-cli.

Steps:
1. npx agent-ready-cli generate --spec <PATH_TO_MY_OPENAPI_SPEC> --name my-cli --out generated/my-cli.js
2. Run: node generated/my-cli.js --help-json   (to see all available operations)
3. Test every API group using: node generated/my-cli.js <group> <command> --base-url <MY_API_URL> --output json
4. Use --dry-run on mutating operations (POST/PUT/PATCH/DELETE) before executing
5. Use schema <group.command> to inspect parameters and body schema for any operation
6. Use --fields to limit response size and --sanitize for safety

Auth options: --token <bearer>, --api-key <key>, --basic <user:pass>
Or set env vars: AGENT_READY_TOKEN, AGENT_READY_API_KEY, AGENT_READY_BASE_URL

Test at least 10-15 operations across different groups. Report which ones work and which fail.
```

---

## Install

```bash
npm install -g agent-ready-cli
```

One command turns your API spec into a fully-featured CLI that both humans and AI agents can use:

```bash
npx agent-ready-cli generate --spec openapi.yaml --name my-cli --out my-cli.js
```

## Why Agent-First?

AI agents are increasingly the primary consumers of CLIs. They don't need GUIs — they need deterministic output, runtime-queryable schemas, and safety rails against hallucinations.

**Agent Ready** generates CLIs with all of this built in:

| Feature | What it does | Who it's for |
|---------|-------------|--------------|
| `--output json` | Machine-readable output (auto-detects TTY) | Agents + scripts |
| `--json '{...}'` | Raw API payload as single flag | Agents (no flag translation loss) |
| `--fields id,name` | Limit response fields (protect context window) | Agents |
| `--dry-run` | Preview HTTP request without executing | Safety rail |
| `--sanitize` | Strip prompt-injection patterns from responses | Security |
| `--help-json` | Machine-readable operation manifest | Agent discovery |
| `schema <op>` | Runtime schema introspection with body/response types | Agent self-service |
| `--page-all` | Auto-paginate with NDJSON streaming | Agents + scripts |
| `CONTEXT.md` | Auto-generated agent context file | LLM system prompts |
| `SKILL.md` | Structured skill file with YAML frontmatter | Agent frameworks |
| MCP server | JSON-RPC over stdio (Model Context Protocol) | Claude, Cursor, etc. |

## Battle-Tested

Generated CLIs have been validated against **11 real-world open-source SaaS platforms** with **2,012 operations**:

| SaaS | Category | Spec Format | Operations | Groups |
|------|----------|-------------|-----------|--------|
| [Mattermost](https://mattermost.com) (Slack alternative) | Communication | OpenAPI 3.0 | 425 | 40 |
| [Gitea](https://gitea.io) (Git hosting) | DevOps | Swagger 2.0 | 467 | 37 |
| [Kill Bill](https://killbill.io) (Billing) | Payments | Swagger 2.0 | 249 | 23 |
| [Lago](https://getlago.com) (Billing) | Payments | OpenAPI 3.1.0 | 156 | — |
| [Unleash](https://getunleash.io) (Feature flags) | DevOps | OpenAPI 3.0 | 167 | — |
| [Vikunja](https://vikunja.io) (Task management) | Productivity | Swagger 2.0 | 147 | 15 |
| [Chatwoot](https://chatwoot.com) (Customer engagement) | Communication | OpenAPI 3.0.4 | 137 | 30 |
| [Directus](https://directus.io) (Headless CMS) | CMS | OpenAPI 3.0 | 126 | — |
| [GrowthBook](https://growthbook.io) (A/B testing) | Analytics | OpenAPI 3.1.0 | 121 | 27 |
| [Coolify](https://coolify.io) (Self-hosting) | Deployment | OpenAPI 3.1.0 | 107 | 16 |
| [Memos](https://usememos.com) (Notes) | Productivity | OpenAPI 3.0.3 | 57 | — |

OpenAPI specs for all 11 are included in `examples/` so you can reproduce these results.

## Quick Start

```bash
npx agent-ready-cli generate --spec openapi.yaml --name my-api --out my-api.js
```

Try the included Petstore spec:

```bash
npx agent-ready-cli generate --spec examples/petstore/openapi.yaml --name pet-cli --out generated/pet-cli.js
```

## Generate from Any OpenAPI Spec

```bash
# From a local file
npx agent-ready-cli generate --spec path/to/openapi.yaml --name my-api --out generated/my-api.js

# From any of the included real-world specs
npx agent-ready-cli generate --spec examples/gitea/openapi.json --name gitea --out generated/gitea.js
npx agent-ready-cli generate --spec examples/mattermost/openapi.yaml --name mattermost --out generated/mattermost.js
npx agent-ready-cli generate --spec examples/killbill/swagger.json --name killbill --out generated/killbill.js
npx agent-ready-cli generate --spec examples/chatwoot/openapi.json --name chatwoot --out generated/chatwoot.js
npx agent-ready-cli generate --spec examples/coolify/openapi.yaml --name coolify --out generated/coolify.js
npx agent-ready-cli generate --spec examples/growthbook/openapi.yaml --name growthbook --out generated/growthbook.js
```

Supports **OpenAPI 3.0/3.1** and **Swagger 2.0** specs in YAML or JSON.

## What Gets Generated

For each spec, the generator produces:

```
generated/
  my-api.js          # Executable CLI (Commander.js, ESM)
  my-api-CONTEXT.md  # Agent context file for LLM system prompts
  my-api-SKILL.md    # Structured skill file with YAML frontmatter
```

The CLI automatically:
- Groups commands by OpenAPI tags (or path prefix fallback)
- Maps path/query/header/cookie parameters to `--kebab-case` flags
- Handles auth (Bearer, API key, Basic) via flags or env vars
- Validates inputs against hallucination patterns (path traversal, control chars, embedded query params)

## Agent-First Features

### Schema Introspection

Agents can self-serve API documentation at runtime — no need to stuff docs into system prompts:

```bash
my-api schema users.list-users
# Returns: method, path, parameters, bodySchema, responseSchema as JSON
```

### Raw JSON Payloads

Instead of translating nested structures into dozens of flags, agents pass the full API payload:

```bash
my-api users create-user --json '{
  "path": {"org": "my-org"},
  "body": {"login": "agent-user", "email": "agent@example.com"}
}'
```

### Context Window Protection

```bash
# Only return the fields you need
my-api repos list-repos --fields "id,name,description" --output json

# Stream pages as NDJSON instead of buffering
my-api repos list-repos --page-all
```

### Safety Rails

```bash
# Preview before mutating
my-api repos delete-repo --owner me --repo important-data --dry-run

# Strip prompt injection from API responses
my-api messages list --sanitize
```

### Input Hardening

Every generated CLI rejects:
- **Path traversal**: `../../.ssh` in resource IDs
- **Control characters**: invisible chars below ASCII 0x20
- **Embedded query params**: `fileId?fields=name` in IDs
- **Pre-encoded strings**: `%2e%2e` that would double-encode

### MCP Server Generation

Generate a Model Context Protocol server for use with Claude, Cursor, and other MCP-compatible agents:

```bash
npx agent-ready-cli generate --spec openapi.yaml --name my-api --out generated/my-api.js --mcp generated/my-api-mcp.js
```

The MCP server exposes every operation as a typed JSON-RPC tool over stdio — no shell escaping, no argument parsing ambiguity.

## Auth

Generated CLIs support multiple auth mechanisms with runtime precedence:

**CLI flags > env vars > profile config > spec default**

```bash
# Bearer token
my-api users list --token "ghp_xxxx"

# API key (placed in header, query, or cookie per spec)
my-api users list --api-key "sk-xxxx"

# Basic auth
my-api users list --basic "user:pass"

# Environment variables
export AGENT_READY_TOKEN="ghp_xxxx"
export AGENT_READY_API_KEY="sk-xxxx"
export AGENT_READY_BASE_URL="https://api.example.com"

# Config profiles
my-api users list --config ./config.json --profile staging
```

Config file format:

```json
{
  "profiles": {
    "default": { "baseUrl": "http://localhost:3000", "output": "json" },
    "staging": { "baseUrl": "https://staging.api.example.com", "token": "ghp_xxxx" }
  }
}
```

## Spec Compatibility

| Feature | OpenAPI 3.0/3.1 | Swagger 2.0 |
|---------|:---:|:---:|
| Path/query/header params | Yes | Yes |
| Request body | Yes | Yes (in:body) |
| Content types | Yes | Yes (consumes) |
| Security schemes (Bearer, API Key, Basic) | Yes | Yes |
| `$ref` resolution | Yes | Yes |
| Tag-based grouping | Yes | Yes |
| Default server URL | Yes | Yes (host + basePath) |
| Response schemas | Yes | Yes |
| Body schemas | Yes | Yes |

## Development

```bash
npm install
npm run build
npm test          # 42 tests
```

## License

MIT
