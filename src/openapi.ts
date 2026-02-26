import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CliOperation, CliParameter, CliSpec, HttpMethod } from "./types.js";

const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "body";
  required?: boolean;
  description?: string;
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Array<OpenApiParameter | OpenApiRef>;
  requestBody?: {
    content?: Record<string, unknown>;
  } | OpenApiRef;
}

interface OpenApiPathItem {
  parameters?: Array<OpenApiParameter | OpenApiRef>;
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiRef {
  $ref: string;
}

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
  };
  servers?: Array<{ url?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, { content?: Record<string, unknown> }>;
  };
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function fallbackOperationId(method: HttpMethod, path: string): string {
  const normalizedPath = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .join("-");
  return `${method}-${normalizedPath || "root"}`;
}

function firstStaticSegment(path: string): string {
  const segment = path
    .split("/")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("{"));
  return segment ? toKebabCase(segment) : "misc";
}

function deriveGroupName(path: string, tags: string[] | undefined): string {
  const primaryTag = tags?.find((tag) => tag.trim().length > 0);
  if (primaryTag) {
    return toKebabCase(primaryTag);
  }
  return firstStaticSegment(path);
}

function maybeStripGroupPrefix(commandName: string, groupName: string): string {
  if (commandName.startsWith(`${groupName}-`) && commandName.length > groupName.length + 1) {
    return commandName.slice(groupName.length + 1);
  }
  return commandName;
}

function uniqueCommandName(groupName: string, commandName: string, seen: Set<string>, method: HttpMethod): string {
  const key = `${groupName}/${commandName}`;
  if (!seen.has(key)) {
    seen.add(key);
    return commandName;
  }

  const withMethod = `${commandName}-${method}`;
  const methodKey = `${groupName}/${withMethod}`;
  if (!seen.has(methodKey)) {
    seen.add(methodKey);
    return withMethod;
  }

  let suffix = 2;
  while (seen.has(`${groupName}/${withMethod}-${suffix}`)) {
    suffix += 1;
  }
  const fallback = `${withMethod}-${suffix}`;
  seen.add(`${groupName}/${fallback}`);
  return fallback;
}

function isRef(value: unknown): value is OpenApiRef {
  return Boolean(
    value && typeof value === "object" && "$ref" in value && typeof (value as { $ref: unknown }).$ref === "string"
  );
}

function resolveLocalRef(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return null;
  }

  const pointer = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = document;
  for (const part of pointer) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function resolveParameter(document: OpenApiDocument, value: OpenApiParameter | OpenApiRef): OpenApiParameter | null {
  if (!isRef(value)) {
    return value;
  }
  const resolved = resolveLocalRef(document, value.$ref);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const candidate = resolved as Partial<OpenApiParameter>;
  if (typeof candidate.name !== "string" || typeof candidate.in !== "string") {
    return null;
  }
  if (candidate.in !== "path" && candidate.in !== "query" && candidate.in !== "header" && candidate.in !== "cookie" && candidate.in !== "body") {
    return null;
  }
  return {
    name: candidate.name,
    in: candidate.in,
    required: candidate.required,
    description: candidate.description
  };
}

function resolveRequestBody(
  document: OpenApiDocument,
  requestBody: OpenApiOperation["requestBody"]
): { content?: Record<string, unknown> } | null {
  if (!requestBody) {
    return null;
  }
  if (!isRef(requestBody)) {
    return requestBody;
  }
  const resolved = resolveLocalRef(document, requestBody.$ref);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  return resolved as { content?: Record<string, unknown> };
}

function mergeParameters(document: OpenApiDocument, pathParams: OpenApiPathItem["parameters"], opParams: OpenApiOperation["parameters"]): CliParameter[] {
  const allParams = [...(pathParams ?? []), ...(opParams ?? [])]
    .map((param) => resolveParameter(document, param))
    .filter((param): param is OpenApiParameter => param !== null);

  const deduped = new Map<string, OpenApiParameter>();
  for (const param of allParams) {
    deduped.set(`${param.in}:${param.name}`, param);
  }

  return [...deduped.values()]
    .map(toCliParameter)
    .filter((param): param is CliParameter => param !== null)
    .sort((a, b) => {
      const inCmp = a.in.localeCompare(b.in);
      if (inCmp !== 0) {
        return inCmp;
      }
      return a.cliName.localeCompare(b.cliName);
    });
}

function toCliParameter(param: OpenApiParameter): CliParameter | null {
  if (param.in === "cookie" || param.in === "body") {
    return null;
  }

  return {
    name: param.name,
    cliName: toKebabCase(param.name),
    in: param.in,
    required: Boolean(param.required),
    description: param.description
  };
}

export async function readOpenApiDocument(specPath: string): Promise<OpenApiDocument> {
  const raw = await readFile(specPath, "utf8");
  const ext = extname(specPath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(raw) as OpenApiDocument;
  }

  return JSON.parse(raw) as OpenApiDocument;
}

function hasSwagger2BodyParam(document: OpenApiDocument, pathParams: OpenApiPathItem["parameters"], opParams: OpenApiOperation["parameters"]): boolean {
  const allParams = [...(pathParams ?? []), ...(opParams ?? [])];
  for (const raw of allParams) {
    const param = resolveParameter(document, raw);
    if (param && param.in === "body") {
      return true;
    }
  }
  return false;
}

function deriveDefaultServer(document: OpenApiDocument): string | undefined {
  if (document.servers?.[0]?.url) {
    return document.servers[0].url;
  }

  if (document.host) {
    const scheme = document.schemes?.[0] ?? "https";
    const basePath = document.basePath ?? "";
    return `${scheme}://${document.host}${basePath}`;
  }

  return undefined;
}

export function normalizeOpenApi(document: OpenApiDocument): CliSpec {
  const operations: CliOperation[] = [];
  const paths = document.paths ?? {};
  const seenCommandNames = new Set<string>();
  const globalConsumes = document.consumes ?? [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) {
        continue;
      }

      const operationId = operation.operationId ?? fallbackOperationId(method, path);
      const groupName = deriveGroupName(path, operation.tags);
      const baseCommand = maybeStripGroupPrefix(toKebabCase(operationId), groupName);
      const commandName = uniqueCommandName(groupName, baseCommand, seenCommandNames, method);
      const params = mergeParameters(document, pathItem.parameters, operation.parameters);
      const requestBody = resolveRequestBody(document, operation.requestBody);
      const hasOas3Body = Boolean(requestBody?.content?.["application/json"]);
      const hasSwagger2Body = hasSwagger2BodyParam(document, pathItem.parameters, operation.parameters)
        && globalConsumes.includes("application/json");
      const hasJsonBody = hasOas3Body || hasSwagger2Body;

      operations.push({
        operationId,
        groupName,
        commandName,
        method,
        path,
        tags: operation.tags ?? [],
        summary: operation.summary ?? operation.description,
        hasJsonBody,
        parameters: params
      });
    }
  }

  operations.sort((a, b) => {
    const groupCmp = a.groupName.localeCompare(b.groupName);
    if (groupCmp !== 0) {
      return groupCmp;
    }
    const commandCmp = a.commandName.localeCompare(b.commandName);
    if (commandCmp !== 0) {
      return commandCmp;
    }
    const methodCmp = a.method.localeCompare(b.method);
    if (methodCmp !== 0) {
      return methodCmp;
    }
    return a.path.localeCompare(b.path);
  });

  return {
    title: document.info?.title ?? "Generated API CLI",
    version: document.info?.version ?? "0.0.0",
    defaultServer: deriveDefaultServer(document),
    operations
  };
}
