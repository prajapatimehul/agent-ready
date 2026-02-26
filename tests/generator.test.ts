import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { writeGeneratedCli } from "../src/generator.js";
import { normalizeOpenApi, readOpenApiDocument } from "../src/openapi.js";
import type { CliSpec } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("OpenAPI normalization", () => {
  it("extracts supported operations", async () => {
    const doc = await readOpenApiDocument("examples/petstore/openapi.yaml");
    const spec = normalizeOpenApi(doc);

    expect(spec.operations.map((op) => `${op.groupName}/${op.commandName}`)).toEqual([
      "pet/create-pet",
      "pet/get-pet",
      "pet/list-pets"
    ]);
  });

  it("groups enterprise-scale resources by tags", async () => {
    const doc = await readOpenApiDocument("examples/enterprise/openapi.yaml");
    const spec = normalizeOpenApi(doc);

    const groups = new Set(spec.operations.map((op) => op.groupName));
    expect(groups.has("customers")).toBe(true);
    expect(groups.has("users")).toBe(true);
    expect(groups.has("orders")).toBe(true);
    expect(spec.operations.length).toBeGreaterThanOrEqual(18);
  });

  it("supports swagger2 body + security scheme metadata", () => {
    const spec = normalizeOpenApi({
      swagger: "2.0",
      host: "localhost:8080",
      basePath: "/api/v1",
      schemes: ["http"],
      consumes: ["application/x-www-form-urlencoded"],
      securityDefinitions: {
        apiKeyAuth: {
          type: "apiKey",
          name: "api_key",
          in: "query"
        }
      },
      paths: {
        "/submit/{id}": {
          post: {
            operationId: "submitForm",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "payload", in: "body", required: true, schema: { type: "object" } }
            ],
            security: [{ apiKeyAuth: [] }]
          }
        }
      }
    });

    expect(spec.defaultServer).toBe("http://localhost:8080/api/v1");
    expect(spec.operations).toHaveLength(1);
    expect(spec.operations[0]?.hasBody).toBe(true);
    expect(spec.operations[0]?.requestContentType).toBe("application/x-www-form-urlencoded");
    expect(spec.operations[0]?.auth?.apiKey).toEqual({ name: "api_key", in: "query" });
  });
});

describe("Generated CLI", () => {
  it("escapes multiline operation descriptions", async () => {
    const spec: CliSpec = {
      title: "Escaping API",
      version: "1.0.0",
      operations: [
        {
          operationId: "testOperation",
          groupName: "weird-group",
          commandName: "do-thing",
          method: "get",
          path: "/things",
          tags: [],
          summary: "Line one\nLine two with 'quote' and backslash \\",
          hasBody: false,
          parameters: []
        }
      ]
    };

    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-agent-ready-"));
    const output = join(tempDir, "weird-cli.js");

    await writeGeneratedCli(spec, "weird-cli", output);

    const helpResult = await execFileAsync("node", [output, "--help"]);
    expect(helpResult.stdout).toContain("weird-group");
  });

  it("calls local service successfully", async () => {
    const doc = await readOpenApiDocument("examples/petstore/openapi.yaml");
    const spec = normalizeOpenApi(doc);

    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-agent-ready-"));
    const output = join(tempDir, "pet-cli.js");

    await writeGeneratedCli(spec, "pet-cli", output);

    const source = await readFile(output, "utf8");
    expect(source).toContain("groupCommand.command('list-pets')");

    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/pets") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: "p-1", name: "Milo", species: "cat" }]));
        return;
      }

      if (req.method === "GET" && req.url === "/pets/p-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "p-1", name: "Milo", species: "cat" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected server address");
    }

    const result = await execFileAsync("node", [
      output,
      "pet",
      "list-pets",
      "--base-url",
      `http://127.0.0.1:${address.port}`,
      "--output",
      "json"
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed[0]?.id).toBe("p-1");

    const getResult = await execFileAsync("node", [
      output,
      "pet",
      "get-pet",
      "--pet-id",
      "p-1",
      "--base-url",
      `http://127.0.0.1:${address.port}`,
      "--output",
      "json"
    ]);

    const getParsed = JSON.parse(getResult.stdout);
    expect(getParsed.id).toBe("p-1");

    const helpResult = await execFileAsync("node", [output, "--help"]);
    expect(helpResult.stdout).toContain("pet");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("sends query api key, cookie params, arrays, and non-json body content type", async () => {
    const spec: CliSpec = {
      title: "Compat API",
      version: "1.0.0",
      operations: [
        {
          operationId: "submitForm",
          groupName: "compat",
          commandName: "submit",
          method: "post",
          path: "/submit",
          tags: [],
          hasBody: true,
          requestContentType: "application/x-www-form-urlencoded",
          auth: {
            apiKey: {
              name: "api_key",
              in: "query"
            }
          },
          parameters: [
            {
              name: "session",
              cliName: "session",
              in: "cookie",
              required: false,
              isArray: false
            },
            {
              name: "states[]",
              cliName: "states",
              in: "query",
              required: false,
              isArray: true
            }
          ]
        }
      ]
    };

    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-agent-ready-"));
    const output = join(tempDir, "compat-cli.js");
    await writeGeneratedCli(spec, "compat-cli", output);

    const server = createServer(async (req, res) => {
      const body = await new Promise<string>((resolve) => {
        let text = "";
        req.on("data", (chunk) => {
          text += String(chunk);
        });
        req.on("end", () => resolve(text));
      });

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const states = url.searchParams.getAll("states[]");
      const apiKey = url.searchParams.get("api_key");
      const cookie = req.headers.cookie ?? "";
      const contentType = req.headers["content-type"] ?? "";

      const ok = req.method === "POST"
        && url.pathname === "/submit"
        && apiKey === "k-test"
        && states.length === 2
        && states[0] === "CA"
        && states[1] === "TX"
        && cookie.includes("session=s-1")
        && String(contentType).startsWith("application/x-www-form-urlencoded")
        && body === "a=1&b=2";

      if (ok) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, apiKey, states, cookie, contentType, body }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected server address");
    }

    const result = await execFileAsync("node", [
      output,
      "compat",
      "submit",
      "--api-key",
      "k-test",
      "--session",
      "s-1",
      "--states",
      "CA,TX",
      "--body",
      "a=1&b=2",
      "--base-url",
      `http://127.0.0.1:${address.port}`,
      "--output",
      "json"
    ]);

    expect(JSON.parse(result.stdout)).toEqual({ ok: true });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
