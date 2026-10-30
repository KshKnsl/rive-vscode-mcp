import * as vscode from "vscode";
import { homedir } from "node:os";
import { RivePreviewProvider } from "./rivePreview";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Rive VS Code MCP");
  const mcpRoot = homedir();
  const mcpRootUri = vscode.Uri.file(mcpRoot);
  const copyMcpConfiguration = vscode.commands.registerCommand(
    "rive-vscode-mcp.copyMcpConfiguration",
    async () => {
      const configuration = {
        mcpServers: {
          "rive-vscode-mcp": {
            command: "node",
            args: [context.asAbsolutePath("mcp.mjs")],
            env: { RIVE_MCP_ROOT: mcpRoot },
          },
        },
      };
      try {
        await vscode.env.clipboard.writeText(JSON.stringify(configuration, null, 2));
        await vscode.window.showInformationMessage(
          "Global Rive MCP configuration copied. It can inspect .riv files in workspaces under your home folder."
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(
          `Could not copy the Rive MCP configuration: ${detail}`
        );
      }
    }
  );
  const mcpServerProvider =
    typeof vscode.lm?.registerMcpServerDefinitionProvider === "function"
      ? vscode.lm.registerMcpServerDefinitionProvider(
          "rive-vscode-mcp.server",
          {
            provideMcpServerDefinitions: (token) => {
              if (token.isCancellationRequested) {
                return [];
              }
              const server = new vscode.McpStdioServerDefinition(
                "Rive MCP",
                process.execPath,
                [context.asAbsolutePath("mcp.mjs")],
                { RIVE_MCP_ROOT: mcpRoot },
                String(context.extension.packageJSON.version)
              );
              server.cwd = mcpRootUri;
              return [server];
            },
          }
        )
      : undefined;
  context.subscriptions.push(
    output,
    copyMcpConfiguration,
    ...(mcpServerProvider ? [mcpServerProvider] : []),
    RivePreviewProvider.register(context, output)
  );
}
