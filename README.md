# Agent Ready CLI

Generate enterprise-ready, product-specific CLIs directly from OpenAPI specs, then validate them against self-hosted local services.

## What this repo gives you

- `agent-ready generate` command to produce a runnable CLI from an OpenAPI file.
- Tag-based command grouping for large APIs (`customers`, `users`, `orders`, etc.).
- Local self-host example API (`examples/petstore/server.js`) to validate generated CLIs.
- Docker Compose flow for self-hosted testing (`docker-compose.yml`).
- Test suite that verifies OpenAPI parsing and generated CLI execution.

## Quick start

```bash
npm install
npm run build
```

Generate a product CLI from the included OpenAPI spec:

```bash
npm run generate:example
```

Generate a large grouped CLI from the enterprise fixture:

```bash
npm run generate:enterprise
```

Start the local self-hosted test API:

```bash
npm run dev:server
```

In another terminal, call generated commands locally:

```bash
node generated/pet-cli.js pet list-pets --base-url http://localhost:4010 --output json
node generated/pet-cli.js pet get-pet --pet-id p-1 --base-url http://localhost:4010 --output json
node generated/pet-cli.js pet create-pet --body '{"name":"Nova","species":"dog"}' --base-url http://localhost:4010 --output json
```

Check grouped commands in enterprise CLI:

```bash
node generated/enterprise-cli.js --help
node generated/enterprise-cli.js customers --help
node generated/enterprise-cli.js orders --help
```

## Generator usage

```bash
node dist/index.js generate --spec <path-to-openapi.yaml> --out generated/<your-cli>.js --name <your-cli>
```

Generated CLIs support:

- command groups derived from OpenAPI tags (or path prefix fallback)
- one subcommand per OpenAPI operation under each group
- path/query/header parameters mapped to `--kebab-case` flags
- JSON request body via `--body` for operations with `application/json` request body
- auth overrides with `--token` and `--api-key` (or env vars `AGENT_READY_TOKEN`, `AGENT_READY_API_KEY`)
- runtime precedence: CLI flags > env vars > profile config > spec default server
- output format `--output pretty|json`
- config profiles with `--config` and `--profile`

Example config file:

```json
{
  "profiles": {
    "default": {
      "baseUrl": "http://localhost:4010",
      "output": "json"
    },
    "staging": {
      "baseUrl": "https://staging.api.example.com",
      "token": "<token>"
    }
  }
}
```

Use it:

```bash
node generated/pet-cli.js pet list-pets --config ./config.json --profile default
```

## Docker self-host flow

Run the self-hosted sample service in Docker and test generated CLI against it:

```bash
npm run e2e:docker
```

Manual control:

```bash
npm run docker:up
npm run generate:example
node generated/pet-cli.js pet list-pets --base-url http://localhost:4010 --output json
npm run docker:down
```

## Local self-host workflow for product teams

1. Host your local API service (Docker Compose, k8s, or node service).
2. Export/maintain your OpenAPI file (`openapi.yaml`).
3. Run `agent-ready generate` to produce your CLI.
4. Run generated commands against your local base URL or profile config.
5. Add generated CLI smoke tests to CI.

## Development

```bash
npm test
npm run build
```
