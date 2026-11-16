import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInspectService } from "../mcp-server/inspect.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = path.join(testDirectory, "fixtures");
const serverPath = path.resolve("mcp.mjs");
let resolvedFixturesDirectory;
let inspectService;
let client;
let transport;

before(async () => {
  resolvedFixturesDirectory = await realpath(fixturesDirectory);
  inspectService = createInspectService(resolvedFixturesDirectory);

  client = new Client({ name: "rive-fixture-test", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: resolvedFixturesDirectory,
    stderr: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined)
      ),
      RIVE_MCP_ROOT: resolvedFixturesDirectory,
    },
  });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

test("loads eye-movement.riv with animations and a state machine", async () => {
  const result = await inspectService.inspectRiveFile("eye-movement.riv");
  assert.equal(result.fileName, "eye-movement.riv");
  assert.ok(result.sizeBytes > 0);
  assert.equal(result.artboards.length, 1);
  assert.equal(result.artboards[0].name, "New Artboard");
  assert.ok(result.artboards[0].animations.length >= 1);
  assert.ok(result.artboards[0].stateMachines.length >= 1);
});

test("loads vehicles.riv with two artboards and filters by artboardName", async () => {
  const full = await inspectService.inspectRiveFile("vehicles.riv");
  assert.equal(full.artboards.length, 2);
  assert.deepEqual(
    full.artboards.map((artboard) => artboard.name),
    ["Truck", "Jeep"]
  );

  const truckOnly = await inspectService.inspectRiveFile("vehicles.riv", {
    artboardName: "Truck",
  });
  assert.equal(truckOnly.artboards.length, 1);
  assert.equal(truckOnly.artboards[0].name, "Truck");
});

test("summary mode returns counts without full animation payloads", async () => {
  const summary = await inspectService.inspectRiveFile("sample-toggle-animation.riv", {
    summary: true,
  });
  assert.equal(summary.artboards.length, 1);
  assert.equal(summary.artboards[0].animationCount, 1);
  assert.equal(summary.artboards[0].stateMachineCount, 0);
  assert.equal(summary.artboards[0].animations, undefined);
  assert.equal(summary.artboards[0].stateMachines, undefined);
});

test("reuses the in-memory cache across repeated successful inspections", async () => {
  inspectService.fullInspectCache.clear();
  const first = await inspectService.inspectRiveFile("sample-toggle-animation.riv");
  assert.equal(inspectService.fullInspectCache.size, 1);
  const second = await inspectService.inspectRiveFile("sample-toggle-animation.riv", {
    includeStateMachines: false,
  });
  assert.deepEqual(second.artboards[0].stateMachines, []);
  assert.equal(first.fileName, second.fileName);
  assert.equal(inspectService.fullInspectCache.size, 1);
});

test("MCP tool returns structuredContent for a real fixture", async () => {
  const response = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "vehicles.riv", artboardName: "Jeep", summary: true },
  });
  assert.notEqual(response.isError, true);
  assert.match(response.content[0].text, /vehicles\.riv/);
  assert.equal(response.structuredContent.fileName, "vehicles.riv");
  assert.equal(response.structuredContent.artboards.length, 1);
  assert.equal(response.structuredContent.artboards[0].name, "Jeep");
  assert.equal(typeof response.structuredContent.artboards[0].animationCount, "number");
});

test("MCP tool reports unknown artboard names from real files", async () => {
  const response = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "vehicles.riv", artboardName: "Airplane" },
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /No artboard named/);
});