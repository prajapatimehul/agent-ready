import type { CliSpec, HttpMethod } from "./types.js";

const MUTATING_METHODS: readonly HttpMethod[] = ["post", "put", "patch", "delete"];

export function renderContextMd(spec: CliSpec, cliName: string): string {
  const groupCounts = new Map<string, number>();
  for (const op of spec.operations) {
    groupCounts.set(op.groupName, (groupCounts.get(op.groupName) ?? 0) + 1);
  }

  const groupBullets = [...groupCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, count]) => `- **${group}** (${count} operation${count === 1 ? "" : "s"})`)
    .join("\n");

  return `# ${cliName} — AI Agent Context

> Auto-generated context file for AI agents using ${cliName}.

## Overview

${spec.title} (v${spec.version})

## Usage

\`\`\`bash
${cliName} <group> <command> [options]
\`\`\`

## Global Options

| Flag | Description |
|------|-------------|
| \`--base-url <url>\` | Base API URL |
| \`--token <token>\` | Bearer token |
| \`--api-key <key>\` | API key |
| \`--basic <userpass>\` | Basic auth (user:pass) |
| \`--output <format>\` | Output format: json\\|pretty (default: json in non-TTY, pretty in TTY) |
| \`--config <path>\` | Path to config JSON with profiles |
| \`--profile <name>\` | Profile name from config JSON |
| \`--dry-run\` | Print HTTP request without executing |
| \`--fields <fields>\` | Comma-separated response fields to include |
| \`--json <payload>\` | Full request as JSON: {path, query, headers, body} |
| \`--sanitize\` | Sanitize response strings to remove prompt-injection patterns |
| \`--page-all\` | Follow Link rel=next pagination, emit NDJSON |
| \`--help-json\` | Print all operations as machine-readable JSON |

## Introspection

\`\`\`bash
# List all operations for a group
${cliName} <group> --help

# Get operation schema as JSON
${cliName} schema <group.command>
\`\`\`

## Available Groups

${groupBullets}

## Agent Tips

- Always use \`--output json\` for structured parsing.
- Use \`--dry-run\` to preview requests before executing.
- Use \`--fields\` to reduce response noise.
- Use \`--json\` for programmatic request construction.
- Use \`schema <group.command>\` to discover parameters.
- For mutating operations (POST, PUT, PATCH, DELETE), always use \`--dry-run\` first and confirm with the user before executing.
- Use \`--sanitize\` to strip prompt-injection patterns from responses.
- Use \`--page-all\` for paginated endpoints to automatically follow all pages (emits NDJSON).
- Use \`--help-json\` to get a machine-readable manifest of all operations.
`;
}

export function renderSkillMd(spec: CliSpec, cliName: string): string {
  const operationIds = spec.operations
    .map((op) => `  - ${op.groupName}.${op.commandName}`)
    .join("\n");

  const operationSections = spec.operations
    .map((op) => {
      const heading = `### \`${op.groupName}.${op.commandName}\``;
      const mutatingBadge = (MUTATING_METHODS as readonly string[]).includes(op.method)
        ? "\n> **Mutating** — use `--dry-run` to preview before executing.\n"
        : "";
      const description = op.summary ?? `${op.method.toUpperCase()} ${op.path}`;

      let paramTable = "";
      if (op.parameters.length > 0) {
        const rows = op.parameters
          .map(
            (p) =>
              `| ${p.cliName} | ${p.in} | ${p.required ? "Yes" : "No"} | ${p.description ?? ""} |`
          )
          .join("\n");

        paramTable = `
| Parameter | Location | Required | Description |
|-----------|----------|----------|-------------|
${rows}`;
      }

      const bodyLines: string[] = [];
      if (op.hasBody) {
        bodyLines.push("Accepts request body (`--body` or via `--json`).");
      }
      if (op.bodySchemaHint) {
        bodyLines.push(`Body schema: ${op.bodySchemaHint}`);
      }

      const bodySection = bodyLines.length > 0 ? "\n" + bodyLines.join("\n") : "";

      return `${heading}\n${mutatingBadge}\n${description}\n${paramTable}${bodySection}`;
    })
    .join("\n\n");

  return `---
name: ${cliName}
version: ${spec.version}
description: ${spec.title}
operations:
${operationIds}
---

# ${cliName} Skill Reference

## Operations

${operationSections}
`;
}
