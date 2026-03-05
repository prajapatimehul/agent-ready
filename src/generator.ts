import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliAuth, CliOperation, CliParameter, CliSpec } from "./types.js";
import { renderContextMd, renderSkillMd } from "./context.js";
import { SANITIZE_TEMPLATE } from "./sanitize-template.js";

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

function operationKey(op: CliOperation): string {
  return `${op.groupName}.${op.commandName}`;
}

function renderOperationEntry(op: CliOperation): string {
  const summary = escapeForSingleQuote(op.summary ?? `${op.method.toUpperCase()} ${op.path}`);
  const bodySchemaHint = op.bodySchemaHint ? `'${escapeForSingleQuote(op.bodySchemaHint)}'` : "undefined";

  return `  '${escapeForSingleQuote(operationKey(op))}': {
    operationId: '${escapeForSingleQuote(op.operationId)}',
    method: '${op.method.toUpperCase()}',
    path: '${escapeForSingleQuote(op.path)}',
    summary: '${summary}',
    hasBody: ${op.hasBody},
    requestContentType: ${op.requestContentType ? `'${escapeForSingleQuote(op.requestContentType)}'` : "undefined"},
    bodySchemaHint: ${bodySchemaHint},
    auth: ${renderAuth(op.auth)},
    parameters: ${renderParamsArray(op.parameters)},
    bodySchema: ${op.bodySchema ? JSON.stringify(op.bodySchema) : "undefined"},
    responseSchema: ${op.responseSchema ? JSON.stringify(op.responseSchema) : "undefined"}
  }`;
}

function renderOperationRegistry(operations: CliOperation[]): string {
  const entries = operations.map(renderOperationEntry).join(",\n");
  return `const OPERATIONS = {\n${entries}\n};\n`;
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
  const key = escapeForSingleQuote(operationKey(op));

  return `
  {
    const command = groupCommand.command('${escapeForSingleQuote(op.commandName)}');
    command.description('${summary}');
${optionLines}${bodyOption}

    command.action(async (opts, cmd) => {
      await executeOperation(OPERATIONS['${key}'], opts, cmd.optsWithGlobals());
    });
  }
`;
}

function renderGroups(operations: CliOperation[]): { code: string; groupNames: Set<string> } {
  const byGroup = new Map<string, CliOperation[]>();
  for (const operation of operations) {
    const current = byGroup.get(operation.groupName) ?? [];
    current.push(operation);
    byGroup.set(operation.groupName, current);
  }

  const code = [...byGroup.entries()]
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

  return { code, groupNames: new Set(byGroup.keys()) };
}

function renderSchemaCommand(groupNames: Set<string>): string {
  const cmdName = groupNames.has('schema') ? 'op-schema' : 'schema';
  return `
{
  const schemaCmd = program.command('${cmdName}');
  schemaCmd.description('Print operation metadata as JSON');
  schemaCmd.argument('<operation>', 'Operation as group.command');
  schemaCmd.action((name) => {
    const op = OPERATIONS[name];
    if (!op) {
      const available = Object.keys(OPERATIONS).join(', ');
      console.error('Unknown operation: ' + name + '\\nAvailable: ' + available);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(op, null, 2));
  });
}
`;
}

function renderProgram(spec: CliSpec, cliName: string): string {
  const registry = renderOperationRegistry(spec.operations);
  const { code: groups, groupNames } = renderGroups(spec.operations);
  const schemaCommand = renderSchemaCommand(groupNames);
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
    ?? (process.stdout.isTTY ? 'pretty' : 'json');

  const dryRun = Boolean(globalOptions.dryRun);
  const fields = globalOptions.fields ?? null;
  const sanitize = Boolean(globalOptions.sanitize);
  const pageAll = Boolean(globalOptions.pageAll);

  return {
    baseUrl,
    token,
    apiKey,
    basic,
    output,
    dryRun,
    fields,
    sanitize,
    pageAll
  };
}

function rejectControlChars(value, flagName) {
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) {
      throw new Error('Invalid control character in ' + flagName + ' (charCode ' + code + ')');
    }
  }
}

function validateResourceId(value, flagName) {
  rejectControlChars(value, flagName);
  const str = String(value);
  if (/[?#%]/.test(str)) {
    throw new Error('Invalid character in ' + flagName + ': must not contain ?, #, or %');
  }
  const segments = str.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error('Path traversal not allowed in ' + flagName);
    }
  }
}

