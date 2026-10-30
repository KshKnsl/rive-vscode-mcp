import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serverName = "rive";
function getEditorTargets({ home, platform, env }) {
  const copilotHome = env.COPILOT_HOME
    ? path.resolve(env.COPILOT_HOME)
    : path.join(home, ".copilot");
  const serverConfiguration = {
    command: "npx",
    args: ["-y", "rive-vscode-mcp-server"],
    env: { RIVE_MCP_ROOT: home },
  };
  const targets = [
    {
      editor: "VS Code",
      filePath: path.join(copilotHome, "mcp-config.json"),
      section: "servers",
      server: { type: "stdio", ...serverConfiguration },
    },
    {
      editor: "Cursor",
      filePath: path.join(home, ".cursor", "mcp.json"),
      section: "mcpServers",
      server: serverConfiguration,
    },
    {
      editor: "Claude Code",
      filePath: path.join(home, ".claude.json"),
      section: "mcpServers",
      server: { type: "stdio", ...serverConfiguration },
    },
  ];

  if (platform === "darwin") {
    targets.push({
      editor: "Claude Desktop",
      filePath: path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
      section: "mcpServers",
      server: serverConfiguration,
    });
  } else if (platform === "win32") {
    targets.push({
      editor: "Claude Desktop",
      filePath: path.join(
        env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      ),
      section: "mcpServers",
      server: serverConfiguration,
    });
  } else {
    targets.push({
      editor: "Claude Desktop",
      filePath: path.join(
        home,
        ".config",
        "Claude",
        "claude_desktop_config.json"
      ),
      section: "mcpServers",
      server: serverConfiguration,
    });
  }

  return targets;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function mergeServerConfig({ filePath, section, server }) {
  await mkdir(path.dirname(filePath), { recursive: true });

  let writePath = filePath;
  try {
    await lstat(filePath);
    writePath = await realpath(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let configuration = {};
  try {
    configuration = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read valid JSON from ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  if (!isRecord(configuration)) {
    throw new Error(`Expected a JSON object in ${filePath}.`);
  }

  const servers = configuration[section] ?? {};
  if (!isRecord(servers)) {
    throw new Error(`Expected "${section}" to be an object in ${filePath}.`);
  }

  if (Object.hasOwn(servers, serverName)) {
    if (JSON.stringify(servers[serverName]) === JSON.stringify(server)) {
      return "unchanged";
    }
    return "conflict";
  }

  configuration[section] = { ...servers, [serverName]: server };
  const temporaryPath = `${writePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, writePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Could not update ${filePath}: ${error.message}`, {
      cause: error,
    });
  }

  return "written";
}

export async function configureEditorConfigs({
  home,
  platform = process.platform,
  env = process.env,
} = {}) {
  home ??=
    (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) ||
    os.homedir();
  const results = [];
  for (const target of getEditorTargets({ home, platform, env })) {
    try {
      results.push({
        ...target,
        status: await mergeServerConfig(target),
      });
    } catch (error) {
      results.push({
        ...target,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
