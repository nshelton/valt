"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode2 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs2 = __toESM(require("fs"));

// src/treeProvider.ts
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var ValtTreeItem = class extends vscode.TreeItem {
  constructor(label, fsPath, isDirectory, collapsibleState) {
    super(label, collapsibleState);
    this.label = label;
    this.fsPath = fsPath;
    this.isDirectory = isDirectory;
    this.resourceUri = vscode.Uri.file(fsPath);
    this.contextValue = isDirectory ? "valtDirectory" : "valtFile";
    if (!isDirectory) {
      this.command = {
        command: "valt.openFile",
        title: "Open File",
        arguments: [fsPath]
      };
      this.iconPath = new vscode.ThemeIcon("markdown");
    }
  }
};
var ValtTreeProvider = class {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    const dir = element ? element.fsPath : this.rootPath;
    return this.readDirectory(dir);
  }
  readDirectory(dir) {
    if (!fs.existsSync(dir))
      return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith("."))
        continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.directoryContainsMarkdown(fullPath)) {
          dirs.push(
            new ValtTreeItem(
              entry.name,
              fullPath,
              true,
              vscode.TreeItemCollapsibleState.Collapsed
            )
          );
        }
      } else if (entry.name.endsWith(".md")) {
        files.push(
          new ValtTreeItem(
            entry.name,
            fullPath,
            false,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }
    return [...dirs, ...sortFiles(files)];
  }
  directoryContainsMarkdown(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.some(
        (e) => e.isFile() && e.name.endsWith(".md") || e.isDirectory() && this.directoryContainsMarkdown(path.join(dir, e.name))
      );
    } catch {
      return false;
    }
  }
};
function sortFiles(files) {
  return files.sort((a, b) => {
    const aIsIndex = a.label === "_index.md";
    const bIsIndex = b.label === "_index.md";
    if (aIsIndex && !bIsIndex)
      return -1;
    if (!aIsIndex && bIsIndex)
      return 1;
    return a.label.localeCompare(b.label);
  });
}

// src/extension.ts
var panel;
var treeProvider;
function activate(context) {
  const workspaceRoot = getWorkspaceRoot();
  treeProvider = new ValtTreeProvider(workspaceRoot ?? "");
  const treeView = vscode2.window.createTreeView("valt.fileTree", {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  const openCmd = vscode2.commands.registerCommand("valt.open", () => {
    openValtPanel(context);
  });
  const openFileCmd = vscode2.commands.registerCommand(
    "valt.openFile",
    (filePath) => {
      openValtPanel(context);
      setTimeout(() => sendFileToWebview(filePath), 100);
    }
  );
  const refreshCmd = vscode2.commands.registerCommand("valt.refreshTree", () => {
    treeProvider?.refresh();
  });
  context.subscriptions.push(treeView, openCmd, openFileCmd, refreshCmd);
}
function deactivate() {
}
function openValtPanel(context) {
  if (panel) {
    panel.reveal(vscode2.ViewColumn.One);
    return;
  }
  panel = vscode2.window.createWebviewPanel(
    "valt",
    "Valt",
    vscode2.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode2.Uri.file(path2.join(context.extensionPath, "dist")),
        vscode2.Uri.file(path2.join(context.extensionPath, "assets")),
        ...getWorkspaceRoot() ? [vscode2.Uri.file(getWorkspaceRoot())] : []
      ]
    }
  );
  panel.webview.html = buildWebviewHtml(panel.webview, context);
  panel.webview.onDidReceiveMessage(
    (raw) => handleWebviewMessage(raw, context),
    void 0,
    context.subscriptions
  );
  panel.onDidDispose(() => {
    panel = void 0;
  }, void 0, context.subscriptions);
}
function buildWebviewHtml(webview, context) {
  const scriptUri = webview.asWebviewUri(
    vscode2.Uri.file(path2.join(context.extensionPath, "dist", "webview.js"))
  );
  const nonce = generateNonce();
  return (
    /* html */
    `<!DOCTYPE html>
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
</html>`
  );
}
function handleWebviewMessage(message, context) {
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
function sendFileToWebview(filePath) {
  if (!panel)
    return;
  try {
    const content = fs2.readFileSync(filePath, "utf8");
    const dirUri = vscode2.Uri.file(path2.dirname(filePath));
    const webviewBaseUri = panel.webview.asWebviewUri(dirUri).toString();
    const fileList = collectFileList(getWorkspaceRoot() ?? path2.dirname(filePath));
    const msg = {
      type: "openFile",
      path: filePath,
      content,
      webviewBaseUri,
      fileList
    };
    panel.webview.postMessage(msg);
  } catch {
    vscode2.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}
function handleUpdateBlock(filePath, start, end, newRaw) {
  if (!panel)
    return;
  try {
    const original = fs2.readFileSync(filePath, "utf8");
    if (start > original.length || end > original.length) {
      vscode2.window.showErrorMessage("Valt: Block offset is stale \u2014 please re-open the file.");
      return;
    }
    const updated = original.slice(0, start) + newRaw + original.slice(end);
    fs2.writeFileSync(filePath, updated, "utf8");
    treeProvider?.refresh();
    sendFileToWebview(filePath);
  } catch {
    vscode2.window.showErrorMessage("Valt: Could not update block.");
  }
}
function handleSaveImage(dataBase64, currentFilePath, _context) {
  if (!panel)
    return;
  try {
    const docDir = path2.dirname(currentFilePath);
    const assetsDir = path2.join(docDir, "assets");
    if (!fs2.existsSync(assetsDir)) {
      fs2.mkdirSync(assetsDir, { recursive: true });
    }
    const docName = path2.basename(currentFilePath, path2.extname(currentFilePath));
    const fileName = `${docName}-${Date.now()}.png`;
    const absPath = path2.join(assetsDir, fileName);
    fs2.writeFileSync(absPath, Buffer.from(dataBase64, "base64"));
    const msg = {
      type: "imageSaved",
      relativePath: path2.join("assets", fileName)
    };
    panel.webview.postMessage(msg);
  } catch {
    vscode2.window.showErrorMessage("Valt: Could not save image.");
  }
}
function collectFileList(rootPath) {
  const results = [];
  walkForMarkdown(rootPath, results);
  return results;
}
function walkForMarkdown(dir, results) {
  let entries;
  try {
    entries = fs2.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("."))
      continue;
    const fullPath = path2.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForMarkdown(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
}
function getWorkspaceRoot() {
  return vscode2.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function generateNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
