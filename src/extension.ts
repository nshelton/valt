import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import { ValtTreeProvider, ValtTreeItem, ValtDatabaseItem } from "./treeProvider";
import { ValtTagTreeProvider, TagIndex } from "./tagTreeProvider";
import { FavoritesTreeProvider } from "./favoritesProvider";
import { PageIndex, generateId, extractTitle, extractEmoji, extractPageLinks } from "./pageIndex";
import { DatabaseIndex, parseFrontmatter, replaceFrontmatter } from "./databaseIndex";
import type { RecentFileEntry, PageLink, DatabaseSchema } from "./shared/messages";
import type { ExtensionMessage, WebviewMessage } from "./shared/messages";
import { assertNever } from "./shared/messages";

// panels[panels.length - 1] is always the most-recently-focused panel.
interface PanelState {
  panel: vscode.WebviewPanel;
  currentFilePath: string;
}
let panels: PanelState[] = [];
let treeProvider: ValtTreeProvider | undefined;
let tagTreeProvider: ValtTagTreeProvider | undefined;
let favoritesProvider: FavoritesTreeProvider | undefined;
const pageIndex = new PageIndex();
const dbIndex = new DatabaseIndex();
let extensionContext: vscode.ExtensionContext | undefined;
let outputChannel: vscode.OutputChannel;
let suppressWatcher = false;

function getActivePanel(): PanelState | undefined {
  return panels[panels.length - 1];
}

