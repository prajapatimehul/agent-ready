import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliOperation, CliParameter, CliSpec } from "./types.js";

function escapeForSingleQuote(value: string): string {
  return value.replace(/'/g, "\\'");
}

function requiredOptionMethod(param: CliParameter): string {
  return param.required ? "requiredOption" : "option";
}

function renderParamsArray(params: CliParameter[]): string {
  if (params.length === 0) {
    return "[]";
  }

  const lines = params.map((param) => {
    return `      { name: '${escapeForSingleQuote(param.name)}', cliName: '${escapeForSingleQuote(
      param.cliName
    )}', in: '${param.in}', required: ${param.required} }`;
  });

  return `[
${lines.join(",\n")}
    ]`;
}

function renderOperation(op: CliOperation): string {
  const optionLines = op.parameters
    .map((param) => {
      const synopsis = `--${param.cliName} <value>`;
      const description = `${param.in} parameter: ${param.name}`;
      return `    command.${requiredOptionMethod(param)}('${synopsis}', '${escapeForSingleQuote(description)}');`;
    })
    .join("\n");

  const bodyOption = op.hasJsonBody ? "\n    command.option('--body <json>', 'JSON request body string');" : "";
  const summary = escapeForSingleQuote(op.summary ?? `${op.method.toUpperCase()} ${op.path}`);

  return `
  {
    const command = groupCommand.command('${escapeForSingleQuote(op.commandName)}');
    command.description('${summary}');
${optionLines}${bodyOption}

    command.action(async (opts, cmd) => {
      const operation = {
        operationId: '${escapeForSingleQuote(op.operationId)}',
        method: '${op.method.toUpperCase()}',
        path: '${escapeForSingleQuote(op.path)}',
        hasJsonBody: ${op.hasJsonBody},
        parameters: ${renderParamsArray(op.parameters)}
      };

      await executeOperation(operation, opts, cmd.optsWithGlobals());
    });
  }
`;
}

function renderGroups(operations: CliOperation[]): string {
  const byGroup = new Map<string, CliOperation[]>();
  for (const operation of operations) {
    const current = byGroup.get(operation.groupName) ?? [];
    current.push(operation);
    byGroup.set(operation.groupName, current);
  }

  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupName, groupOperations]) => {
      const description = `${groupName} operations`;
      const renderedOperations = groupOperations.map(renderOperation).join("\n");

      return `
{
  const groupCommand = program.command('${escapeForSingleQuote(groupName)}');
  groupCommand.description('${escapeForSingleQuote(description)}');
${renderedOperations}
}
`;
    })
    .join("\n");
}

