import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import { Disposable, disposeAll } from "./dispose";

interface RiveDocumentDelegate {
  getFileData(): Promise<Uint8Array>;
}

/**
 * Define the document (the data model) used for Rive files.
 */
class RiveDocument extends Disposable implements vscode.CustomDocument {
  static async create(
    uri: vscode.Uri,
    backupId: string | undefined,
    delegate: RiveDocumentDelegate
  ): Promise<RiveDocument | PromiseLike<RiveDocument>> {
    // If we have a backup, read that. Otherwise read the resource from the workspace
    const dataFile =
      typeof backupId === "string" ? vscode.Uri.parse(backupId) : uri;
    const fileData = await RiveDocument.readFile(dataFile);
    return new RiveDocument(uri, fileData, delegate);
  }

  private static async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (uri.scheme === "untitled") {
      return new Uint8Array();
    }
    return new Uint8Array(await vscode.workspace.fs.readFile(uri));
  }

  private readonly _uri: vscode.Uri;

  private _documentData: Uint8Array;

  private readonly _delegate: RiveDocumentDelegate;

  private constructor(
    uri: vscode.Uri,
    initialContent: Uint8Array,
    delegate: RiveDocumentDelegate
  ) {
    super();
    this._uri = uri;
    this._documentData = initialContent;
    this._delegate = delegate;
  }

  public get uri() {
    return this._uri;
  }

  public get documentData(): Uint8Array {
    return this._documentData;
  }

  private readonly _onDidDispose = this._register(
    new vscode.EventEmitter<void>()
  );
  /**
   * Fired when the document is disposed of.
   */
  public readonly onDidDispose = this._onDidDispose.event;

  private readonly _onDidChange = this._register(
    new vscode.EventEmitter<{
      readonly label: string;
      undo(): void;
      redo(): void;
    }>()
  );
  /**
   * Fired to tell VS Code that an edit has occurred in the document.
   *
   * This updates the document's dirty indicator.
   */
  public readonly onDidChange = this._onDidChange.event;

  /**
   * Called by VS Code when there are no more references to the document.
   *
   * This happens when all editors for it have been closed.
   */
  dispose(): void {
    this._onDidDispose.fire();
    super.dispose();
  }

  /**
   * Called by VS Code when the user saves the document.
   */
  async save(cancellation: vscode.CancellationToken): Promise<void> {
    await this.saveAs(this.uri, cancellation);
  }

  /**
   * Called by VS Code when the user saves the document to a new location.
   */
  async saveAs(
    targetResource: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    const fileData = await this._delegate.getFileData();
    if (cancellation.isCancellationRequested) {
      return;
    }
    await vscode.workspace.fs.writeFile(targetResource, fileData);
  }

  /**
   * Called by VS Code when the user calls `revert` on a document.
   */
  async revert(_cancellation: vscode.CancellationToken): Promise<void> {
    const diskContent = await RiveDocument.readFile(this.uri);
    this._documentData = diskContent;
  }

  /**
   * Called by VS Code to backup the edited document.
   *
   * These backups are used to implement hot exit.
   */
  async backup(
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    await this.saveAs(destination, cancellation);

    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // noop
        }
      },
    };
  }
}

/**
 * Rive preview provider.
 */