function broadcastToAll(msg: ExtensionMessage): void {
  for (const ps of panels) ps.panel.webview.postMessage(msg);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Valt");
  context.subscriptions.push(outputChannel);
  const workspaceRoot = getWorkspaceRoot();

  treeProvider = new ValtTreeProvider(workspaceRoot ?? "", pageIndex);
  tagTreeProvider = new ValtTagTreeProvider();
  const favoritesFile = workspaceRoot ? path.join(workspaceRoot, ".valt-favorites") : "";
  favoritesProvider = new FavoritesTreeProvider(favoritesFile);
  treeProvider.setFavoritesProvider(favoritesProvider);

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
        active.panel.reveal(active.panel.viewColumn ?? vscode.ViewColumn.One);
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
      active.panel.reveal(active.panel.viewColumn ?? vscode.ViewColumn.One);
      active.panel.webview.postMessage({ type: "showHome" } satisfies ExtensionMessage);
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

      const { filePath } = createNewPage(targetDir);
      sendFileToWebview(filePath);
    }
  );

  const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("valt.tagColors")) {
      tagTreeProvider?.refresh();
    }
  });

  const mdWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
  const dbWatcher = vscode.workspace.createFileSystemWatcher("**/.valtdb.json");
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRebuild = () => {
    if (suppressWatcher) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildIndexes(), 500);
  };
  mdWatcher.onDidCreate(debouncedRebuild);
  mdWatcher.onDidDelete(debouncedRebuild);
  mdWatcher.onDidChange(debouncedRebuild);
  dbWatcher.onDidCreate(debouncedRebuild);
  dbWatcher.onDidDelete(debouncedRebuild);
  dbWatcher.onDidChange((uri) => {
    // Notify open panels if they are showing this database
    const folderPath = path.dirname(uri.fsPath);
    const refreshed = dbIndex.refreshDatabase(folderPath);
    if (refreshed) {
      broadcastToAll({
        type: "databaseSchemaUpdated",
        folderPath,
        schema: refreshed.schema,
      } satisfies ExtensionMessage);
    }
  });

  const removeFavoriteCmd = vscode.commands.registerCommand(
    "valt.removeFromFavorites",
    (item?: { fsPath?: string }) => {
      if (item?.fsPath) {
        favoritesProvider?.removeFromFavorites(item.fsPath);
        treeProvider?.refresh();
      }
    }
  );

  const deletePageCmd = vscode.commands.registerCommand(
    "valt.deletePage",
    async (item?: ValtTreeItem) => {
      if (!item?.fsPath) return;
      const fileName = path.basename(item.fsPath);
      const answer = await vscode.window.showWarningMessage(
        `Delete "${fileName}"? This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (answer !== "Delete") return;
      try {
        fs.unlinkSync(item.fsPath);
        pageIndex.removeEntry(item.fsPath);
        treeProvider?.setPageIndex(pageIndex);
        treeProvider?.refresh();
        broadcastToAll({ type: "showHome" } satisfies ExtensionMessage);
      } catch (err) {
        outputChannel.appendLine(`Delete page failed (${item.fsPath}): ${err}`);
        vscode.window.showErrorMessage("Valt: Could not delete page.");
      }
    }
  );

  const deleteDatabaseCmd = vscode.commands.registerCommand(
    "valt.deleteDatabase",
    async (item?: ValtDatabaseItem) => {
      if (!item?.fsPath) return;
      const folderName = path.basename(item.fsPath).replace(/^[0-9a-f]{8}\s+/, "");
      const answer = await vscode.window.showWarningMessage(
        `Delete database "${folderName}" and all its rows? This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (answer !== "Delete") return;
      try {
        fs.rmSync(item.fsPath, { recursive: true, force: true });
        treeProvider?.refresh();
      } catch (err) {
        outputChannel.appendLine(`Delete database failed (${item.fsPath}): ${err}`);
        vscode.window.showErrorMessage("Valt: Could not delete database.");
      }
    }
  );

  context.subscriptions.push(
    favoritesTreeView, fileTreeView, tagTreeView,
    openCmd, openFileCmd, refreshCmd, showHomeCmd, setTagColorCmd,
    newSubPageCmd, removeFavoriteCmd, deletePageCmd, deleteDatabaseCmd,
    cfgWatcher, mdWatcher, dbWatcher,
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
  const ps: PanelState = { panel: p, currentFilePath: "" };
  panels.push(ps);

  // Per-panel state (in closure)
  const lastOpen = extensionContext?.globalState.get<string>("valt.lastOpenPath");
  let pending = pendingFilePath ?? lastOpen;

  p.webview.onDidReceiveMessage(
    (raw: unknown) => {
      const message = validateWebviewMessage(raw);
      if (!message) return;
      handleWebviewMessage(message, ps, () => {
        if (pending) { sendFileTo(pending, ps); pending = undefined; }
      });
    },
    undefined,
    context.subscriptions
  );

  p.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      // Move to end of array so getActivePanel() returns this one.
      panels = panels.filter((x) => x !== ps);
      panels.push(ps);
    }
  }, undefined, context.subscriptions);

  p.onDidDispose(() => {
    panels = panels.filter((x) => x !== ps);
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

// ── Message validation ────────────────────────────────────────────────────────

const KNOWN_WEBVIEW_TYPES = new Set<string>([
  "ready", "requestFile", "saveFile", "createFile", "createDailyNote",
  "toggleFavorite", "saveImage", "createPageFromEditor", "saveRowProperty",
  "saveDatabaseSchema", "createDatabaseRow", "deleteDatabaseRow",
  "requestDatabase", "createDatabase", "deleteFile", "deleteDatabase",
  "openUrl", "fetchLinkMetadata",
]);

function validateWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>).type !== "string") {
    console.warn("Valt: Received malformed webview message:", raw);
    return null;
  }
  const msg = raw as WebviewMessage;
  if (!KNOWN_WEBVIEW_TYPES.has(msg.type)) {
    console.warn(`Valt: Unknown webview message type: "${msg.type}"`);
    return null;
  }
  // Validate critical data-carrying messages
  if (msg.type === "saveFile" && (typeof msg.filePath !== "string" || typeof msg.content !== "string")) {
    console.warn("Valt: Malformed saveFile message — missing filePath or content");
    return null;
  }
  return msg;
}

// ── Message handlers ──────────────────────────────────────────────────────────

