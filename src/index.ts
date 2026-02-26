#!/usr/bin/env node
import { Command } from "commander";
import { basename } from "node:path";
import { writeGeneratedCli } from "./generator.js";
import { normalizeOpenApi, readOpenApiDocument } from "./openapi.js";

const program = new Command();

program
  .name("agent-ready")
  .description("Generate product CLIs from OpenAPI specs")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate a runnable CLI file from an OpenAPI spec")
  .requiredOption("--spec <path>", "Path to OpenAPI file (.yaml/.yml/.json)")
  .requiredOption("--out <path>", "Output path for generated CLI")
  .option("--name <name>", "Generated CLI command name")
  .action(async (options: { spec: string; out: string; name?: string }) => {
    const document = await readOpenApiDocument(options.spec);
    const normalized = normalizeOpenApi(document);
    const defaultName = basename(options.out).replace(/\.[^.]+$/, "");
    const cliName = options.name ?? defaultName;

    if (normalized.operations.length === 0) {
      throw new Error("No supported operations found in OpenAPI spec.");
    }

    await writeGeneratedCli(normalized, cliName, options.out);

    console.log(
      JSON.stringify(
        {
          generated: options.out,
          name: cliName,
          operations: normalized.operations.map((op) => ({
            group: op.groupName,
            command: op.commandName,
            operationId: op.operationId
          })),
          defaultServer: normalized.defaultServer ?? null
        },
        null,
        2
      )
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
