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
