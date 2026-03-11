import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { PageIndex } from "./pageIndex";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the 8-char hex UUID prefix from a file basename, or null. */
function idFromPath(fsPath: string): string | null {
  const basename = path.basename(fsPath);
  const m = basename.match(/^([0-9a-f]{8})\s/);
  return m ? m[1] : null;
}

/** The storage key for a given file: UUID if available, else "path:<absPath>". */
function storageKey(fsPath: string): string {
  return idFromPath(fsPath) ?? `path:${fsPath}`;
}

// ── Tree item ─────────────────────────────────────────────────────────────────

export class FavoriteItem extends vscode.TreeItem {
  constructor(
    public readonly fsPath: string,
    label: string,
    emoji?: string
  ) {
    super(emoji ? `${emoji} ${label}` : label, vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(fsPath);
    this.contextValue = "valtFavorite";
    this.command = {
      command: "valt.openFile",
      title: "Open File",
      arguments: [fsPath],
    };
    this.iconPath = new vscode.ThemeIcon("star-full");
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class FavoritesTreeProvider
  implements
    vscode.TreeDataProvider<FavoriteItem>,
    vscode.TreeDragAndDropController<FavoriteItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dragMimeTypes: string[] = [];
  readonly dropMimeTypes = ["application/vnd.code.tree.valt.fileTree"];

  /** Set of storage keys (UUID or "path:<abs>") currently favorited. */
  private favoriteKeys: Set<string> = new Set();
  private pageIndex: PageIndex | null = null;

  constructor(private readonly favoritesFilePath: string) {
    this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.favoritesFilePath)) {
        const lines = fs.readFileSync(this.favoritesFilePath, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        this.favoriteKeys = new Set(lines);
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(
        this.favoritesFilePath,
        [...this.favoriteKeys].join("\n") + (this.favoriteKeys.size ? "\n" : ""),
        "utf8"
      );
    } catch { /* ignore */ }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  isFavorite(fsPath: string): boolean {
    return this.favoriteKeys.has(storageKey(fsPath));
  }

  /** Toggle favorite status. Returns the new state. */
  toggleFavorite(fsPath: string): boolean {
    const key = storageKey(fsPath);
    if (this.favoriteKeys.has(key)) {
      this.favoriteKeys.delete(key);
    } else {
      this.favoriteKeys.add(key);
    }
    this.save();
    this._onDidChangeTreeData.fire();
    return this.favoriteKeys.has(key);
  }

  setPageIndex(index: PageIndex): void {
    this.pageIndex = index;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ── TreeDataProvider ─────────────────────────────────────────────────────────

  getTreeItem(element: FavoriteItem): vscode.TreeItem {
    return element;
  }

  getChildren(): FavoriteItem[] {
    if (!this.pageIndex) return [];

    const items: FavoriteItem[] = [];
    for (const key of this.favoriteKeys) {
      let entry;
      if (key.startsWith("path:")) {
        const fsPath = key.slice(5);
        entry = this.pageIndex.getByPath(fsPath);
        if (!entry || !fs.existsSync(fsPath)) continue;
        items.push(new FavoriteItem(fsPath, entry.displayName, entry.emoji ?? undefined));
      } else {
        entry = this.pageIndex.getById(key);
        if (!entry || !fs.existsSync(entry.fsPath)) continue;
        items.push(new FavoriteItem(entry.fsPath, entry.displayName, entry.emoji ?? undefined));
      }
    }
    return items;
  }

  // ── Drag and Drop ────────────────────────────────────────────────────────────

  async handleDrag(): Promise<void> {}

  async handleDrop(
    _target: FavoriteItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const item = dataTransfer.get("application/vnd.code.tree.valt.fileTree");
    if (!item) return;

    const paths: string[] = item.value;
    for (const p of paths) {
      this.favoriteKeys.add(storageKey(p));
    }
    this.save();
    this._onDidChangeTreeData.fire();
  }

  async removeFromFavorites(fsPath: string): Promise<void> {
    this.favoriteKeys.delete(storageKey(fsPath));
    this.save();
    this._onDidChangeTreeData.fire();
  }
}