function normalizePath(pathTemplate, commandOptions, parameters) {
  let path = pathTemplate;
  for (const param of parameters.filter((p) => p.in === 'path')) {
    const value = getOptionValue(commandOptions, param.cliName);
    validateResourceId(value, '--' + param.cliName);
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
    if (value !== undefined && value !== null) {
      rejectControlChars(value, '--' + param.cliName);
    }
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
      rejectControlChars(value, '--' + param.cliName);
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

function getNestedValue(obj, path) {
  let current = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function filterFields(data, fieldList) {
  if (!fieldList) {
    return data;
  }

  const fields = fieldList.split(',').map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0) {
    return data;
  }

  function filterOne(item) {
    if (item === null || item === undefined || typeof item !== 'object') {
      return item;
    }
    const result = {};
    for (const field of fields) {
      const value = getNestedValue(item, field);
      if (value !== undefined) {
        setNestedValue(result, field, value);
      }
    }
    return result;
  }

  if (Array.isArray(data)) {
    return data.map(filterOne);
  }

  return filterOne(data);
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

function applyJsonPayload(commandOptions, parameters, jsonString) {
  const payload = JSON.parse(jsonString);
  const merged = Object.assign({}, commandOptions);

  if (payload.path && typeof payload.path === 'object') {
    for (const param of parameters.filter((p) => p.in === 'path')) {
      if (payload.path[param.name] !== undefined) {
        merged[param.cliName] = payload.path[param.name];
      }
    }
  }

  if (payload.query && typeof payload.query === 'object') {
    for (const param of parameters.filter((p) => p.in === 'query')) {
      if (payload.query[param.name] !== undefined) {
        merged[param.cliName] = payload.query[param.name];
      }
    }
  }

  if (payload.headers && typeof payload.headers === 'object') {
    for (const param of parameters.filter((p) => p.in === 'header')) {
      if (payload.headers[param.name] !== undefined) {
        merged[param.cliName] = payload.headers[param.name];
      }
    }
  }

  if (payload.body !== undefined) {
    merged.body = typeof payload.body === 'object' ? JSON.stringify(payload.body) : payload.body;
  }

  return merged;
}

${SANITIZE_TEMPLATE}

function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\\s*;\\s*rel\\s*=\\s*"next"/);
    if (match) return match[1];
  }
  return null;
}

async function executeOperation(operation, commandOptions, globalOptions) {
  const runtime = resolveRuntimeSettings(globalOptions);

  if (globalOptions.json) {
    commandOptions = applyJsonPayload(commandOptions, operation.parameters, globalOptions.json);
  }

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

  if (runtime.dryRun) {
    console.log(JSON.stringify({ dryRun: true, method: init.method, url, headers: init.headers, body: init.body ?? null }, null, 2));
    return;
  }

  if (runtime.pageAll) {
    let nextUrl = url;
    while (nextUrl) {
      const pageResponse = await fetch(nextUrl, init);
      const pageCt = pageResponse.headers.get('content-type') ?? '';
      const pageData = pageCt.includes('application/json')
        ? await pageResponse.json()
        : await pageResponse.text();

      if (!pageResponse.ok) {
        console.error(JSON.stringify({
          error: 'Request failed',
          status: pageResponse.status,
          operationId: operation.operationId,
          response: pageData
        }, null, 2));
        process.exitCode = 1;
        return;
      }

      let result = filterFields(pageData, runtime.fields);
      if (runtime.sanitize) result = sanitizeResponse(result);
      console.log(JSON.stringify(result));

      const linkHeader = pageResponse.headers.get('link');
      nextUrl = parseLinkNext(linkHeader);
    }
    return;
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

  let filtered = filterFields(parsed, runtime.fields);
  if (runtime.sanitize) filtered = sanitizeResponse(filtered);
  printResult(filtered, runtime.output);
}

${registry}
const program = new Command();

program
  .name('${escapeForSingleQuote(cliName)}')
  .description('Generated CLI for ${escapeForSingleQuote(spec.title)}')
  .version('${escapeForSingleQuote(spec.version)}')
  .option('--base-url <url>', 'Base API URL')
  .option('--token <token>', 'Bearer token')
  .option('--api-key <key>', 'API key')
  .option('--basic <userpass>', 'Basic auth credentials as user:pass')
  .option('--output <format>', 'Output format: json|pretty (default: json in non-TTY, pretty in TTY)')
  .option('--config <path>', 'Path to config JSON with profiles')
  .option('--profile <name>', 'Profile name from config JSON')
  .option('--dry-run', 'Print the HTTP request without executing it')
  .option('--fields <fields>', 'Comma-separated response fields to include')
  .option('--json <payload>', 'Full request as JSON: {path, query, headers, body}')
  .option('--sanitize', 'Sanitize response strings to remove prompt-injection patterns')
  .option('--page-all', 'Follow Link rel=next pagination, emit NDJSON (one JSON per line)')
  .option('--help-json', 'Print all operations as machine-readable JSON');

if (process.argv.includes('--help-json')) {
  console.log(JSON.stringify({
    name: '${escapeForSingleQuote(cliName)}',
    version: '${escapeForSingleQuote(spec.version)}',
    description: '${escapeForSingleQuote(spec.title)}',
    operations: OPERATIONS
  }, null, 2));
  process.exit(0);
}

${groups}

${schemaCommand}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
}

export interface GenerateOptions {
  noContext?: boolean;
}

export async function writeGeneratedCli(spec: CliSpec, cliName: string, outPath: string, options?: GenerateOptions): Promise<void> {
  const output = renderProgram(spec, cliName);
  const dir = dirname(outPath);
  await mkdir(dir, { recursive: true });
  await writeFile(outPath, output, { encoding: "utf8", mode: 0o755 });

  if (!options?.noContext) {
    await writeFile(join(dir, `${cliName}-CONTEXT.md`), renderContextMd(spec, cliName), "utf8");
    await writeFile(join(dir, `${cliName}-SKILL.md`), renderSkillMd(spec, cliName), "utf8");
  }
}
