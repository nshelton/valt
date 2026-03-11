import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ValtTreeProvider } from "./treeProvider";
import { ValtTagTreeProvider, TagIndex } from "./tagTreeProvider";
import { FavoritesTreeProvider } from "./favoritesProvider";
import { PageIndex, generateId, extractTitle, extractEmoji, extractPageLinks } from "./pageIndex";
import type { RecentFileEntry, PageLink } from "./shared/messages";
import type { ExtensionMessage, WebviewMessage } from "./shared/messages";

// panels[panels.length - 1] is always the most-recently-focused panel.
let panels: vscode.WebviewPanel[] = [];
let treeProvider: ValtTreeProvider | undefined;
let tagTreeProvider: ValtTagTreeProvider | undefined;
let favoritesProvider: FavoritesTreeProvider | undefined;
const pageIndex = new PageIndex();
let extensionContext: vscode.ExtensionContext | undefined;

function getActivePanel(): vscode.WebviewPanel | undefined {
  return panels[panels.length - 1];
}

function broadcastToAll(msg: ExtensionMessage): void {
  for (const p of panels) p.webview.postMessage(msg);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const workspaceRoot = getWorkspaceRoot();

  treeProvider = new ValtTreeProvider(workspaceRoot ?? "", pageIndex);
  tagTreeProvider = new ValtTagTreeProvider();
  const favoritesFile = workspaceRoot ? path.join(workspaceRoot, ".valt-favorites") : "";
  favoritesProvider = new FavoritesTreeProvider(favoritesFile);

  const favoritesTreeView = vscode.window.createTreeView("valt.favoritesTree", {
    treeDataProvider: favoritesProvider,
    dragAndDropController: favoritesProvider,
  });

  const fileTreeView = vscode.window.createTreeView("valt.fileTree", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: treeProvider,
  });

  treeProvider.onFileMoved(() => {
    rebuildIndexes();
  }, undefined, context.subscriptions);

  const tagTreeView = vscode.window.createTreeView("valt.tagTree", {
    treeDataProvider: tagTreeProvider,
    showCollapseAll: true,
  });

  // valt.open — create a new panel. First time: ViewColumn.One, subsequent: Beside.
  const openCmd = vscode.commands.registerCommand("valt.open", () => {
    const column = panels.length === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Beside;
    createValtPanel(context, column);
  });

  // valt.openFile — called by sidebar tree items. Targets the active panel.
  const openFileCmd = vscode.commands.registerCommand(
    "valt.openFile",
    (filePath: string) => {
      const active = getActivePanel();
      if (active) {
        active.reveal(active.viewColumn ?? vscode.ViewColumn.One);
        sendFileTo(filePath, active);
      } else {
        createValtPanel(context, vscode.ViewColumn.One, filePath);
      }
    }
  );

  const refreshCmd = vscode.commands.registerCommand("valt.refreshTree", () => {
    treeProvider?.refresh();
  });

  const showHomeCmd = vscode.commands.registerCommand("valt.showHome", () => {
    const active = getActivePanel();
    if (active) {
      active.reveal(active.viewColumn ?? vscode.ViewColumn.One);
      active.webview.postMessage({ type: "showHome" } satisfies ExtensionMessage);
    } else {
      createValtPanel(context, vscode.ViewColumn.One);
    }
  });

  const setTagColorCmd = vscode.commands.registerCommand(
    "valt.setTagColor",
    async (item?: { tagName?: string }) => {
      const tagName = item?.tagName;
      if (!tagName || !tagTreeProvider) return;
      await tagTreeProvider.promptSetColor(tagName);
    }
  );

  const newSubPageCmd = vscode.commands.registerCommand(
    "valt.newSubPage",
    (item?: { fsPath?: string }) => {
      const root = getWorkspaceRoot();
      if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }

      let targetDir: string;
      if (item?.fsPath) {
        const stem = path.basename(item.fsPath, ".md");
        targetDir = path.join(path.dirname(item.fsPath), stem);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
      } else {
        targetDir = root;
      }

      const id = generateId();
      const filePath = path.join(targetDir, `${id} Untitled.md`);
      const content = "# Untitled\n\n";
      fs.writeFileSync(filePath, content, "utf8");
      pageIndex.updateEntry(filePath, content);
      treeProvider?.setPageIndex(pageIndex);
      treeProvider?.refresh();
      sendFileIndex();
      sendFileToWebview(filePath);
    }
  );

  const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("valt.tagColors")) {
      tagTreeProvider?.refresh();
    }
  });

  const mdWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRebuild = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildIndexes(), 500);
  };
  mdWatcher.onDidCreate(debouncedRebuild);
  mdWatcher.onDidDelete(debouncedRebuild);
  mdWatcher.onDidChange(debouncedRebuild);

  const removeFavoriteCmd = vscode.commands.registerCommand(
    "valt.removeFromFavorites",
    (item?: { fsPath?: string }) => {
      if (item?.fsPath) favoritesProvider?.removeFromFavorites(item.fsPath);
    }
  );

  context.subscriptions.push(
    favoritesTreeView, fileTreeView, tagTreeView,
    openCmd, openFileCmd, refreshCmd, showHomeCmd, setTagColorCmd,
    newSubPageCmd, removeFavoriteCmd,
    cfgWatcher, mdWatcher,
  );

  rebuildIndexes();
}

