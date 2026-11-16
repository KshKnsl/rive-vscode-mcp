import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtimeDirectory = path.dirname(
  require.resolve("@rive-app/canvas-advanced")
);

export function createInspectService(rootPath) {
  const maxFileSize = 100 * 1024 * 1024;
  const fullInspectCache = new Map();
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

  function cacheKey(resolvedPath, fileStats) {
    return `${resolvedPath}\0${fileStats.mtimeMs}\0${fileStats.size}`;
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

  function inspectArtboard(file, index, runtime, inspectOptions) {
    const artboard = file.artboardByIndex(index);
    const bounds = artboard.bounds;
    const base = {
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
    };

    if (inspectOptions.summary) {
      return {
        ...base,
        animationCount: artboard.animationCount(),
        stateMachineCount: artboard.stateMachineCount(),
      };
    }

    const animations = [];
    if (inspectOptions.includeAnimations) {
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
    }

    const stateMachines = [];
    if (inspectOptions.includeStateMachines) {
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
    }

    return {
      ...base,
      animations,
      stateMachines,
    };
  }

  async function loadAndInspectFull(resolvedPath, fileStats) {
    const fullInspectOptions = {
      includeAnimations: true,
      includeStateMachines: true,
      summary: false,
    };
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
        artboards.push(inspectArtboard(file, index, runtime, fullInspectOptions));
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

  function normalizeInspectOptions(options = {}) {
    return {
      artboardName:
        typeof options.artboardName === "string" && options.artboardName.trim() !== ""
          ? options.artboardName
          : undefined,
      includeAnimations: options.includeAnimations !== false,
      includeStateMachines: options.includeStateMachines !== false,
      summary: options.summary === true,
    };
  }

  function projectInspection(full, options) {
    let artboards = full.artboards;

    if (options.artboardName) {
      artboards = artboards.filter((item) => item.name === options.artboardName);
      if (artboards.length === 0) {
        throw new Error(`No artboard named "${options.artboardName}".`);
      }
    }

    if (options.summary) {
      artboards = artboards.map((item) => ({
        name: item.name,
        size: item.size,
        bounds: item.bounds,
        animationCount: item.animations?.length ?? 0,
        stateMachineCount: item.stateMachines?.length ?? 0,
      }));
    } else {
      artboards = artboards.map((item) => ({
        name: item.name,
        size: item.size,
        bounds: item.bounds,
        animations: options.includeAnimations ? (item.animations ?? []) : [],
        stateMachines: options.includeStateMachines ? (item.stateMachines ?? []) : [],
      }));
    }

    return {
      fileName: full.fileName,
      sizeBytes: full.sizeBytes,
      artboards,
    };
  }

  async function inspectRiveFile(inputPath, rawOptions = {}) {
    const options = normalizeInspectOptions(rawOptions);
    const { resolvedPath, fileStats } = await resolveRiveFile(inputPath);
    const key = cacheKey(resolvedPath, fileStats);

    let full = fullInspectCache.get(key);
    if (!full) {
      full = await loadAndInspectFull(resolvedPath, fileStats);
      fullInspectCache.set(key, full);
    }

    return projectInspection(full, options);
  }

  function formatToolTextSummary(result) {
    const artboardCount = result.artboards.length;
    const names = result.artboards.map((item) => item.name).join(", ");
    return `${result.fileName} (${result.sizeBytes} bytes): ${artboardCount} artboard${artboardCount === 1 ? "" : "s"}${names ? ` — ${names}` : ""}. Full metadata is in structuredContent.`;
  }

  return {
    getRuntime,
    inspectRiveFile,
    formatToolTextSummary,
    normalizeInspectOptions,
    projectInspection,
    fullInspectCache,
    cacheKey,
  };
}