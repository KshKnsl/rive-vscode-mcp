import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const require = createRequire(import.meta.url);
const extensionPackage = require("./package.json");
const runtimeDirectory = path.dirname(
  require.resolve("@rive-app/canvas-advanced")
);
const rootPath = await realpath(process.env.RIVE_MCP_ROOT || process.cwd());
const maxFileSize = 100 * 1024 * 1024;
let runtimePromise;

function getRuntime() {
  runtimePromise ??= (async () => {
    const Rive = (await import("@rive-app/canvas-advanced")).default;
    const wasmFile = await readFile(path.join(runtimeDirectory, "rive.wasm"));
    return Rive({
      wasmBinary: wasmFile.buffer.slice(
        wasmFile.byteOffset,
        wasmFile.byteOffset + wasmFile.byteLength
      ),
    });
  })();
  return runtimePromise;
}

function assertInsideRoot(filePath) {
  const relativePath = path.relative(rootPath, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("The requested path must be inside the configured Rive project root.");
  }
}

async function resolveRiveFile(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("filePath must be a non-empty path to a .riv file.");
  }

  const requestedPath = path.resolve(rootPath, inputPath);
  const resolvedPath = await realpath(requestedPath);
  assertInsideRoot(resolvedPath);

  if (path.extname(resolvedPath).toLowerCase() !== ".riv") {
    throw new Error("The requested file must have a .riv extension.");
  }

  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) {
    throw new Error("The requested path is not a file.");
  }
  if (fileStats.size > maxFileSize) {
    throw new Error("The requested Rive file exceeds the 100 MiB size limit.");
  }

  return { resolvedPath, fileStats };
}

function describeInput(input, runtime) {
  const inputTypes = {
    [runtime.SMIInput.bool]: "boolean",
    [runtime.SMIInput.number]: "number",
    [runtime.SMIInput.trigger]: "trigger",
  };
  return {
    name: input.name,
    type: inputTypes[input.type] || `unknown (${input.type})`,
  };
}

function inspectArtboard(file, index, runtime) {
  const artboard = file.artboardByIndex(index);
  const bounds = artboard.bounds;
  const animations = [];
  for (
    let animationIndex = 0;
    animationIndex < artboard.animationCount();
    animationIndex += 1
  ) {
    const animation = artboard.animationByIndex(animationIndex);
    animations.push({
      name: animation.name,
      durationFrames: animation.duration,
      framesPerSecond: animation.fps,
      durationSeconds: animation.fps > 0 ? animation.duration / animation.fps : null,
      workStart: animation.workStart,
      workEnd: animation.workEnd,
      loopType: animation.loopValue,
    });
  }

  const stateMachines = [];
  for (
    let machineIndex = 0;
    machineIndex < artboard.stateMachineCount();
    machineIndex += 1
  ) {
    const stateMachine = artboard.stateMachineByIndex(machineIndex);
    const instance = new runtime.StateMachineInstance(stateMachine, artboard);
    const inputs = [];
    for (let inputIndex = 0; inputIndex < instance.inputCount(); inputIndex += 1) {
      inputs.push(describeInput(instance.input(inputIndex), runtime));
    }
    stateMachines.push({ name: stateMachine.name, inputs });
  }

  return {
    name: artboard.name,
    size: {
      width: artboard.width,
      height: artboard.height,
    },
    bounds: {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    },
    animations,
    stateMachines,
  };
}

async function inspectRiveFile(inputPath) {
  const { resolvedPath, fileStats } = await resolveRiveFile(inputPath);
  const [bytes, runtime] = await Promise.all([
    readFile(resolvedPath),
    getRuntime(),
  ]);
  const assetLoader = new runtime.CustomFileAssetLoader({
    loadContents: () => true,
  });
  let file;
  try {
    file = await runtime.load(new Uint8Array(bytes), assetLoader, false);
    const artboards = [];
    for (let index = 0; index < file.artboardCount(); index += 1) {
      artboards.push(inspectArtboard(file, index, runtime));
    }
    return {
      fileName: path.basename(resolvedPath),
      sizeBytes: fileStats.size,
      artboards,
    };
  } finally {
    file?.unref();
    assetLoader.delete();
  }
}

const resultSchema = {
  fileName: z.string(),
  sizeBytes: z.number(),
  artboards: z.array(
    z.object({
      name: z.string(),
      size: z.object({ width: z.number(), height: z.number() }),
      bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      animations: z.array(
        z.object({
          name: z.string(),
          durationFrames: z.number(),
          framesPerSecond: z.number(),
          durationSeconds: z.number().nullable(),
          workStart: z.number(),
          workEnd: z.number(),
          loopType: z.union([z.number(), z.string()]),
        })
      ),
      stateMachines: z.array(
        z.object({
          name: z.string(),
          inputs: z.array(
            z.object({ name: z.string(), type: z.string() })
          ),
        })
      ),
    })
  ),
};

const server = new McpServer(
  { name: "rive-vscode-mcp", version: extensionPackage.version },
  { instructions: "Inspect Rive .riv files inside the configured project root." }
);

server.registerTool(
  "inspect_rive_file",
  {
    title: "Inspect Rive file",
    description:
      "Read metadata from a Rive .riv file: artboard names and dimensions, timeline animations with duration and frame rate, and state machines with input names and types. filePath must be relative to the configured project root.",
    inputSchema: {
      filePath: z.string().min(1).describe("Path to a .riv file, relative to the configured root or absolute within it."),
    },
    outputSchema: resultSchema,
    annotations: {
      title: "Inspect Rive file",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath }) => {
    try {
      const result = await inspectRiveFile(filePath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
await server.connect(transport);
