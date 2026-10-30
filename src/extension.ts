import * as vscode from "vscode";
import { RivePreviewProvider } from "./rivePreview";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Rive VS Code MCP");
  context.subscriptions.push(
    output,
    RivePreviewProvider.register(context, output)
  );
}