function handleWebviewMessage(
  message: WebviewMessage,
  source: PanelState,
  onReady?: () => void,
): void {
  switch (message.type) {
    case "ready":
      sendFileIndexTo(source);
      sendTagIndexTo(source);
      sendRecentFilesTo(source);
      onReady?.();
      break;
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
    case "saveImage":
      handleSaveImage(message.currentFilePath, message.data, message.mimeType, source);
      break;
    case "createPageFromEditor":
      handleCreatePageFromEditor(message.currentFilePath, source);
      break;
    case "saveRowProperty":
      handleSaveRowProperty(message.rowPath, message.colId, message.value);
      break;
    case "saveDatabaseSchema":
      handleSaveDatabaseSchema(message.folderPath, message.schema);
      break;
    case "createDatabaseRow":
      handleCreateDatabaseRow(message.folderPath, message.title, message.properties, source);
      break;
    case "deleteDatabaseRow":
      handleDeleteDatabaseRow(message.rowPath, source);
      break;
    case "requestDatabase":
      sendDatabaseTo(message.folderPath, source);
      break;
    case "createDatabase":
      handleCreateDatabase(message.parentDir, source);
      break;
    case "deleteFile":
      handleDeleteFile(message.filePath, source);
      break;
    case "deleteDatabase":
      handleDeleteDatabase(message.folderPath, source);
      break;
    case "openUrl":
      vscode.env.openExternal(vscode.Uri.parse(message.url));
      break;
    case "fetchLinkMetadata":
      fetchLinkMetadata(message.url).then((meta) => {
        source.panel.webview.postMessage({
          type: "linkMetadata",
          url: message.url,
          title: meta.title,
          faviconDataUrl: meta.faviconDataUrl,
        } satisfies ExtensionMessage);
      }).catch(() => {
        source.panel.webview.postMessage({
          type: "linkMetadata",
          url: message.url,
          title: null,
          faviconDataUrl: null,
        } satisfies ExtensionMessage);
      });
      break;
    default:
      assertNever(message);
  }
}

function handleSaveImage(
  currentFilePath: string,
  data: string,
  mimeType: string,
  target: PanelState
): void {
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const id = generateId();
  const dir = path.dirname(currentFilePath);
  const filename = `img-${id}.${ext}`;
  const absPath = path.join(dir, filename);
  atomicWriteSync(absPath, Buffer.from(data, "base64"));
  const relativePath = `./${filename}`;
  target.panel.webview.postMessage({ type: "imageSaved", relativePath } satisfies ExtensionMessage);
}

function handleToggleFavorite(filePath: string, target: PanelState): void {
  const isFavorited = favoritesProvider?.toggleFavorite(filePath) ?? false;
  treeProvider?.refresh();
  // Broadcast to all panels showing this file, not just the requester
  for (const ps of panels) {
    if (ps === target || ps.currentFilePath === filePath) {
      ps.panel.webview.postMessage({ type: "favorites", isFavorited } satisfies ExtensionMessage);
    }
  }
}

