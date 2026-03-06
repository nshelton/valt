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
    (raw: unknown) => handleWebviewMessage(raw as WebviewMessage, context),
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
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <title>Valt</title>
</head>
<body>
  <div id="app">
    <div id="sidebar"></div>
    <div id="content">
      <div id="welcome">
        <h1>Valt</h1>
        <p>Select a file from the sidebar to get started.</p>
      </div>
      <div id="document" style="display:none;"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Message handlers ──────────────────────────────────────────────────────────

function handleWebviewMessage(
  message: WebviewMessage,
  context: vscode.ExtensionContext
): void {
  switch (message.type) {
    case "ready":
      break;
    case "requestFile":
      sendFileToWebview(message.path);
      break;
    case "saveImage":
      handleSaveImage(message.dataBase64, message.currentFilePath, context);
      break;
    case "updateBlock":
      handleUpdateBlock(message.filePath, message.start, message.end, message.newRaw);
      break;
  }
}

function sendFileToWebview(filePath: string): void {
  if (!panel) return;

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const dirUri = vscode.Uri.file(path.dirname(filePath));
    const webviewBaseUri = panel.webview.asWebviewUri(dirUri).toString();
    const fileList = collectFileList(getWorkspaceRoot() ?? path.dirname(filePath));
    const msg: ExtensionMessage = {
      type: "openFile",
      path: filePath,
      content,
      webviewBaseUri,
      fileList,
    };
    panel.webview.postMessage(msg);
  } catch {
    vscode.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}

function handleUpdateBlock(
  filePath: string,
  start: number,
  end: number,
  newRaw: string
): void {
  if (!panel) return;

  try {
    const original = fs.readFileSync(filePath, "utf8");

    if (start > original.length || end > original.length) {
      vscode.window.showErrorMessage("Valt: Block offset is stale — please re-open the file.");
      return;
    }

    const updated = original.slice(0, start) + newRaw + original.slice(end);
    fs.writeFileSync(filePath, updated, "utf8");
    treeProvider?.refresh();

    // Send the freshly written content back so the webview re-renders.
    sendFileToWebview(filePath);
  } catch {
    vscode.window.showErrorMessage("Valt: Could not update block.");
  }
}

function handleSaveImage(
  dataBase64: string,
  currentFilePath: string,
  _context: vscode.ExtensionContext
): void {
  if (!panel) return;

  try {
    const docDir = path.dirname(currentFilePath);
    const assetsDir = path.join(docDir, "assets");

    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const docName = path.basename(currentFilePath, path.extname(currentFilePath));
    const fileName = `${docName}-${Date.now()}.png`;
    const absPath = path.join(assetsDir, fileName);

    fs.writeFileSync(absPath, Buffer.from(dataBase64, "base64"));

    const msg: ExtensionMessage = {
      type: "imageSaved",
      relativePath: path.join("assets", fileName),
    };
    panel.webview.postMessage(msg);
  } catch {
    vscode.window.showErrorMessage("Valt: Could not save image.");
  }
}

// ── File list ─────────────────────────────────────────────────────────────────

function collectFileList(rootPath: string): string[] {
  const results: string[] = [];
  walkForMarkdown(rootPath, results);
  return results;
}

function walkForMarkdown(dir: string, results: string[]): void {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForMarkdown(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
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
