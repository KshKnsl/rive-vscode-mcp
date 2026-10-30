# Rive VS Code MCP

Preview `.riv` files in VS Code and explore artboards, animations, and state machines.

![Rive preview](preview.GIF)

## Run the extension

```bash
npm run compile
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --new-window --extensionDevelopmentPath="$PWD" "/absolute/path/to/sample.riv"
```

The compile command builds the local Tailwind stylesheet used by the preview webview.

Replace the sample path with your `.riv` file's absolute path. This opens it in an Extension Development Host with the extension enabled.

## MCP server

The local `inspect_rive_file` tool gives AI agents artboard dimensions, animation names and timing, state machines, and input names and types. It reads files locally and only accepts `.riv` files inside the configured project root.

Install dependencies with `npm install`, then add this server to your MCP client:

```json
{
  "servers": {
    "rive-vscode-mcp": {
      "command": "node",
      "args": ["/path/to/rive-vscode-mcp/mcp.mjs"],
      "cwd": "/path/to/your/rive/project",
      "env": {
        "RIVE_MCP_ROOT": "/path/to/your/rive/project"
      }
    }
  }
}
```

Requires Node.js 18 or later.