function handleRequestFile(pathOrName: string, target: PanelState): void {
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

// Send a database folder to a specific panel.
function sendDatabaseTo(folderPath: string, target: PanelState): void {
  const data = dbIndex.loadDatabase(folderPath);
  if (!data) {
    vscode.window.showErrorMessage(`Valt: Could not load database at: ${folderPath}`);
    return;
  }
  target.panel.webview.postMessage({
    type: "openDatabase",
    folderPath,
    schema: data.schema,
    rows: data.rows,
  } satisfies ExtensionMessage);
}

// Send a file to a specific panel.
function sendFileTo(filePath: string, target: PanelState): void {
  // Detect if filePath is actually a database folder
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    if (fs.existsSync(path.join(filePath, ".valtdb.json"))) {
      sendDatabaseTo(filePath, target);
      return;
    }
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const dirUri = vscode.Uri.file(path.dirname(filePath));
    const webviewBaseUri = target.panel.webview.asWebviewUri(dirUri).toString();

    const backlinks: PageLink[] = pageIndex.getLinkers(filePath).map((p) => {
      const e = pageIndex.getByPath(p);
      return { displayName: e?.displayName ?? path.basename(p, ".md"), fsPath: p, emoji: e?.emoji ?? null };
    });

    const outgoingLinks: PageLink[] = extractPageLinks(content).flatMap((uuid) => {
      const e = pageIndex.getById(uuid);
      return e ? [{ displayName: e.displayName, fsPath: e.fsPath, emoji: e.emoji }] : [];
    });

    const currentEntry = pageIndex.getByPath(filePath);
    const currentDisplayName = currentEntry?.displayName ?? "";
    const stripUuid = (s: string) => s.replace(/^[0-9a-f]{8}\s+/i, "");
    const children: PageLink[] = currentDisplayName
      ? pageIndex.getAll().filter((e) => {
          const dirBasename = path.basename(path.dirname(e.fsPath));
          return stripUuid(dirBasename) === currentDisplayName;
        }).map((e) => ({ displayName: e.displayName, fsPath: e.fsPath, emoji: e.emoji }))
      : [];

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
      ? rel.split(path.sep).filter(Boolean).map((seg, i, segs) => ({
          name: seg.replace(/^[0-9a-f]{8}\s+/, ""),
          fsPath: root ? path.join(root, ...segs.slice(0, i + 1)) : "",
        }))
      : [];

    const isFavorited = favoritesProvider?.isFavorite(filePath) ?? false;
    const msg: ExtensionMessage = {
      type: "openFile", path: filePath, content, webviewBaseUri,
      backlinks, outgoingLinks, children, createdAt, modifiedAt, breadcrumb, isFavorited,
    };
    target.panel.webview.postMessage(msg);
    target.currentFilePath = filePath;
    pushRecent(filePath);
    extensionContext?.globalState.update("valt.lastOpenPath", filePath);
    sendRecentFiles();
  } catch (err) {
    outputChannel.appendLine(`Read file failed (${filePath}): ${err}`);
    vscode.window.showErrorMessage(`Valt: Could not read file: ${filePath}`);
  }
}

// Convenience: send to the active panel (sidebar file-opens, new page creation, etc.)
function sendFileToWebview(filePath: string): void {
  const active = getActivePanel();
  if (active) sendFileTo(filePath, active);
}

function sendFileIndexTo(ps: PanelState): void {
  ps.panel.webview.postMessage({ type: "fileIndex", pages: pageIndex.toPageInfos() } satisfies ExtensionMessage);
}

function sendTagIndexTo(ps: PanelState): void {
  const index = tagTreeProvider ? [...tagTreeProvider.getIndex().entries()] : [];
  const tags: Record<string, string[]> = {};
  const colors: Record<string, string> = {};
  for (const [tag, files] of index) {
    tags[tag] = files.map((f) => path.basename(f));
    if (tagTreeProvider) colors[tag] = tagTreeProvider.colorFor(tag);
  }
  ps.panel.webview.postMessage({ type: "tagIndex", tags, colors } satisfies ExtensionMessage);
}

function sendRecentFilesTo(ps: PanelState): void {
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
  ps.panel.webview.postMessage({ type: "recentFiles", files } satisfies ExtensionMessage);
}

function sendFileIndex(): void { for (const p of panels) sendFileIndexTo(p); }
function sendTagIndex(): void  { for (const p of panels) sendTagIndexTo(p); }
function sendRecentFiles(): void { for (const p of panels) sendRecentFilesTo(p); }

