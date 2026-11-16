import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "rive-mcp-test-"));
const projectDirectory = path.join(temporaryDirectory, "project");
const outsideFile = path.join(temporaryDirectory, "outside.riv");
const textFile = path.join(projectDirectory, "notes.txt");
const invalidRiveFile = path.join(projectDirectory, "invalid.riv");
const serverPath = path.resolve("mcp.mjs");
let client;
let transport;

before(async () => {
  await mkdir(projectDirectory);
  await writeFile(outsideFile, "outside project");
  await writeFile(textFile, "not a Rive file");
  await writeFile(invalidRiveFile, "invalid Rive data");
  client = new Client({ name: "rive-mcp-test", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectDirectory,
    stderr: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined)
      ),
      RIVE_MCP_ROOT: projectDirectory,
    },
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });
  try {
    await client.connect(transport);
  } catch (error) {
    const detail = serverStderr.trim();
    throw new Error(
      `Could not connect to the MCP server${detail ? `: ${detail}` : ""}`,
      { cause: error }
    );
  }
});

after(async () => {
  await client?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("publishes the read-only Rive inspection tool and rejects unsafe inputs", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "inspect_rive_file");
  assert.ok(tool, "inspect_rive_file is published");
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.inputSchema.required.includes("filePath"), true);

  const wrongExtension = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "notes.txt" },
  });
  assert.equal(wrongExtension.isError, true);
  assert.match(wrongExtension.content[0].text, /\.riv extension/);

  const escapedRoot = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "../outside.riv" },
  });
  assert.equal(escapedRoot.isError, true);
  assert.match(escapedRoot.content[0].text, /inside the configured Rive project root/);

  const invalidFile = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "invalid.riv" },
  });
  assert.equal(invalidFile.isError, true);
});

test("exposes optional inspect parameters and returns compact tool text", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "inspect_rive_file");
  assert.ok(tool?.inputSchema.properties.filePath);
  assert.ok(tool?.inputSchema.properties.artboardName);
  assert.ok(tool?.inputSchema.properties.summary);
  assert.ok(tool?.inputSchema.properties.includeAnimations);
  assert.ok(tool?.inputSchema.properties.includeStateMachines);
  assert.deepEqual(tool.inputSchema.required, ["filePath"]);

  const response = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "invalid.riv", summary: true },
  });
  assert.equal(response.isError, true);
  assert.ok(response.content[0].text.length < 200);
  assert.doesNotMatch(response.content[0].text, /"artboards"/);
  assert.equal(response.structuredContent, undefined);
});

test("rejects empty file paths and missing riv files", async () => {
  const emptyPath = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "  " },
  });
  assert.equal(emptyPath.isError, true);
  assert.match(emptyPath.content[0].text, /non-empty path/);

  const missing = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "does-not-exist.riv" },
  });
  assert.equal(missing.isError, true);
});

test("reports structuredContent only for successful inspections", async () => {
  const invalid = await client.callTool({
    name: "inspect_rive_file",
    arguments: { filePath: "invalid.riv" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.match(invalid.content[0].text, /^Could not inspect Rive file:/);
});

test("lists a single read-only inspect tool", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "inspect_rive_file");
  assert.equal(tools[0].annotations?.openWorldHint, false);
});

