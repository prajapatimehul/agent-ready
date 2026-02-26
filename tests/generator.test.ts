import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { writeGeneratedCli } from "../src/generator.js";
import { normalizeOpenApi, readOpenApiDocument } from "../src/openapi.js";

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
});

describe("Generated CLI", () => {
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
});
