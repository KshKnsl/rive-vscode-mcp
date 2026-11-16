import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { configureEditorConfigs } from "../mcp-server/setup.mjs";

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "rive-mcp-setup-test-")
);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("configures selected global editor settings without replacing other servers", async () => {
  const home = path.join(temporaryDirectory, "home");
  const cursorConfigPath = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await writeFile(
    cursorConfigPath,
    JSON.stringify({ mcpServers: { existing: { command: "existing" } } })
  );

  const results = await configureEditorConfigs({
    home,
    platform: "linux",
    env: {},
  });

  assert.deepEqual(
    results.map(({ editor, status }) => [editor, status]),
    [
      ["VS Code", "written"],
      ["Cursor", "written"],
      ["Claude Code", "written"],
      ["Claude Desktop", "written"],
    ]
  );
  const cursorConfig = JSON.parse(await readFile(cursorConfigPath, "utf8"));
  assert.deepEqual(cursorConfig.mcpServers.existing, { command: "existing" });
  assert.deepEqual(cursorConfig.mcpServers.rive, {
    command: "npx",
    args: ["-y", "rive-vscode-mcp-server"],
    env: { RIVE_MCP_ROOT: home },
  });

  for (const [filePath, section] of [
    [path.join(home, ".copilot", "mcp-config.json"), "servers"],
    [path.join(home, ".claude.json"), "mcpServers"],
    [
      path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      "mcpServers",
    ],
  ]) {
    const config = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(config[section].rive.env.RIVE_MCP_ROOT, home);
  }
});

test("is idempotent and leaves conflicting server entries unchanged", async () => {
  const home = path.join(temporaryDirectory, "idempotent-home");
  const cursorConfigPath = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await writeFile(
    cursorConfigPath,
    JSON.stringify({ mcpServers: { rive: { command: "user-command" } } })
  );

  const firstResults = await configureEditorConfigs({
    home,
    platform: "linux",
    env: {},
  });
  const secondResults = await configureEditorConfigs({
    home,
    platform: "linux",
    env: {},
  });

  assert.equal(firstResults[1].status, "conflict");
  assert.equal(secondResults[0].status, "unchanged");
  assert.equal(secondResults[1].status, "conflict");
  const cursorConfig = JSON.parse(await readFile(cursorConfigPath, "utf8"));
  assert.deepEqual(cursorConfig.mcpServers.rive, { command: "user-command" });
});

test("uses COPILOT_HOME for VS Code global MCP configuration", async () => {
  const home = path.join(temporaryDirectory, "custom-home");
  const copilotHome = path.join(temporaryDirectory, "copilot-home");
  const [vscodeResult] = await configureEditorConfigs({
    home,
    platform: "win32",
    env: { COPILOT_HOME: copilotHome, APPDATA: path.join(home, "AppData") },
  });

  assert.equal(vscodeResult.status, "written");
  assert.equal(
    vscodeResult.filePath,
    path.join(copilotHome, "mcp-config.json")
  );
});

test("writes Claude Desktop config to the macOS support directory", async () => {
  const home = path.join(temporaryDirectory, "darwin-home");
  const results = await configureEditorConfigs({
    home,
    platform: "darwin",
    env: {},
  });
  const desktop = results.find(({ editor }) => editor === "Claude Desktop");
  assert.equal(desktop?.status, "written");
  assert.equal(
    desktop?.filePath,
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
  );
});

test("returns unchanged when the rive server entry already matches", async () => {
  const home = path.join(temporaryDirectory, "matched-home");
  const cursorConfigPath = path.join(home, ".cursor", "mcp.json");
  const expectedEntry = {
    command: "npx",
    args: ["-y", "rive-vscode-mcp-server"],
    env: { RIVE_MCP_ROOT: home },
  };
  await mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await writeFile(
    cursorConfigPath,
    JSON.stringify({ mcpServers: { rive: expectedEntry } }, null, 2)
  );

  const results = await configureEditorConfigs({ home, platform: "linux", env: {} });
  const cursor = results.find(({ editor }) => editor === "Cursor");
  assert.equal(cursor?.status, "unchanged");
});

test("surfaces read errors for invalid MCP config files", async () => {
  const home = path.join(temporaryDirectory, "invalid-json-home");
  const cursorConfigPath = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await writeFile(cursorConfigPath, "{ this is not json");

  const results = await configureEditorConfigs({ home, platform: "linux", env: {} });
  const cursor = results.find(({ editor }) => editor === "Cursor");
  assert.equal(cursor?.status, "error");
  assert.match(cursor?.message ?? "", /valid JSON/);
});