function handleSaveFile(filePath: string, content: string): void {
  suppressWatcher = true;
  try {
    atomicWriteSync(filePath, content);
  } catch (err) {
    suppressWatcher = false;
    outputChannel.appendLine(`Save file failed (${filePath}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not save file.");
    return;
  }

  const renameResult = pageIndex.computeRename(filePath, content);

  if (renameResult.needsRename) {
    const { newPath, newFilename } = renameResult;

    try {
      fs.renameSync(filePath, newPath);
    } catch (err) {
      suppressWatcher = false;
      outputChannel.appendLine(`Rename failed (${filePath} → ${newFilename}): ${err}`);
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
  suppressWatcher = false;

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

const PAGE_EMOJIS = ["📝", "💡", "🌟", "🎯", "🔮", "🧭", "🌿", "⚡", "🎨", "🔬", "📚", "🌈", "🚀", "🧩", "💎", "🎲", "🦋", "🌊", "🔑", "🎪"];

function randomPageEmoji(): string {
  return PAGE_EMOJIS[Math.floor(Math.random() * PAGE_EMOJIS.length)];
}

function createNewPage(dir: string): { filePath: string; id: string } {
  const id = generateId();
  const emoji = randomPageEmoji();
  const filePath = path.join(dir, `${id} New Page.md`);
  const content = `# ${emoji} New Page\n\n`;
  atomicWriteSync(filePath, content);
  pageIndex.updateEntry(filePath, content);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
  sendFileIndex();
  return { filePath, id };
}

function handleCreateFile(target: PanelState): void {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }
  const { filePath } = createNewPage(root);
  sendFileTo(filePath, target);
}

function handleCreatePageFromEditor(currentFilePath: string, target: PanelState): void {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }
  const stem = path.basename(currentFilePath, ".md");
  const targetDir = path.join(path.dirname(currentFilePath), stem);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const { filePath, id } = createNewPage(targetDir);
  target.panel.webview.postMessage({ type: "insertPageLink", uuid: id } satisfies ExtensionMessage);
  sendFileTo(filePath, target);
}

function handleCreateDailyNote(target: PanelState): void {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Valt: No workspace folder open."); return; }
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const existing = pageIndex.getByDisplayName(dateStr);
  if (existing) { sendFileTo(existing.fsPath, target); return; }
  const id = generateId();
  const filePath = path.join(root, `${id} ${dateStr}.md`);
  const content = `# ${dateStr}\n\n`;
  atomicWriteSync(filePath, content);
  pageIndex.updateEntry(filePath, content);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
  sendFileIndex();
  sendFileTo(filePath, target);
}

// ── Database handlers ──────────────────────────────────────────────────────────

