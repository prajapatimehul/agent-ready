export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface CliParameter {
  name: string;
  cliName: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
}

export interface CliOperation {
  operationId: string;
  groupName: string;
  commandName: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary?: string;
  hasJsonBody: boolean;
  parameters: CliParameter[];
}

export interface CliSpec {
  title: string;
  version: string;
  defaultServer?: string;
  operations: CliOperation[];
}
