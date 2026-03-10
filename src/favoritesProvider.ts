import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { PageIndex } from "./pageIndex";

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

  // Accept drops from the file tree; favorites items themselves are not draggable
  readonly dragMimeTypes: string[] = [];
  readonly dropMimeTypes = ["application/vnd.code.tree.valt.fileTree"];

  private favorites: string[] = [];
  private pageIndex: PageIndex | null = null;

  constructor(private readonly storage: vscode.Memento) {
    this.favorites = this.storage.get<string[]>("valt.favorites", []);
  }

  setPageIndex(index: PageIndex): void {
    this.pageIndex = index;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FavoriteItem): vscode.TreeItem {
    return element;
  }

  getChildren(): FavoriteItem[] {
    return this.favorites
      .filter((p) => fs.existsSync(p))
      .map((p) => {
        const entry = this.pageIndex?.getByPath(p);
        const label = entry?.displayName ?? path.basename(p, ".md");
        return new FavoriteItem(p, label, entry?.emoji);
      });
  }

  async handleDrag(): Promise<void> {
    // Not draggable — favorites are bookmark references, not movable items
  }

  async handleDrop(
    _target: FavoriteItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const item = dataTransfer.get("application/vnd.code.tree.valt.fileTree");
    if (!item) return;

    const paths: string[] = item.value;
    let changed = false;
    for (const p of paths) {
      if (!this.favorites.includes(p)) {
        this.favorites.push(p);
        changed = true;
      }
    }
    if (changed) {
      await this.storage.update("valt.favorites", this.favorites);
      this._onDidChangeTreeData.fire();
    }
  }

  async removeFromFavorites(fsPath: string): Promise<void> {
    const i = this.favorites.indexOf(fsPath);
    if (i >= 0) {
      this.favorites.splice(i, 1);
      await this.storage.update("valt.favorites", this.favorites);
      this._onDidChangeTreeData.fire();
    }
  }
}
