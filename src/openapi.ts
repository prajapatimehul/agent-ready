import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CliAuth, CliOperation, CliParameter, CliSpec, HttpMethod } from "./types.js";

const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete", "head", "options"];

type ParameterLocation = "path" | "query" | "header" | "cookie" | "body";

interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
  };
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  consumes?: string[];
  parameters?: Array<OpenApiParameter | OpenApiRef>;
  requestBody?: {
    content?: Record<string, unknown>;
    required?: boolean;
  } | OpenApiRef;
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiPathItem {
  parameters?: Array<OpenApiParameter | OpenApiRef>;
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
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
  security?: Array<Record<string, string[]>>;
  paths?: Record<string, OpenApiPathItem>;
  securityDefinitions?: Record<string, OpenApiSecurityScheme>;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, { content?: Record<string, unknown> }>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

interface OpenApiSecurityScheme {
  type?: string;
  name?: string;
  in?: "header" | "query" | "cookie";
  scheme?: string;
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
    in: candidate.in as ParameterLocation,
    required: candidate.required,
    description: candidate.description,
    schema: candidate.schema
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
  if (param.in === "body") {
    return null;
  }

  return {
    name: param.name,
    cliName: toKebabCase(param.name),
    in: param.in,
    required: Boolean(param.required),
    isArray: param.schema?.type === "array" || param.name.endsWith("[]"),
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

function getPreferredContentType(contentTypes: string[]): string | undefined {
  if (contentTypes.length === 0) {
    return undefined;
  }

  const exactJson = contentTypes.find((value) => value.toLowerCase() === "application/json");
  if (exactJson) {
    return exactJson;
  }

  const jsonLike = contentTypes.find((value) => value.toLowerCase().includes("json"));
  if (jsonLike) {
    return jsonLike;
  }

  return contentTypes[0];
}

function findBodySchema(
  requestBody: { content?: Record<string, unknown> } | null,
  document: OpenApiDocument,
  pathParams: OpenApiPathItem["parameters"],
  opParams: OpenApiOperation["parameters"]
): unknown | undefined {
  if (requestBody?.content) {
    for (const ct of Object.values(requestBody.content)) {
      const schema = (ct as { schema?: unknown })?.schema;
      if (schema) {
        return schema;
      }
    }
  }

  const allParams = [...(pathParams ?? []), ...(opParams ?? [])];
  for (const raw of allParams) {
    const param = resolveParameter(document, raw);
    if (param && param.in === "body") {
      const schema = (param as { schema?: unknown }).schema;
      if (schema) {
        return schema;
      }
    }
  }

  return undefined;
}

function extractBodySchemaHint(
  requestBody: { content?: Record<string, unknown> } | null,
  document: OpenApiDocument,
  pathParams: OpenApiPathItem["parameters"],
  opParams: OpenApiOperation["parameters"]
): string | undefined {
  const schema = findBodySchema(requestBody, document, pathParams, opParams);
  if (!schema) {
    return undefined;
  }
  if (isRef(schema)) {
    const refParts = (schema as OpenApiRef).$ref.split("/");
    return refParts[refParts.length - 1];
  }
  if (typeof schema === "object" && "type" in schema) {
    return (schema as { type: string }).type;
  }
  return undefined;
}

function resolveSchema(
  document: OpenApiDocument,
  schema: unknown,
  visited?: Set<string>
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }

  const safeVisited = visited ?? new Set<string>();

  if (isRef(schema)) {
    const ref = (schema as OpenApiRef).$ref;
    if (safeVisited.has(ref)) {
      return { $circular: ref } as Record<string, unknown>;
    }
    safeVisited.add(ref);
    const resolved = resolveLocalRef(document, ref);
    return resolveSchema(document, resolved, safeVisited);
  }

  const obj = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if (obj.type) result.type = obj.type;
  if (obj.format) result.format = obj.format;
  if (obj.description) result.description = obj.description;
  if (obj.enum) result.enum = obj.enum;
  if (obj.required) result.required = obj.required;

  if (obj.properties && typeof obj.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      props[key] = resolveSchema(document, value, safeVisited) ?? {};
    }
    result.properties = props;
  }

  if (obj.items) {
    result.items = resolveSchema(document, obj.items, safeVisited);
  }

  for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
    if (Array.isArray(obj[combiner])) {
      result[combiner] = (obj[combiner] as unknown[]).map(
        (s) => resolveSchema(document, s, safeVisited) ?? {}
      );
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractBodySchema(
  requestBody: { content?: Record<string, unknown> } | null,
  document: OpenApiDocument,
  pathParams: OpenApiPathItem["parameters"],
  opParams: OpenApiOperation["parameters"]
): Record<string, unknown> | undefined {
  const schema = findBodySchema(requestBody, document, pathParams, opParams);
  return schema ? resolveSchema(document, schema) : undefined;
}

function extractResponseSchema(
  operation: OpenApiOperation,
  document: OpenApiDocument
): Record<string, unknown> | undefined {
  const responses = operation.responses;
  if (!responses || typeof responses !== "object") {
    return undefined;
  }

  for (const code of ["200", "201", "default"]) {
    const resp = responses[code];
    if (!resp || typeof resp !== "object") {
      continue;
    }

    const resolved = isRef(resp as unknown)
      ? (resolveLocalRef(document, (resp as OpenApiRef).$ref) as Record<string, unknown>)
      : (resp as Record<string, unknown>);

    if (!resolved) continue;

    const content = resolved.content as Record<string, unknown> | undefined;
    if (content) {
      for (const ct of Object.values(content)) {
        const schema = (ct as { schema?: unknown })?.schema;
        if (schema) {
          return resolveSchema(document, schema);
        }
      }
    }

    const schema = resolved.schema;
    if (schema) {
      return resolveSchema(document, schema);
    }
  }

  return undefined;
}

function resolveRequestContentType(
  requestBody: { content?: Record<string, unknown> } | null,
  hasSwagger2Body: boolean,
  operationConsumes: string[] | undefined,
  globalConsumes: string[]
): { hasBody: boolean; requestContentType?: string } {
  const requestBodyContentTypes = requestBody ? Object.keys(requestBody.content ?? {}) : [];
  const oas3ContentType = getPreferredContentType(requestBodyContentTypes);
  if (oas3ContentType) {
    return {
      hasBody: true,
      requestContentType: oas3ContentType
    };
  }

  if (!hasSwagger2Body) {
    return { hasBody: false };
  }

  const swaggerConsumes = operationConsumes ?? globalConsumes;
  return {
    hasBody: true,
    requestContentType: getPreferredContentType(swaggerConsumes) ?? "application/json"
  };
}

type SecuritySchemeMap = Record<string, OpenApiSecurityScheme>;

function collectSecuritySchemes(document: OpenApiDocument): SecuritySchemeMap {
  const fromComponents = document.components?.securitySchemes ?? {};
  const fromSwagger2 = document.securityDefinitions ?? {};
  return {
    ...fromSwagger2,
    ...fromComponents
  };
}

function resolveOperationAuth(
  document: OpenApiDocument,
  operation: OpenApiOperation,
  securitySchemes: SecuritySchemeMap
): CliAuth | undefined {
  const allRequirements = operation.security ?? document.security;
  if (!allRequirements || allRequirements.length === 0) {
    return undefined;
  }

  for (const requirement of allRequirements) {
    if (Object.keys(requirement).length === 0) {
      continue;
    }

    const auth: CliAuth = {};
    for (const schemeName of Object.keys(requirement)) {
      const scheme = securitySchemes[schemeName];
      if (!scheme) {
        continue;
      }

      const type = scheme.type?.toLowerCase();
      if (type === "http") {
        const httpScheme = scheme.scheme?.toLowerCase();
        if (httpScheme === "bearer") {
          auth.bearerHeaderName = "Authorization";
        } else if (httpScheme === "basic") {
          auth.basic = true;
        }
      } else if (type === "basic") {
        auth.basic = true;
      } else if (type === "apiKey" || type === "apikey") {
        if (scheme.name && (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie")) {
          auth.apiKey = {
            name: scheme.name,
            in: scheme.in
          };
        }
      }
    }

    if (auth.bearerHeaderName || auth.basic || auth.apiKey) {
      return auth;
    }
  }

  return undefined;
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
  const securitySchemes = collectSecuritySchemes(document);

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
      const hasSwagger2Body = hasSwagger2BodyParam(document, pathItem.parameters, operation.parameters);
      const requestBodyInfo = resolveRequestContentType(requestBody, hasSwagger2Body, operation.consumes, globalConsumes);
      const bodySchemaHint = requestBodyInfo.hasBody
        ? extractBodySchemaHint(requestBody, document, pathItem.parameters, operation.parameters)
        : undefined;
      const auth = resolveOperationAuth(document, operation, securitySchemes);
      const bodySchema = requestBodyInfo.hasBody
        ? extractBodySchema(requestBody, document, pathItem.parameters, operation.parameters)
        : undefined;
      const responseSchema = extractResponseSchema(operation, document);

      operations.push({
        operationId,
        groupName,
        commandName,
        method,
        path,
        tags: operation.tags ?? [],
        summary: operation.summary ?? operation.description,
        hasBody: requestBodyInfo.hasBody,
        requestContentType: requestBodyInfo.requestContentType,
        bodySchemaHint,
        auth,
        parameters: params,
        bodySchema,
        responseSchema
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
