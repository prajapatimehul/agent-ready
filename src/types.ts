export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export interface CliParameter {
  name: string;
  cliName: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  isArray: boolean;
  description?: string;
}

export interface CliAuth {
  bearerHeaderName?: string;
  basic?: boolean;
  apiKey?: {
    name: string;
    in: "header" | "query" | "cookie";
  };
}

export interface CliOperation {
  operationId: string;
  groupName: string;
  commandName: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary?: string;
  hasBody: boolean;
  requestContentType?: string;
  auth?: CliAuth;
  parameters: CliParameter[];
}

export interface CliSpec {
  title: string;
  version: string;
  defaultServer?: string;
  operations: CliOperation[];
}
