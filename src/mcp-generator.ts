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
    parameters: ${renderParamsArray(op.parameters)}
  }`;
}

function renderOperationRegistry(operations: CliOperation[]): string {
  const entries = operations.map(renderOperationEntry).join(",\n");
  return `const OPERATIONS = {\n${entries}\n};\n`;
}

function renderToolRegistration(op: CliOperation): string {
  const key = escapeForSingleQuote(operationKey(op));
  const toolName = `${op.groupName}_${op.commandName}`;
  const summary = escapeForSingleQuote(op.summary ?? `${op.method.toUpperCase()} ${op.path}`);

  const propertyLines: string[] = [];
  const requiredNames: string[] = [];

  for (const param of op.parameters) {
    const desc = param.description
      ? escapeForSingleQuote(param.description)
      : escapeForSingleQuote(`${param.in} parameter: ${param.name}`);
    propertyLines.push(
      `      '${escapeForSingleQuote(param.cliName)}': { type: 'string', description: '${desc}' }`
    );
    if (param.required) {
      requiredNames.push(`'${escapeForSingleQuote(param.cliName)}'`);
    }
  }

  if (op.hasBody) {
    const bodyDesc = op.bodySchemaHint
      ? escapeForSingleQuote(`Request body (JSON). Schema hint: ${op.bodySchemaHint}`)
      : "Request body (JSON string)";
    propertyLines.push(`      'body': { type: 'string', description: '${bodyDesc}' }`);
  }

  const propertiesBlock = propertyLines.length > 0
    ? `{\n${propertyLines.join(",\n")}\n    }`
    : "{}";

  const requiredBlock = requiredNames.length > 0
    ? `[${requiredNames.join(", ")}]`
    : "[]";

  return `  server.tool(
    '${escapeForSingleQuote(toolName)}',
    '${summary}',
    {
      type: 'object',
      properties: ${propertiesBlock},
      required: ${requiredBlock}
    },
    async (args) => {
      const op = OPERATIONS['${key}'];
      try {
        const result = await executeOperation(op, args);
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + (err instanceof Error ? err.message : String(err)) }], isError: true };
      }
    }
  );`;
}

export function renderMcpServer(spec: CliSpec, cliName: string): string {
  const registry = renderOperationRegistry(spec.operations);
  const toolRegistrations = spec.operations.map(renderToolRegistration).join("\n\n");
  const defaultServer = spec.defaultServer ? `'${escapeForSingleQuote(spec.defaultServer)}'` : "undefined";

  return `#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

${registry}
const BASE_URL = process.env.AGENT_READY_BASE_URL ?? ${defaultServer};
const TOKEN = process.env.AGENT_READY_TOKEN ?? null;
const API_KEY = process.env.AGENT_READY_API_KEY ?? null;
const BASIC = process.env.AGENT_READY_BASIC ?? null;

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

function normalizePath(pathTemplate, args, parameters) {
  let path = pathTemplate;
  for (const param of parameters.filter((p) => p.in === 'path')) {
    const value = args[param.cliName];
    if (value === undefined || value === null) {
      throw new Error('Missing required path parameter: ' + param.cliName);
    }
    validateResourceId(value, param.cliName);
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

function buildQuery(operation, parameters, args) {
  const searchParams = new URLSearchParams();

  for (const param of parameters.filter((p) => p.in === 'query')) {
    const value = args[param.cliName];
    if (value !== undefined && value !== null) {
      rejectControlChars(value, param.cliName);
    }
    appendQueryValues(searchParams, param.name, value, param.isArray);
  }

  if (API_KEY && operation.auth?.apiKey && operation.auth.apiKey.in === 'query') {
    searchParams.append(operation.auth.apiKey.name, API_KEY);
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

function buildHeaders(operation, parameters, args) {
  const headers = { Accept: 'application/json' };
  const cookiePairs = [];

  if (BASIC && operation.auth?.basic) {
    headers.Authorization = 'Basic ' + encodeBasicCredentials(BASIC);
  } else if (TOKEN) {
    const headerName = operation.auth?.bearerHeaderName ?? 'Authorization';
    headers[headerName] = 'Bearer ' + TOKEN;
  }

  if (API_KEY) {
    if (operation.auth?.apiKey) {
      if (operation.auth.apiKey.in === 'header') {
        headers[operation.auth.apiKey.name] = API_KEY;
      } else if (operation.auth.apiKey.in === 'cookie') {
        appendCookie(cookiePairs, operation.auth.apiKey.name, API_KEY);
      }
    } else {
      headers['X-API-Key'] = API_KEY;
    }
  }

  for (const param of parameters.filter((p) => p.in === 'header')) {
    const value = args[param.cliName];
    if (value !== undefined) {
      rejectControlChars(value, param.cliName);
      headers[param.name] = String(value);
    }
  }

  for (const param of parameters.filter((p) => p.in === 'cookie')) {
    const value = args[param.cliName];
    if (value !== undefined) {
      appendCookie(cookiePairs, param.name, value);
    }
  }

  if (cookiePairs.length > 0) {
    headers.Cookie = cookiePairs.join('; ');
  }

  return headers;
}

async function executeOperation(operation, args) {
  if (!BASE_URL) {
    throw new Error('No base URL configured. Set AGENT_READY_BASE_URL environment variable.');
  }

  const path = normalizePath(operation.path, args, operation.parameters);
  const query = buildQuery(operation, operation.parameters, args);
  const headers = buildHeaders(operation, operation.parameters, args);

  const url = BASE_URL.replace(/\\/$/, '') + path + query;
  const init = {
    method: operation.method,
    headers
  };

  if (operation.hasBody && args.body !== undefined) {
    headers['Content-Type'] = operation.requestContentType ?? 'application/json';
    init.body = args.body;
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') ?? '';

  const parsed = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(JSON.stringify({
      error: 'Request failed',
      status: response.status,
      operationId: operation.operationId,
      response: parsed
    }, null, 2));
  }

  return parsed;
}

const server = new McpServer({
  name: '${escapeForSingleQuote(cliName)}',
  version: '${escapeForSingleQuote(spec.version)}'
});

${toolRegistrations}

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

export async function writeMcpServer(spec: CliSpec, cliName: string, outPath: string): Promise<void> {
  const output = renderMcpServer(spec, cliName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, output, { encoding: "utf8", mode: 0o755 });
}
