import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ValtTreeProvider } from "./treeProvider";
import type { ExtensionMessage, WebviewMessage } from "./shared/messages";

let panel: vscode.WebviewPanel | undefined;
let treeProvider: ValtTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = getWorkspaceRoot();

  treeProvider = new ValtTreeProvider(workspaceRoot ?? "");

  const treeView = vscode.window.createTreeView("valt.fileTree", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const openCmd = vscode.commands.registerCommand("valt.open", () => {
    openValtPanel(context);
  });

  const openFileCmd = vscode.commands.registerCommand(
    "valt.openFile",
    (filePath: string) => {
      openValtPanel(context);
      setTimeout(() => sendFileToWebview(filePath), 100);
    }
  );

  const refreshCmd = vscode.commands.registerCommand("valt.refreshTree", () => {
    treeProvider?.refresh();
  });

  context.subscriptions.push(treeView, openCmd, openFileCmd, refreshCmd);
}

export function deactivate(): void {}

// ── Panel ─────────────────────────────────────────────────────────────────────

function openValtPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "valt",
    "Valt",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "dist")),
        vscode.Uri.file(path.join(context.extensionPath, "assets")),
        ...(getWorkspaceRoot() ? [vscode.Uri.file(getWorkspaceRoot()!)] : []),
      ],
    }
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context);

  panel.webview.onDidReceiveMessage(
    (raw: unknown) => handleWebviewMessage(raw as WebviewMessage),
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(() => {
    panel = undefined;
  }, undefined, context.subscriptions);
}

function buildWebviewHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "dist", "webview.js"))
  );
  const nonce = generateNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob:;
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};" />
  <title>Valt</title>
</head>
<body>
  <div id="app">
    <div id="content">
      <div id="welcome">
        <h1>Valt</h1>
        <p>Select a file from the sidebar to get started.</p>
      </div>
      <div id="editor-root" style="display:none;"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Message handlers ──────────────────────────────────────────────────────────

function handleWebviewMessage(message: WebviewMessage): void {
  switch (message.type) {
    case "ready":
      break;
    case "requestFile":
      sendFileToWebview(message.path);
      break;
    case "saveFile":
      handleSaveFile(message.filePath, message.content);
      break;
  }
}

function sendFileToWebview(filePath: string): void {
  if (!panel) return;

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const dirUri = vscode.Uri.file(path.dirname(filePath));
    const webviewBaseUri = panel.webview.asWebviewUri(dirUri).toString();
    const msg: ExtensionMessage = {
      type: "openFile",
      path: filePath,
      content,
      webviewBaseUri,
    };
    panel.webview.postMessage(msg);
  } catch {
    vscode.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}

function handleSaveFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
    treeProvider?.refresh();
  } catch {
    vscode.window.showErrorMessage("Valt: Could not save file.");
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