function renderProgram(spec: CliSpec, cliName: string): string {
  const groups = renderGroups(spec.operations);
  const defaultServer = spec.defaultServer ? `'${escapeForSingleQuote(spec.defaultServer)}'` : "undefined";

  return `#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { Command } from 'commander';

const DEFAULT_BASE_URL = process.env.AGENT_READY_BASE_URL ?? ${defaultServer};

function getOptionValue(options, cliName) {
  if (Object.prototype.hasOwnProperty.call(options, cliName)) {
    return options[cliName];
  }

  const camelCase = cliName.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  return options[camelCase];
}

function loadConfig(configPath) {
  if (!configPath) {
    return null;
  }

  if (!existsSync(configPath)) {
    throw new Error('Config file not found: ' + configPath);
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Config must be a JSON object');
  }

  return parsed;
}

function pickProfile(config, profileName) {
  if (!config) {
    return null;
  }

  const profiles = config.profiles;
  if (!profiles || typeof profiles !== 'object') {
    return null;
  }

  if (profileName && profiles[profileName] && typeof profiles[profileName] === 'object') {
    return profiles[profileName];
  }

  if (profiles.default && typeof profiles.default === 'object') {
    return profiles.default;
  }

  return null;
}

function resolveRuntimeSettings(globalOptions) {
  const configPath = globalOptions.config ?? process.env.AGENT_READY_CONFIG;
  const config = loadConfig(configPath);
  const profileName = globalOptions.profile ?? process.env.AGENT_READY_PROFILE;
  const profile = pickProfile(config, profileName) ?? {};

  const baseUrl = globalOptions.baseUrl
    ?? process.env.AGENT_READY_BASE_URL
    ?? profile.baseUrl
    ?? DEFAULT_BASE_URL;

  const token = globalOptions.token
    ?? process.env.AGENT_READY_TOKEN
    ?? profile.token
    ?? null;

  const apiKey = globalOptions.apiKey
    ?? process.env.AGENT_READY_API_KEY
    ?? profile.apiKey
    ?? null;

  const output = globalOptions.output
    ?? process.env.AGENT_READY_OUTPUT
    ?? profile.output
    ?? 'pretty';

  return {
    baseUrl,
    token,
    apiKey,
    output
  };
}

function normalizePath(pathTemplate, commandOptions, parameters) {
  let path = pathTemplate;
  for (const param of parameters.filter((p) => p.in === 'path')) {
    const value = getOptionValue(commandOptions, param.cliName);
    path = path.replace(
      new RegExp('\\\\{' + param.name + '\\\\}', 'g'),
      encodeURIComponent(String(value))
    );
  }
  return path;
}

function buildQuery(parameters, commandOptions) {
  const searchParams = new URLSearchParams();

  for (const param of parameters.filter((p) => p.in === 'query')) {
    const value = getOptionValue(commandOptions, param.cliName);
    if (value !== undefined) {
      searchParams.append(param.name, String(value));
    }
  }

  const queryString = searchParams.toString();
  return queryString ? '?' + queryString : '';
}

function buildHeaders(parameters, commandOptions, runtime) {
  const headers = { Accept: 'application/json' };

  if (runtime.token) {
    headers.Authorization = 'Bearer ' + runtime.token;
  }

  if (runtime.apiKey) {
    headers['X-API-Key'] = runtime.apiKey;
  }

  for (const param of parameters.filter((p) => p.in === 'header')) {
    const value = getOptionValue(commandOptions, param.cliName);
    if (value !== undefined) {
      headers[param.name] = String(value);
    }
  }

  return headers;
}

function printResult(data, format) {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (Array.isArray(data)) {
    console.table(data);
    return;
  }

  if (data !== null && typeof data === 'object') {
    console.table(data);
    return;
  }

  console.log(data);
}

async function executeOperation(operation, commandOptions, globalOptions) {
  const runtime = resolveRuntimeSettings(globalOptions);
  if (!runtime.baseUrl) {
    throw new Error('No base URL configured. Use --base-url, env AGENT_READY_BASE_URL, or config profile.');
  }

  const path = normalizePath(operation.path, commandOptions, operation.parameters);
  const query = buildQuery(operation.parameters, commandOptions);
  const headers = buildHeaders(operation.parameters, commandOptions, runtime);

  const url = runtime.baseUrl.replace(/\\/$/, '') + path + query;
  const init = {
    method: operation.method,
    headers
  };

  if (operation.hasJsonBody && commandOptions.body) {
    headers['Content-Type'] = 'application/json';
    init.body = commandOptions.body;
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') ?? '';

  const parsed = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    console.error(JSON.stringify({
      error: 'Request failed',
      status: response.status,
      operationId: operation.operationId,
      response: parsed
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  printResult(parsed, runtime.output);
}

const program = new Command();

program
  .name('${escapeForSingleQuote(cliName)}')
  .description('Generated CLI for ${escapeForSingleQuote(spec.title)}')
  .version('${escapeForSingleQuote(spec.version)}')
  .option('--base-url <url>', 'Base API URL')
  .option('--token <token>', 'Bearer token')
  .option('--api-key <key>', 'API key')
  .option('--output <format>', 'Output format: json|pretty', 'pretty')
  .option('--config <path>', 'Path to config JSON with profiles')
  .option('--profile <name>', 'Profile name from config JSON');

${groups}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
}

export async function writeGeneratedCli(spec: CliSpec, cliName: string, outPath: string): Promise<void> {
  const output = renderProgram(spec, cliName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, output, { encoding: "utf8", mode: 0o755 });
}
