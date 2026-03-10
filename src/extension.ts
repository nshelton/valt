import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ValtTreeProvider } from "./treeProvider";
import { ValtTagTreeProvider, TagIndex } from "./tagTreeProvider";
import { PageIndex, rewriteLinks } from "./pageIndex";
import type { ExtensionMessage, WebviewMessage } from "./shared/messages";

let panel: vscode.WebviewPanel | undefined;
let treeProvider: ValtTreeProvider | undefined;
let tagTreeProvider: ValtTagTreeProvider | undefined;
const pageIndex = new PageIndex();
let webviewReady = false;

// File queued to open as soon as the webview sends its `ready` handshake.
// Needed because the panel may not have finished loading when valt.openFile fires.
let pendingFile: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = getWorkspaceRoot();

  treeProvider = new ValtTreeProvider(workspaceRoot ?? "", pageIndex);
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
      if (panel) {
        // Panel is already open and the webview is ready — send immediately.
        panel.reveal(vscode.ViewColumn.One);
        sendFileToWebview(filePath);
      } else {
        // Panel is being created; the webview will request the file on `ready`.
        pendingFile = filePath;
        openValtPanel(context);
      }
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

  // Watch for external file changes (git checkout, other tools)
  const mdWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRebuild = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildIndexes(), 500);
  };
  mdWatcher.onDidCreate(debouncedRebuild);
  mdWatcher.onDidDelete(debouncedRebuild);
  mdWatcher.onDidChange(debouncedRebuild);

  context.subscriptions.push(
    fileTreeView, tagTreeView,
    openCmd, openFileCmd, refreshCmd, setTagColorCmd,
    cfgWatcher, mdWatcher,
  );

  // Build indexes eagerly so trees are populated before a file is opened
  rebuildIndexes();
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
    webviewReady = false;
    pendingFile = undefined;
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
      <div id="page-emoji" style="display:none;"></div>
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
      webviewReady = true;
      sendFileIndex();
      sendTagIndex();
      if (pendingFile) {
        sendFileToWebview(pendingFile);
        pendingFile = undefined;
      }
      break;
    case "requestFile":
      handleRequestFile(message.path);
      break;
    case "saveFile":
      handleSaveFile(message.filePath, message.content);
      break;
  }
}

function handleRequestFile(pathOrName: string): void {
  // Absolute path that exists → open directly
  if (path.isAbsolute(pathOrName) && fs.existsSync(pathOrName)) {
    sendFileToWebview(pathOrName);
    return;
  }

  // Try display-name lookup in page index
  const entry = pageIndex.getByDisplayName(pathOrName);
  if (entry) {
    sendFileToWebview(entry.fsPath);
    return;
  }

  // Fallback: search workspace for a file with that basename
  vscode.workspace.findFiles(`**/${pathOrName}`, "**/node_modules/**").then((uris) => {
    if (uris.length > 0) sendFileToWebview(uris[0].fsPath);
    else vscode.window.showWarningMessage(`Valt: Could not find page "${pathOrName}"`);
  });
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
  panel.webview.postMessage({
    type: "fileIndex",
    pages: pageIndex.toPageInfos(),
  } satisfies ExtensionMessage);
}

function sendTagIndex(): void {
  if (!panel) return;
  const index = tagTreeProvider ? [...tagTreeProvider.getIndex().entries()] : [];
  const tags: Record<string, string[]> = {};
  const colors: Record<string, string> = {};
  for (const [tag, files] of index) {
    tags[tag] = files.map((f) => path.basename(f));
    if (tagTreeProvider) colors[tag] = tagTreeProvider.colorFor(tag);
  }
  panel.webview.postMessage({ type: "tagIndex", tags, colors } satisfies ExtensionMessage);
}

function handleSaveFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    vscode.window.showErrorMessage("Valt: Could not save file.");
    return;
  }

  // Check if a rename is needed (new H1 → new canonical filename)
  const renameResult = pageIndex.computeRename(filePath, content);

  if (renameResult.needsRename) {
    const { newPath, newFilename, oldDisplayName } = renameResult;

    // Collect linkers before the rename so we can update their content
    const linkers = pageIndex.getLinkers(filePath);
    const newDisplayName = path.basename(newPath, ".md").replace(/^\d+\s+/, "");

    // Rename the file on disk
    try {
      fs.renameSync(filePath, newPath);
    } catch {
      vscode.window.showErrorMessage(`Valt: Could not rename file to "${newFilename}"`);
      pageIndex.updateEntry(filePath, content);
      sendFileIndex();
      treeProvider?.setPageIndex(pageIndex);
      treeProvider?.refresh();
      return;
    }

    // Commit rename in index
    pageIndex.commitRename(filePath, newPath, content);

    // Update all files that linked to the old display name
    for (const linkerPath of linkers) {
      try {
        const linkerContent = fs.readFileSync(linkerPath, "utf8");
        const updated = rewriteLinks(linkerContent, oldDisplayName, newDisplayName);
        if (updated !== linkerContent) {
          fs.writeFileSync(linkerPath, updated, "utf8");
          pageIndex.updateEntry(linkerPath, updated);
        }
      } catch {
        // Best-effort link rewrite; skip unreadable files
      }
    }

    // Notify webview that the current file was renamed
    panel?.webview.postMessage({
      type: "fileRenamed",
      oldPath: filePath,
      newPath,
    } satisfies ExtensionMessage);
  }

  updateTagIndexForFile(renameResult.needsRename ? renameResult.newPath : filePath, content);
  sendFileIndex();
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
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

async function rebuildIndexes(): Promise<void> {
  const uris = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
  const tagIdx: TagIndex = new Map();
  const pageFiles: { fsPath: string; content: string }[] = [];

  // Read files in parallel batches to avoid blocking the extension host
  const BATCH_SIZE = 50;
  for (let i = 0; i < uris.length; i += BATCH_SIZE) {
    const batch = uris.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (uri) => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { fsPath: uri.fsPath, content: Buffer.from(bytes).toString("utf8") };
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        buildTagIndexFromContent(result.value.fsPath, result.value.content, tagIdx);
        pageFiles.push(result.value);
      }
    }
  }

  tagTreeProvider?.setIndex(tagIdx);
  pageIndex.build(pageFiles);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
}

// Keep for incremental tag updates on save
function updateTagIndexForFile(filePath: string, content: string): void {
  if (!tagTreeProvider) return;
  const index: TagIndex = tagTreeProvider.getIndex();

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