export function deactivate(): void {}

// ── Panel ─────────────────────────────────────────────────────────────────────

function createValtPanel(
  context: vscode.ExtensionContext,
  viewColumn: vscode.ViewColumn,
  pendingFilePath?: string,
): void {
  const p = vscode.window.createWebviewPanel(
    "valt",
    "Valt",
    viewColumn,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "dist")),
        vscode.Uri.file(path.join(context.extensionPath, "assets")),
        ...(getWorkspaceRoot() ? [vscode.Uri.file(getWorkspaceRoot()!)] : []),
      ],
    }
  );

  p.webview.html = buildWebviewHtml(p.webview, context);
  panels.push(p);

  // Per-panel state (in closure)
  let pending = pendingFilePath;

  p.webview.onDidReceiveMessage(
    (raw: unknown) => {
      const message = raw as WebviewMessage;
      if (message.type === "ready") {
        sendFileIndexTo(p);
        sendTagIndexTo(p);
        sendRecentFilesTo(p);
        if (pending) { sendFileTo(pending, p); pending = undefined; }
      } else {
        handleWebviewMessage(message, p);
      }
    },
    undefined,
    context.subscriptions
  );

  p.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      // Move to end of array so getActivePanel() returns this one.
      panels = panels.filter((x) => x !== p);
      panels.push(p);
    }
  }, undefined, context.subscriptions);

  p.onDidDispose(() => {
    panels = panels.filter((x) => x !== p);
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
    <div id="page-topbar" style="display:none;"></div>
    <div id="content">
      <div id="welcome">
        <h1>Valt</h1>
        <p>Select a file from the sidebar to get started.</p>
      </div>
      <div id="page-header" style="display:none;">
        <div id="page-emoji"></div>
        <div id="page-sub-pages"></div>
      </div>
      <div id="editor-root" style="display:none;"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Message handlers ──────────────────────────────────────────────────────────

function handleWebviewMessage(message: WebviewMessage, source: vscode.WebviewPanel): void {
  switch (message.type) {
    case "requestFile":
      handleRequestFile(message.path, source);
      break;
    case "saveFile":
      handleSaveFile(message.filePath, message.content);
      break;
    case "createFile":
      handleCreateFile(source);
      break;
    case "createDailyNote":
      handleCreateDailyNote(source);
      break;
    case "toggleFavorite":
      handleToggleFavorite(message.filePath, source);
      break;
  }
}

function handleToggleFavorite(filePath: string, target: vscode.WebviewPanel): void {
  const isFavorited = favoritesProvider?.toggleFavorite(filePath) ?? false;
  target.webview.postMessage({ type: "favorites", isFavorited } satisfies ExtensionMessage);
}

function handleRequestFile(pathOrName: string, target: vscode.WebviewPanel): void {
  // Absolute path that exists → open directly
  if (path.isAbsolute(pathOrName) && fs.existsSync(pathOrName)) {
    sendFileTo(pathOrName, target);
    return;
  }

  // UUID link: 8 lowercase hex chars → stable lookup, never stale
  if (/^[0-9a-f]{8}$/.test(pathOrName)) {
    const entry = pageIndex.getById(pathOrName);
    if (entry) { sendFileTo(entry.fsPath, target); return; }
  }

  // Legacy display-name lookup
  const entry = pageIndex.getByDisplayName(pathOrName);
  if (entry) { sendFileTo(entry.fsPath, target); return; }

  // Fallback: workspace search
  vscode.workspace.findFiles(`**/${pathOrName}`, "**/node_modules/**").then((uris) => {
    if (uris.length > 0) sendFileTo(uris[0].fsPath, target);
    else vscode.window.showWarningMessage(`Valt: Could not find page "${pathOrName}"`);
  });
}

// Send a file to a specific panel.
function sendFileTo(filePath: string, target: vscode.WebviewPanel): void {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const dirUri = vscode.Uri.file(path.dirname(filePath));
    const webviewBaseUri = target.webview.asWebviewUri(dirUri).toString();

    const backlinks: PageLink[] = pageIndex.getLinkers(filePath).map((p) => {
      const e = pageIndex.getByPath(p);
      return { displayName: e?.displayName ?? path.basename(p, ".md"), fsPath: p, emoji: e?.emoji ?? null };
    });

    const outgoingLinks: PageLink[] = extractPageLinks(content).flatMap((uuid) => {
      const e = pageIndex.getById(uuid);
      return e ? [{ displayName: e.displayName, fsPath: e.fsPath, emoji: e.emoji }] : [];
    });

    let createdAt = 0;
    let modifiedAt = 0;
    try {
      const stat = fs.statSync(filePath);
      createdAt = stat.birthtimeMs;
      modifiedAt = stat.mtimeMs;
    } catch { /* ignore */ }

    const root = getWorkspaceRoot();
    const rel = root ? path.relative(root, path.dirname(filePath)) : "";
    const breadcrumb = rel
      ? rel.split(path.sep).filter(Boolean).map((seg) => seg.replace(/^[0-9a-f]{8}\s+/, ""))
      : [];

    const isFavorited = favoritesProvider?.isFavorite(filePath) ?? false;
    const msg: ExtensionMessage = {
      type: "openFile", path: filePath, content, webviewBaseUri,
      backlinks, outgoingLinks, createdAt, modifiedAt, breadcrumb, isFavorited,
    };
    target.webview.postMessage(msg);
    pushRecent(filePath);
    sendRecentFiles();
  } catch {
    vscode.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}

// Convenience: send to the active panel (sidebar file-opens, new page creation, etc.)
function sendFileToWebview(filePath: string): void {
  const active = getActivePanel();
  if (active) sendFileTo(filePath, active);
}

function sendFileIndexTo(p: vscode.WebviewPanel): void {
  p.webview.postMessage({ type: "fileIndex", pages: pageIndex.toPageInfos() } satisfies ExtensionMessage);
}

function sendTagIndexTo(p: vscode.WebviewPanel): void {
  const index = tagTreeProvider ? [...tagTreeProvider.getIndex().entries()] : [];
  const tags: Record<string, string[]> = {};
  const colors: Record<string, string> = {};
  for (const [tag, files] of index) {
    tags[tag] = files.map((f) => path.basename(f));
    if (tagTreeProvider) colors[tag] = tagTreeProvider.colorFor(tag);
  }
  p.webview.postMessage({ type: "tagIndex", tags, colors } satisfies ExtensionMessage);
}

function sendRecentFilesTo(p: vscode.WebviewPanel): void {
  const paths: string[] = extensionContext?.globalState.get("valt.recentFiles", []) ?? [];
  const files: RecentFileEntry[] = [];
  for (const fp of paths) {
    try {
      const content = fs.readFileSync(fp, "utf8");
      const entry = pageIndex.getByPath(fp);
      files.push({
        path: fp,
        displayName: entry?.displayName ?? extractTitle(content),
        emoji: entry?.emoji ?? extractEmoji(content),
        preview: extractPreview(content),
      });
    } catch { /* file deleted — skip */ }
  }
  p.webview.postMessage({ type: "recentFiles", files } satisfies ExtensionMessage);
}

function sendFileIndex(): void { for (const p of panels) sendFileIndexTo(p); }
function sendTagIndex(): void  { for (const p of panels) sendTagIndexTo(p); }
function sendRecentFiles(): void { for (const p of panels) sendRecentFilesTo(p); }

function handleSaveFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    vscode.window.showErrorMessage("Valt: Could not save file.");
    return;
  }

  const renameResult = pageIndex.computeRename(filePath, content);

  if (renameResult.needsRename) {
    const { newPath, newFilename } = renameResult;

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

    // Also rename the sibling children folder if it exists
    const oldStem = path.basename(filePath, ".md");
    const newStem = path.basename(newPath, ".md");
    const oldSiblingDir = path.join(path.dirname(filePath), oldStem);
    const newSiblingDir = path.join(path.dirname(newPath), newStem);
    if (fs.existsSync(oldSiblingDir) && fs.statSync(oldSiblingDir).isDirectory()) {
      try { fs.renameSync(oldSiblingDir, newSiblingDir); } catch { /* best-effort */ }
    }

    // UUID links in other files remain valid — no rewrite needed
    pageIndex.commitRename(filePath, newPath, content);

    // Broadcast rename to all panels (each ignores it if not showing that file)
    broadcastToAll({ type: "fileRenamed", oldPath: filePath, newPath } satisfies ExtensionMessage);
  }

  updateTagIndexForFile(renameResult.needsRename ? renameResult.newPath : filePath, content);
  sendFileIndex();
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
}

