#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { configureEditorConfigs } from "./setup.mjs";
import { createInspectService } from "./inspect.mjs";

const require = createRequire(import.meta.url);
const extensionPackage = require("./package.json");
const rootPath = await realpath(process.env.RIVE_MCP_ROOT || process.cwd());
const {
  getRuntime,
  inspectRiveFile,
  formatToolTextSummary,
} = createInspectService(rootPath);

const animationSchema = z.object({
  name: z.string(),
  durationFrames: z.number(),
  framesPerSecond: z.number(),
  durationSeconds: z.number().nullable(),
  workStart: z.number(),
  workEnd: z.number(),
  loopType: z.union([z.number(), z.string()]),
});

const stateMachineSchema = z.object({
  name: z.string(),
  inputs: z.array(z.object({ name: z.string(), type: z.string() })),
});

const artboardSchema = z.object({
  name: z.string(),
  size: z.object({ width: z.number(), height: z.number() }),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  animations: z.array(animationSchema).optional(),
  stateMachines: z.array(stateMachineSchema).optional(),
  animationCount: z.number().optional(),
  stateMachineCount: z.number().optional(),
});

const resultSchema = {
  fileName: z.string(),
  sizeBytes: z.number(),
  artboards: z.array(artboardSchema),
};

const server = new McpServer(
  { name: "rive-vscode-mcp", version: extensionPackage.version },
  {
    instructions:
      "Inspect Rive .riv files inside the configured project root. Prefer a specific filePath; use summary=true or artboardName to reduce payload size on large files.",
  }
);

server.registerTool(
  "inspect_rive_file",
  {
    title: "Inspect Rive file",
    description:
      "Read metadata from a Rive .riv file: artboard names and dimensions, timeline animations with duration and frame rate, and state machines with input names and types. filePath must be relative to the configured project root. Optional: artboardName, includeAnimations, includeStateMachines, summary.",
    inputSchema: {
      filePath: z
        .string()
        .min(1)
        .describe("Path to a .riv file, relative to the configured root or absolute within it."),
      artboardName: z
        .string()
        .optional()
        .describe("When set, return only the artboard with this name."),
      includeAnimations: z
        .boolean()
        .optional()
        .describe("Include timeline animation metadata. Defaults to true."),
      includeStateMachines: z
        .boolean()
        .optional()
        .describe("Include state machines and inputs. Defaults to true."),
      summary: z
        .boolean()
        .optional()
        .describe(
          "When true, return compact artboard rows with animationCount and stateMachineCount only."
        ),
    },
    outputSchema: resultSchema,
    annotations: {
      title: "Inspect Rive file",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({
    filePath,
    artboardName,
    includeAnimations,
    includeStateMachines,
    summary,
  }) => {
    try {
      const result = await inspectRiveFile(filePath, {
        artboardName,
        includeAnimations,
        includeStateMachines,
        summary,
      });
      return {
        content: [{ type: "text", text: formatToolTextSummary(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Could not inspect Rive file: ${message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
const entryPath =
  process.argv[1] && (await realpath(process.argv[1]));
const isDirectExecution =
  entryPath === fileURLToPath(import.meta.url) ||
  entryPath === fileURLToPath(new URL("./cli.mjs", import.meta.url));
const args = process.argv.slice(2);
const setupRequested =
  isDirectExecution &&
  (args.includes("setup") ||
    (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY));

if (setupRequested) {
  const results = await configureEditorConfigs();
  for (const result of results) {
    if (result.status === "written") {
      console.log(`Configured ${result.editor}: ${result.filePath}`);
    } else if (result.status === "unchanged") {
      console.log(`${result.editor} already has the Rive server configured.`);
    } else if (result.status === "conflict") {
      console.error(
        `${result.editor} already has a different "rive" server entry; left it unchanged: ${result.filePath}`
      );
      process.exitCode = 1;
    } else {
      console.error(`Could not configure ${result.editor}: ${result.message}`);
      process.exitCode = 1;
    }
  }
  console.log("Restart the configured editors to load the Rive MCP server.");
} else {
  await getRuntime();
  await server.connect(transport);
}