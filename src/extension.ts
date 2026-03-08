import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ValtTreeProvider } from "./treeProvider";
import { ValtTagTreeProvider, TagIndex } from "./tagTreeProvider";
import type { ExtensionMessage, WebviewMessage } from "./shared/messages";

let panel: vscode.WebviewPanel | undefined;
let treeProvider: ValtTreeProvider | undefined;
let tagTreeProvider: ValtTagTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = getWorkspaceRoot();

  treeProvider = new ValtTreeProvider(workspaceRoot ?? "");
  tagTreeProvider = new ValtTagTreeProvider();

  const fileTreeView = vscode.window.createTreeView("valt.fileTree", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const tagTreeView = vscode.window.createTreeView("valt.tagTree", {
    treeDataProvider: tagTreeProvider,
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

  const setTagColorCmd = vscode.commands.registerCommand(
    "valt.setTagColor",
    async (item?: { tagName?: string }) => {
      const tagName = item?.tagName;
      if (!tagName || !tagTreeProvider) return;
      await tagTreeProvider.promptSetColor(tagName);
    }
  );

  // Rebuild tag index when config changes (tag colors updated)
  const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("valt.tagColors")) {
      tagTreeProvider?.refresh();
    }
  });

  context.subscriptions.push(
    fileTreeView, tagTreeView,
    openCmd, openFileCmd, refreshCmd, setTagColorCmd,
    cfgWatcher,
  );

  // Build tag index eagerly so the tree is populated before a file is opened
  rebuildTagIndex();
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
      sendFileIndex();
      sendTagIndex();
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
    const msg: ExtensionMessage = { type: "openFile", path: filePath, content, webviewBaseUri };
    panel.webview.postMessage(msg);
  } catch {
    vscode.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}

function sendFileIndex(): void {
  if (!panel) return;
  vscode.workspace.findFiles("**/*.md", "**/node_modules/**").then((uris) => {
    if (!panel) return;
    const files = uris.map((u) => path.basename(u.fsPath));
    panel.webview.postMessage({ type: "fileIndex", files } satisfies ExtensionMessage);
  });
}

function sendTagIndex(): void {
  if (!panel) return;
  const index = tagTreeProvider ? [...tagTreeProvider["index"].entries()] : [];
  const tags: Record<string, string[]> = {};
  for (const [tag, files] of index) {
    tags[tag] = files.map((f) => path.basename(f));
  }
  panel.webview.postMessage({ type: "tagIndex", tags } satisfies ExtensionMessage);
}

function handleSaveFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
    treeProvider?.refresh();
    updateTagIndexForFile(filePath, content);
  } catch {
    vscode.window.showErrorMessage("Valt: Could not save file.");
  }
}

// ── Tag index ─────────────────────────────────────────────────────────────────

function buildTagIndexFromContent(filePath: string, content: string, index: TagIndex): void {
  const re = /@tag\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tag = m[1].trim();
    if (!tag) continue;
    if (!index.has(tag)) index.set(tag, []);
    const files = index.get(tag)!;
    if (!files.includes(filePath)) files.push(filePath);
  }
}

async function rebuildTagIndex(): Promise<void> {
  const uris = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
  const index: TagIndex = new Map();
  for (const uri of uris) {
    try {
      const content = fs.readFileSync(uri.fsPath, "utf8");
      buildTagIndexFromContent(uri.fsPath, content, index);
    } catch { /* skip unreadable files */ }
  }
  tagTreeProvider?.setIndex(index);
}

function updateTagIndexForFile(filePath: string, content: string): void {
  if (!tagTreeProvider) return;
  const index: TagIndex = tagTreeProvider["index"];

  // Remove this file from all existing tags
  for (const files of index.values()) {
    const i = files.indexOf(filePath);
    if (i >= 0) files.splice(i, 1);
  }
  // Clean up empty tags
  for (const [tag, files] of index) {
    if (files.length === 0) index.delete(tag);
  }
  // Re-scan and add
  buildTagIndexFromContent(filePath, content, index);
  tagTreeProvider.setIndex(index);
  sendTagIndex();
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