// ── Recent files ──────────────────────────────────────────────────────────────

const MAX_RECENTS = 5;

function pushRecent(filePath: string): void {
  if (!extensionContext) return;
  const current: string[] = extensionContext.globalState.get("valt.recentFiles", []);
  const updated = [filePath, ...current.filter((p) => p !== filePath)].slice(0, MAX_RECENTS);
  extensionContext.globalState.update("valt.recentFiles", updated);
}

function extractPreview(content: string): string {
  const result: string[] = [];
  let skippedH1 = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!skippedH1 && /^#\s/.test(trimmed)) { skippedH1 = true; continue; }
    if (!trimmed) continue;
    const clean = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/@\[\w[^\]]*\]/g, "")
      .replace(/@\w+/g, "")
      .trim();
    if (clean) result.push(clean);
    if (result.length >= 3) break;
  }
  return result.join("  ·  ").slice(0, 180);
}

// ── Page creation ─────────────────────────────────────────────────────────────

function handleCreateFile(target: vscode.WebviewPanel): void {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }
  const id = generateId();
  const filePath = path.join(root, `${id} Untitled.md`);
  const content = "# Untitled\n\n";
  fs.writeFileSync(filePath, content, "utf8");
  pageIndex.updateEntry(filePath, content);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
  sendFileIndex();
  sendFileTo(filePath, target);
}

function handleCreateDailyNote(target: vscode.WebviewPanel): void {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const existing = pageIndex.getByDisplayName(dateStr);
  if (existing) { sendFileTo(existing.fsPath, target); return; }
  const id = generateId();
  const filePath = path.join(root, `${id} ${dateStr}.md`);
  const content = `# ${dateStr}\n\n`;
  fs.writeFileSync(filePath, content, "utf8");
  pageIndex.updateEntry(filePath, content);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
  sendFileIndex();
  sendFileTo(filePath, target);
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
  favoritesProvider?.setPageIndex(pageIndex);
}

function updateTagIndexForFile(filePath: string, content: string): void {
  if (!tagTreeProvider) return;
  const index: TagIndex = tagTreeProvider.getIndex();
  for (const files of index.values()) {
    const i = files.indexOf(filePath);
    if (i >= 0) files.splice(i, 1);
  }
  for (const [tag, files] of index) {
    if (files.length === 0) index.delete(tag);
  }
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