export class RivePreviewProvider
  implements vscode.CustomEditorProvider<RiveDocument>
{
  public static register(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RivePreviewProvider.viewType,
      new RivePreviewProvider(context, output),
      {
        // For this demo extension, we enable `retainContextWhenHidden` which keeps the
        // webview alive even when it is not visible. You should avoid using this setting
        // unless is absolutely required as it does have memory overhead.
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  private static readonly viewType = "rive-vscode-mcp.rivePreview";

  /**
   * Tracks all known webviews
   */
  private readonly webviews = new WebviewCollection();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _output: vscode.OutputChannel
  ) {}

  //#region CustomEditorProvider

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken
  ): Promise<RiveDocument> {
    const document: RiveDocument = await RiveDocument.create(
      uri,
      openContext.backupId,
      {
        getFileData: async () => {
          const webviewsForDocument = Array.from(
            this.webviews.get(document.uri)
          );
          if (!webviewsForDocument.length) {
            throw new Error("Could not find webview to save for");
          }
          const panel = webviewsForDocument[0];
          const response = await this.postMessageWithResponse<number[]>(
            panel,
            "getFileData",
            {}
          );
          return new Uint8Array(response);
        },
      }
    );

    const listeners: vscode.Disposable[] = [];

    listeners.push(
      document.onDidChange((e) => {
        // Tell VS Code that the document has been edited by the use.
        this._onDidChangeCustomDocument.fire({
          document,
          ...e,
        });
      })
    );

    document.onDidDispose(() => disposeAll(listeners));

    return document;
  }

  async resolveCustomEditor(
    document: RiveDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Add the webview to our internal set of active webviews
    this.webviews.add(document.uri, webviewPanel);

    // Setup initial content for the webview
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "ready") {
        try {
          const documentData = document.documentData;
          const start = documentData.byteOffset;
          const buffer = documentData.buffer.slice(
            start,
            start + documentData.byteLength
          );
          const sent = await webviewPanel.webview.postMessage({
            type: "loadAsset",
            fileName: path.basename(document.uri.fsPath),
            buffer,
          });
          if (!sent) {
            throw new Error("The webview did not accept the Rive file data.");
          }
        } catch (error) {
          this._output.appendLine(
            `[${new Date().toISOString()}] ERROR ${document.uri.fsPath}: Could not transfer Rive file data to its preview webview.\n${
              error instanceof Error ? error.stack || error.message : String(error)
            }`
          );
          this._output.show(true);
        }
        return;
      }

      if (
        message?.type === "log" &&
        ["warning", "error"].includes(message.level) &&
        typeof message.message === "string" &&
        message.message.length <= 2000 &&
        (message.detail === undefined ||
          (typeof message.detail === "string" && message.detail.length <= 10000))
      ) {
        const level = message.level.toUpperCase();
        const location = document.uri.fsPath;
        this._output.appendLine(
          `[${new Date().toISOString()}] ${level} ${location}: ${message.message}${
            message.detail ? `\n${message.detail}` : ""
          }`
        );
        if (message.level === "error") {
          this._output.show(true);
        }
        return;
      }

      if (
        message?.type === "copyText" &&
        typeof message.text === "string" &&
        message.text.length <= 100000
      ) {
        try {
          await vscode.env.clipboard.writeText(message.text);
          webviewPanel.webview.postMessage({ type: "copyComplete", label: message.label });
        } catch {
          webviewPanel.webview.postMessage({ type: "copyError" });
        }
        return;
      }

      if (message?.type === "saveScreenshot") {
        if (
          typeof message.data !== "string" ||
          message.data.length > 70000000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(message.data)
        ) {
          webviewPanel.webview.postMessage({ type: "screenshotError" });
          await vscode.window.showErrorMessage("Could not save screenshot: invalid PNG image data.");
          return;
        }
        try {
          const defaultName = `${path.parse(document.uri.fsPath).name}.png`;
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), defaultName)),
            filters: { "PNG image": ["png"] },
            saveLabel: "Save Screenshot",
          });
          if (!target) {
            webviewPanel.webview.postMessage({ type: "screenshotCancelled" });
            return;
          }
          const pngData = Buffer.from(message.data.slice("data:image/png;base64,".length), "base64");
          await vscode.workspace.fs.writeFile(target, pngData);
          webviewPanel.webview.postMessage({ type: "screenshotSaved", fileName: path.basename(target.fsPath) });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this._output.appendLine(
            `[${new Date().toISOString()}] ERROR ${document.uri.fsPath}: Could not save preview screenshot.\n${detail}`
          );
          this._output.show(true);
          webviewPanel.webview.postMessage({ type: "screenshotError" });
          await vscode.window.showErrorMessage(`Could not save screenshot: ${detail}`);
        }
      }
    });
    webviewPanel.webview.html = this.getHtmlForWebview(
      webviewPanel.webview,
      path.basename(document.uri.fsPath)
    );
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<RiveDocument>
  >();
  public readonly onDidChangeCustomDocument =
    this._onDidChangeCustomDocument.event;

  public saveCustomDocument(
    document: RiveDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.save(cancellation);
  }

  public saveCustomDocumentAs(
    document: RiveDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.saveAs(destination, cancellation);
  }

  public revertCustomDocument(
    document: RiveDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.revert(cancellation);
  }

  public backupCustomDocument(
    document: RiveDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation);
  }

  //#endregion

  /**
   * Get the static HTML used for in our editor's webviews.
   */
  private getHtmlForWebview(
    webview: vscode.Webview,
    fileName: string
  ): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    // Local path to script and css for the webview
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._context.extensionUri,
        "assets",
        "rive-preview.js"
      )
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._context.extensionUri,
        "assets",
        "rive-preview-style.css"
      )
    );

    const riveRuntimeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._context.extensionUri,
        "node_modules",
        "@rive-app",
        "canvas",
        "rive.js"
      )
    );
    const riveWasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._context.extensionUri,
        "node_modules",
        "@rive-app",
        "canvas",
        "rive.wasm"
      )
    );
    const fileNameForScript = JSON.stringify(fileName).replace(/</g, "\\u003c");

    return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; connect-src ${webview.cspSource} https://unpkg.com https://cdn.jsdelivr.net https://cdn.rive.app;" />
          <title>Rive Preview</title>
          <link href="${styleUri}" rel="stylesheet" />
        </head>
        <body class="m-0 min-w-[320px] bg-page px-2 pb-3 pt-2 font-sans text-[12px] leading-[1.45] text-text">
          <header class="mx-auto mb-2 flex w-full max-w-[1600px] items-center gap-2 border-b border-border pb-2">
            <h1 id="assetName" class="m-0 min-w-0 flex-1 overflow-hidden text-[13px] font-semibold leading-tight text-ellipsis whitespace-nowrap" title=""></h1>
            <span id="status" class="inline-flex max-w-[45%] shrink-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted before:size-1.5 before:shrink-0 before:rounded-full before:bg-[var(--status-ok)] before:content-[''] data-[state=loading]:before:animate-[status-pulse_1.2s_ease-in-out_infinite] data-[state=loading]:before:bg-[var(--status-loading)] data-[state=error]:before:bg-[var(--status-error)]" data-state="loading" role="status">Loading asset…</span>
          </header>
          <main class="mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1.8fr)_minmax(270px,.8fr)] items-start gap-2 max-[860px]:grid-cols-1">
            <section class="min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
              <div class="space-y-1.5 border-b border-border bg-raised px-2 py-1.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <div class="flex shrink-0 items-center gap-1.5">
                    <div class="flex h-7 items-center gap-0.5 rounded border border-border bg-input p-0.5" role="group" aria-label="Playback controls">
                      <button id="playButton" class="grid size-6 cursor-pointer place-items-center rounded bg-transparent text-[10px] text-[var(--status-ok)] hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Play" aria-label="Play">▶</button>
                      <button id="pauseButton" class="grid size-6 cursor-pointer place-items-center rounded bg-transparent text-[10px] hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Pause" aria-label="Pause">Ⅱ</button>
                      <button id="stopButton" class="grid size-6 cursor-pointer place-items-center rounded bg-transparent text-[10px] hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Stop" aria-label="Stop">■</button>
                    </div>
                    <button id="screenshotButton" class="h-7 cursor-pointer rounded border border-border bg-input px-2 text-[9px] font-semibold hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" type="button" title="Save preview as PNG" aria-label="Save preview screenshot">Screenshot</button>
                    <label class="flex items-center gap-1.5 text-[10px] text-muted">Fit<select id="fitSelect" class="h-7 min-w-[100px] rounded border border-border bg-input px-2 text-[10px] text-text focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2" aria-label="Preview fit"><option value="contain">Contain</option><option value="cover">Cover</option><option value="fill">Fill</option><option value="fitWidth">Fit width</option><option value="fitHeight">Fit height</option></select></label>
                    <div class="flex items-center gap-1" role="group" aria-label="Zoom controls"><button id="zoomOut" class="grid size-7 cursor-pointer place-items-center rounded border border-border bg-input text-xs hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Zoom out" aria-label="Zoom out">−</button><button id="zoomReset" class="h-7 min-w-11 cursor-pointer rounded border border-border bg-input px-1 text-[10px] [font-variant-numeric:tabular-nums] hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Reset zoom" aria-label="Reset zoom">100%</button><button id="zoomIn" class="grid size-7 cursor-pointer place-items-center rounded border border-border bg-input text-xs hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" title="Zoom in" aria-label="Zoom in">+</button></div>
                  </div>
                  <div class="flex min-w-[140px] flex-1 items-center gap-2 rounded border border-border bg-input px-2 py-1">
                    <strong id="timelineTitle" class="max-w-[35%] shrink-0 overflow-hidden text-[10px] font-medium text-ellipsis whitespace-nowrap" title="Selected animation timeline">Select a timeline</strong>
                    <input id="timelineScrubber" class="min-w-8 flex-1 cursor-pointer accent-accent focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" type="range" min="0" max="0" step="0.01" value="0" aria-label="Animation timeline position" disabled />
                    <span class="shrink-0 text-[9px] [font-variant-numeric:tabular-nums] text-muted"><span id="elapsedTime">0:00.00</span><span class="px-0.5">/</span><span id="totalTime">0:00.00</span></span>
                  </div>
                  <label class="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted">Background<input id="background" class="size-7 cursor-pointer rounded border border-border bg-input p-0.5 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2" type="color" value="#202127" aria-label="Preview background" /></label>
                </div>
              </div>
              <div id="assetSummary" class="hidden flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5" hidden></div>
              <div class="relative grid h-[clamp(300px,56vh,700px)] min-h-[300px] place-items-center overflow-hidden bg-[#202127] max-[860px]:h-[52vh] max-[480px]:h-[44vh] max-[480px]:min-h-[240px]"><canvas id="canvas" class="block h-full w-full origin-center" aria-label="Interactive Rive animation preview" tabindex="0"></canvas><div id="emptyState" class="absolute max-w-[260px] rounded-lg border border-dashed border-border bg-surface px-4 py-3 text-center text-muted" hidden>No artboards found in this file.</div></div>
              <span id="timelineDetails" class="sr-only"></span>
              <span id="timingNote" class="sr-only">Timeline duration and looping vary by animation.</span>
            </section>
            <aside class="min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
              <section class="min-w-0 p-2">
                <div class="flex items-end gap-1.5">
                  <label class="flex min-w-0 flex-1 flex-col gap-1 text-[9px] font-semibold text-muted">Artboard<select id="artboardSelect" class="h-7 w-full min-w-0 overflow-hidden rounded border border-border bg-input px-2 text-[11px] text-text focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2" aria-label="Artboard"></select></label>
                  <button id="copyArtboard" class="h-7 cursor-pointer rounded border border-border bg-transparent px-2 text-[9px] font-semibold transition-colors hover:border-accent/55 hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45" aria-label="Copy artboard name">Copy</button>
                </div>
              </section>
              <section class="min-w-0">
                <div class="flex items-center justify-between border-y border-border px-3 py-2"><h2 class="m-0 text-xs font-semibold">Timeline animations</h2></div>
                <div id="animationList" class="flex max-h-48 flex-col gap-1 overflow-y-auto p-2"></div>
              </section>
              <section class="min-w-0 border-t border-border">
                <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2"><h2 class="m-0 shrink-0 text-xs font-semibold">State machines</h2><div class="flex min-w-0 items-center gap-1"><select id="machineSelect" class="h-7 min-w-0 max-w-[180px] rounded border border-border bg-input px-2 text-[10px] text-text focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2" aria-label="State machine"></select><button id="copyMachine" class="h-7 shrink-0 cursor-pointer rounded border border-border bg-transparent px-2 text-[9px] font-semibold transition-colors hover:border-accent/55 hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-45">Copy</button></div></div>
                <div id="inputList" class="flex max-h-52 flex-col gap-1 overflow-y-auto p-2"></div>
              </section>
              <div id="toast" class="pointer-events-none fixed bottom-4 right-4 z-[5] translate-y-1.5 rounded-md border border-[color-mix(in_srgb,#4caf79_60%,transparent)] bg-[#27734c] px-3 py-2 text-[11px] text-white opacity-0 shadow-[0_5px_20px_rgb(0_0_0_/_25%)] transition-[opacity,transform] duration-150 ease-in-out" role="status" aria-live="polite"></div>
            </aside>
          </main>
          <script nonce="${nonce}" src="${riveRuntimeUri}"></script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
          <script nonce="${nonce}">
            rive.RuntimeLoader.setWasmUrl(${JSON.stringify(riveWasmUri.toString())});
            rive.RuntimeLoader.setWasmFallbackUrl(null);
            const vscode = acquireVsCodeApi();
            initializeRive(${fileNameForScript}, vscode);
          </script>
        </body>
      </html>`;
  }

  private _requestId = 1;
  private readonly _callbacks = new Map<number, (response: any) => void>();

  private postMessageWithResponse<R = unknown>(
    panel: vscode.WebviewPanel,
    type: string,
    body: any
  ): Promise<R> {
    const requestId = this._requestId++;
    const p = new Promise<R>((resolve) =>
      this._callbacks.set(requestId, resolve)
    );
    panel.webview.postMessage({ type, requestId, body });
    return p;
  }
}

/**
 * Tracks all webviews.
 */
class WebviewCollection {
  private readonly _webviews = new Set<{
    readonly resource: string;
    readonly webviewPanel: vscode.WebviewPanel;
  }>();

  /**
   * Get all known webviews for a given uri.
   */
  public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
    const key = uri.toString();
    for (const entry of this._webviews) {
      if (entry.resource === key) {
        yield entry.webviewPanel;
      }
    }
  }

  /**
   * Add a new webview to the collection.
   */
  public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
    const entry = { resource: uri.toString(), webviewPanel };
    this._webviews.add(entry);

    webviewPanel.onDidDispose(() => {
      this._webviews.delete(entry);
    });
  }
}
