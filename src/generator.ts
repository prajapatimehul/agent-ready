import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliAuth, CliOperation, CliParameter, CliSpec } from "./types.js";

function escapeForSingleQuote(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
    )}', in: '${param.in}', required: ${param.required}, isArray: ${param.isArray} }`;
  });

  return `[
${lines.join(",\n")}
    ]`;
}

function renderAuth(auth: CliAuth | undefined): string {
  if (!auth) {
    return "undefined";
  }

  const lines: string[] = [];
  if (auth.bearerHeaderName) {
    lines.push(`bearerHeaderName: '${escapeForSingleQuote(auth.bearerHeaderName)}'`);
  }
  if (auth.basic) {
    lines.push("basic: true");
  }
  if (auth.apiKey) {
    lines.push(
      `apiKey: { name: '${escapeForSingleQuote(auth.apiKey.name)}', in: '${auth.apiKey.in}' }`
    );
  }

  if (lines.length === 0) {
    return "undefined";
  }

  return `{ ${lines.join(", ")} }`;
}

function renderOperation(op: CliOperation): string {
  const optionLines = op.parameters
    .map((param) => {
      const synopsis = `--${param.cliName} <value>`;
      const description = `${param.in} parameter: ${param.name}`;
      return `    command.${requiredOptionMethod(param)}('${synopsis}', '${escapeForSingleQuote(description)}');`;
    })
    .join("\n");

  const bodyOption = op.hasBody ? "\n    command.option('--body <value>', 'Request body string');" : "";
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
        hasBody: ${op.hasBody},
        requestContentType: ${op.requestContentType ? `'${escapeForSingleQuote(op.requestContentType)}'` : "undefined"},
        auth: ${renderAuth(op.auth)},
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

  const basic = globalOptions.basic
    ?? process.env.AGENT_READY_BASIC
    ?? profile.basic
    ?? null;

  const output = globalOptions.output
    ?? process.env.AGENT_READY_OUTPUT
    ?? profile.output
    ?? 'pretty';

  return {
    baseUrl,
    token,
    apiKey,
    basic,
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

function appendQueryValues(searchParams, name, value, isArray) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValues(searchParams, name, item, isArray);
    }
    return;
  }

  if (isArray && typeof value === 'string') {
    for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
      searchParams.append(name, item);
    }
    return;
  }

  searchParams.append(name, String(value));
}

function buildQuery(operation, parameters, commandOptions, runtime) {
  const searchParams = new URLSearchParams();

  for (const param of parameters.filter((p) => p.in === 'query')) {
    const value = getOptionValue(commandOptions, param.cliName);
    appendQueryValues(searchParams, param.name, value, param.isArray);
  }

  if (runtime.apiKey && operation.auth?.apiKey && operation.auth.apiKey.in === 'query') {
    searchParams.append(operation.auth.apiKey.name, runtime.apiKey);
  }

  const queryString = searchParams.toString();
  return queryString ? '?' + queryString : '';
}

function encodeBasicCredentials(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function appendCookie(cookies, name, value) {
  if (value === undefined || value === null) {
    return;
  }
  cookies.push(name + '=' + encodeURIComponent(String(value)));
}

function buildHeaders(operation, parameters, commandOptions, runtime) {
  const headers = { Accept: 'application/json' };
  const cookiePairs = [];

  if (runtime.basic && operation.auth?.basic) {
    headers.Authorization = 'Basic ' + encodeBasicCredentials(runtime.basic);
  } else if (runtime.token) {
    const headerName = operation.auth?.bearerHeaderName ?? 'Authorization';
    headers[headerName] = 'Bearer ' + runtime.token;
  }

  if (runtime.apiKey) {
    if (operation.auth?.apiKey) {
      if (operation.auth.apiKey.in === 'header') {
        headers[operation.auth.apiKey.name] = runtime.apiKey;
      } else if (operation.auth.apiKey.in === 'cookie') {
        appendCookie(cookiePairs, operation.auth.apiKey.name, runtime.apiKey);
      }
    } else {
      headers['X-API-Key'] = runtime.apiKey;
    }
  }

  for (const param of parameters.filter((p) => p.in === 'header')) {
    const value = getOptionValue(commandOptions, param.cliName);
    if (value !== undefined) {
      headers[param.name] = String(value);
    }
  }

  for (const param of parameters.filter((p) => p.in === 'cookie')) {
    const value = getOptionValue(commandOptions, param.cliName);
    if (value !== undefined) {
      appendCookie(cookiePairs, param.name, value);
    }
  }

  if (cookiePairs.length > 0) {
    headers.Cookie = cookiePairs.join('; ');
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
  const query = buildQuery(operation, operation.parameters, commandOptions, runtime);
  const headers = buildHeaders(operation, operation.parameters, commandOptions, runtime);

  const url = runtime.baseUrl.replace(/\\/$/, '') + path + query;
  const init = {
    method: operation.method,
    headers
  };

  if (operation.hasBody && commandOptions.body !== undefined) {
    headers['Content-Type'] = operation.requestContentType ?? 'application/json';
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
  .option('--basic <userpass>', 'Basic auth credentials as user:pass')
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
