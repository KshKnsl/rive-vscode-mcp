# Rive MCP Server

Standalone MCP server for inspecting Rive `.riv` file metadata. It reports artboard dimensions, timeline animations, state machines, and state-machine inputs.

## Set up editors with npx

Run this in a terminal:

```sh
npx -y rive-vscode-mcp-server
```

When run interactively, the command adds the server to the global MCP configuration for VS Code, Cursor, Claude Code, and Claude Desktop. It uses your home directory as the file-access root so it works across projects under your home folder. Existing servers are preserved; an existing `rive` entry is left untouched if it differs. Restart those editors after setup.

To run setup explicitly from a non-interactive terminal:

```sh
npx -y rive-vscode-mcp-server setup
```

Editors start the same command non-interactively as the MCP server. For example, configure an MCP client to launch it from the project directory containing the `.riv` files:

```json
{
  "mcpServers": {
    "rive": {
      "command": "npx",
      "args": ["-y", "rive-vscode-mcp-server"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

The server only reads `.riv` files inside its configured root, resolves symlinks before checking paths, and rejects files larger than 100 MiB. By default, the root is the process working directory. Set `RIVE_MCP_ROOT` to use a different root.

The VS Code extension also bundles this same server and starts it automatically.