function handleSaveRowProperty(rowPath: string, colId: string, value: unknown): void {
  try {
    const content = fs.readFileSync(rowPath, "utf8");
    const { properties, body } = parseFrontmatter(content);
    properties[colId] = value;
    const newContent = replaceFrontmatter(body ? `---\n\n---\n${body}` : content, properties);
    // Reconstruct properly
    const yamlLines = Object.entries(properties)
      .map(([k, v]) => `${k}: ${serializeYamlValue(v)}`)
      .join("\n");
    const bodyContent = parseFrontmatter(content).body;
    const updated = `---\n${yamlLines}\n---\n${bodyContent}`;
    atomicWriteSync(rowPath, updated);
  } catch (err) {
    outputChannel.appendLine(`Save row property failed (${rowPath}, ${colId}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not save row property.");
  }
}

function serializeYamlValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    const items = val.map((v) => serializeYamlValue(v)).join(", ");
    return `[${items}]`;
  }
  const str = String(val);
  if (/[:#\[\]{}|>&*!,'"]/g.test(str) || str === "true" || str === "false" || str === "null") {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return str;
}

function handleSaveDatabaseSchema(folderPath: string, schema: DatabaseSchema): void {
  try {
    const schemaPath = path.join(folderPath, ".valtdb.json");
    atomicWriteSync(schemaPath, JSON.stringify(schema, null, 2));
    dbIndex.refreshDatabase(folderPath);
  } catch (err) {
    outputChannel.appendLine(`Save database schema failed (${folderPath}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not save database schema.");
  }
}

function handleCreateDatabaseRow(
  folderPath: string,
  title: string,
  properties: Record<string, unknown>,
  target: PanelState,
): void {
  const root = getWorkspaceRoot();
  if (!root) return;
  const id = generateId();
  const safeName = title.replace(/[\\/:*?"<>|]/g, "").trim() || "New Row";
  const filename = `${id} ${safeName}.md`;
  const filePath = path.join(folderPath, filename);

  const yamlLines = Object.entries(properties)
    .map(([k, v]) => `${k}: ${serializeYamlValue(v)}`)
    .join("\n");
  const content = `---\n${yamlLines}\n---\n\n# ${safeName}\n\n`;
  atomicWriteSync(filePath, content);
  pageIndex.updateEntry(filePath, content);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();

  // Refresh the database view
  sendDatabaseTo(folderPath, target);
}

async function handleDeleteFile(filePath: string, target: PanelState): Promise<void> {
  const fileName = path.basename(filePath);
  const answer = await vscode.window.showWarningMessage(
    `Delete "${fileName}"? This cannot be undone.`,
    { modal: true },
    "Delete"
  );
  if (answer !== "Delete") return;
  try {
    fs.unlinkSync(filePath);
    pageIndex.removeEntry(filePath);
    treeProvider?.setPageIndex(pageIndex);
    treeProvider?.refresh();
    broadcastToAll({ type: "showHome" } satisfies ExtensionMessage);
  } catch (err) {
    outputChannel.appendLine(`Delete file failed (${filePath}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not delete page.");
  }
}

async function handleDeleteDatabase(folderPath: string, target: PanelState): Promise<void> {
  const folderName = path.basename(folderPath).replace(/^[0-9a-f]{8}\s+/, "");
  const answer = await vscode.window.showWarningMessage(
    `Delete database "${folderName}" and all its rows? This cannot be undone.`,
    { modal: true },
    "Delete"
  );
  if (answer !== "Delete") return;
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
    treeProvider?.refresh();
    broadcastToAll({ type: "showHome" } satisfies ExtensionMessage);
  } catch (err) {
    outputChannel.appendLine(`Delete database failed (${folderPath}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not delete database.");
  }
}

function handleDeleteDatabaseRow(rowPath: string, target: PanelState): void {
  try {
    const folderPath = path.dirname(rowPath);
    fs.unlinkSync(rowPath);
    pageIndex.removeEntry(rowPath);
    treeProvider?.setPageIndex(pageIndex);
    treeProvider?.refresh();
    sendDatabaseTo(folderPath, target);
  } catch (err) {
    outputChannel.appendLine(`Delete database row failed (${rowPath}): ${err}`);
    vscode.window.showErrorMessage("Valt: Could not delete database row.");
  }
}

function handleCreateDatabase(parentDir: string, target: PanelState): void {
  const id = generateId();
  const folderName = `${id} New Database`;
  const folderPath = path.join(parentDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  const schema: DatabaseSchema = {
    schemaVersion: 1,
    columns: [
      { id: "col_01", name: "Status", type: "select", options: ["Todo", "In Progress", "Done"] },
    ],
    views: [
      { id: "view_01", type: "table", name: "All", sort: [], filters: [] },
    ],
    defaultView: "view_01",
  };

  atomicWriteSync(
    path.join(folderPath, ".valtdb.json"),
    JSON.stringify(schema, null, 2)
  );

  treeProvider?.refresh();
  sendDatabaseTo(folderPath, target);
}

// ── Link metadata fetcher ─────────────────────────────────────────────────────

interface LinkMeta { title: string | null; faviconDataUrl: string | null; }

const LINK_META_CACHE_MAX = 500;
const linkMetaCache = new Map<string, LinkMeta>();

function linkMetaCacheSet(key: string, value: LinkMeta): void {
  // Delete first so re-insertion moves to end (preserves insertion order for LRU)
  linkMetaCache.delete(key);
  linkMetaCache.set(key, value);
  if (linkMetaCache.size > LINK_META_CACHE_MAX) {
    // Delete oldest entries (first in iteration order)
    const excess = linkMetaCache.size - LINK_META_CACHE_MAX;
    let i = 0;
    for (const k of linkMetaCache.keys()) {
      if (i++ >= excess) break;
      linkMetaCache.delete(k);
    }
  }
}

async function fetchLinkMetadata(url: string): Promise<LinkMeta> {
  if (linkMetaCache.has(url)) return linkMetaCache.get(url)!;
  try {
    const html = await fetchHtml(url);
    const title = extractHtmlTitle(html);
    const faviconUrl = extractFaviconUrl(html, url);
    const faviconDataUrl = faviconUrl ? await fetchFaviconAsDataUrl(faviconUrl) : null;
    const result: LinkMeta = { title, faviconDataUrl };
    linkMetaCacheSet(url, result);
    return result;
  } catch {
    const result: LinkMeta = { title: null, faviconDataUrl: null };
    linkMetaCacheSet(url, result);
    return result;
  }
}

function fetchHtml(url: string, redirectsLeft = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    let destroyed = false;
    const req = lib.get(url, { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (
        redirectsLeft > 0 &&
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchHtml(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        // Stop reading once we have the <head> section — no need for the full page
        if (body.length > 65_536 || body.includes("</head>")) {
          destroyed = true;
          req.destroy();
          resolve(body);
        }
      });
      res.on("end", () => resolve(body));
      res.on("error", (e) => { if (!destroyed) reject(e); });
      res.on("close", () => resolve(body));
    });
    req.on("error", (e) => { if (!destroyed) reject(e); });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function extractHtmlTitle(html: string): string | null {
  // Prefer og:title, fall back to <title>
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) return decodeHtmlEntities(og[1].trim());
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return title ? decodeHtmlEntities(title[1].trim()) : null;
}

function extractFaviconUrl(html: string, pageUrl: string): string | null {
  const origin = new URL(pageUrl).origin;
  const m = html.match(/<link[^>]+rel=["'][^"']*(?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*(?:shortcut )?icon["']/i);
  if (m) {
    const href = m[1];
    if (href.startsWith("http")) return href;
    if (href.startsWith("//"))   return `https:${href}`;
    if (href.startsWith("/"))    return `${origin}${href}`;
    return `${origin}/${href}`;
  }
  return `${origin}/favicon.ico`;
}

function fetchFaviconAsDataUrl(url: string, redirectsLeft = 3): Promise<string | null> {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      // Follow redirects — favicons are often behind a redirect chain
      if (
        redirectsLeft > 0 &&
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchFaviconAsDataUrl(next, redirectsLeft - 1).then(resolve);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        resolve(null); return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        // Strip charset/params from content-type so the data URL is valid
        const ct = (res.headers["content-type"] ?? "image/x-icon").split(";")[0].trim();
        resolve(`data:${ct};base64,${buf.toString("base64")}`);
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
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
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        buildTagIndexFromContent(result.value.fsPath, result.value.content, tagIdx);
        pageFiles.push(result.value);
      } else {
        outputChannel.appendLine(`Index: failed to read ${batch[j].fsPath}: ${result.reason}`);
      }
    }
  }

  tagTreeProvider?.setIndex(tagIdx);
  pageIndex.build(pageFiles);
  treeProvider?.setPageIndex(pageIndex);
  treeProvider?.refresh();
  favoritesProvider?.setPageIndex(pageIndex);

  const root = getWorkspaceRoot();
  if (root) dbIndex.build(root);
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

/** Write to temp file then rename — atomic on all major filesystems. */
function atomicWriteSync(filePath: string, content: string | Buffer, encoding?: BufferEncoding): void {
  const tmp = filePath + ".valt-tmp";
  try {
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(tmp, content);
    } else {
      fs.writeFileSync(tmp, content, encoding ?? "utf8");
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

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
