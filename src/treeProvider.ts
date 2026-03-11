import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { PageIndex, PageEntry } from "./pageIndex";

// ── Tree item ─────────────────────────────────────────────────────────────────

export class HomeTreeItem extends vscode.TreeItem {
  constructor() {
    super("Home", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("home");
    this.command = { command: "valt.showHome", title: "Show Home" };
    this.contextValue = "valtHome";
  }
}

export class ValtTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fsPath: string,
    /** Sibling folder path if this page has children, otherwise null. */
    public readonly childrenDir: string | null,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);

    this.contextValue = "valtPage";
    this.command = {
      command: "valt.openFile",
      title: "Open File",
      arguments: [fsPath],
    };
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

type AnyValtItem = HomeTreeItem | ValtTreeItem;

export class ValtTreeProvider
  implements
    vscode.TreeDataProvider<AnyValtItem>,
    vscode.TreeDragAndDropController<ValtTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AnyValtItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onFileMoved = new vscode.EventEmitter<void>();
  readonly onFileMoved = this._onFileMoved.event;

  readonly dragMimeTypes = ["application/vnd.code.tree.valt.fileTree"];
  readonly dropMimeTypes = ["application/vnd.code.tree.valt.fileTree"];

  private pageIndex: PageIndex | null = null;

  constructor(private readonly rootPath: string, pageIndex?: PageIndex) {
    this.pageIndex = pageIndex ?? null;
  }

  setPageIndex(index: PageIndex): void {
    this.pageIndex = index;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AnyValtItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ValtTreeItem): (HomeTreeItem | ValtTreeItem)[] {
    if (element) {
      if (!element.childrenDir) return [];
      return this.readPagesInDir(element.childrenDir);
    }
    return [new HomeTreeItem(), ...this.readPagesInDir(this.rootPath)];
  }

  async handleDrag(
    source: readonly ValtTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    dataTransfer.set(
      "application/vnd.code.tree.valt.fileTree",
      new vscode.DataTransferItem(source.map((item) => item.fsPath))
    );
  }

  async handleDrop(
    target: ValtTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const transferItem = dataTransfer.get("application/vnd.code.tree.valt.fileTree");
    if (!transferItem) return;

    const sourcePaths: string[] = transferItem.value;

    // Dropping onto a page → move into its children folder (created if needed).
    // Dropping onto blank space → move to root.
    let targetDir: string;
    if (!target) {
      targetDir = this.rootPath;
    } else {
      const stem = path.basename(target.fsPath, ".md");
      targetDir = path.join(path.dirname(target.fsPath), stem);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    }

    let moved = false;
    for (const srcPath of sourcePaths) {
      if (path.dirname(srcPath) === targetDir) continue;

      const basename = path.basename(srcPath);
      const destPath = path.join(targetDir, basename);

      // Also move the sibling children folder if it exists.
      const stem = path.basename(srcPath, ".md");
      const srcSiblingDir = path.join(path.dirname(srcPath), stem);
      const destSiblingDir = path.join(targetDir, stem);

      try {
        fs.renameSync(srcPath, destPath);
        moved = true;
        if (fs.existsSync(srcSiblingDir) && fs.statSync(srcSiblingDir).isDirectory()) {
          fs.renameSync(srcSiblingDir, destSiblingDir);
        }
      } catch {
        vscode.window.showErrorMessage(`Valt: Could not move "${basename}"`);
      }
    }

    if (moved) {
      this._onFileMoved.fire();
      this.refresh();
    }
  }

  private readPagesInDir(dir: string): ValtTreeItem[] {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const items: ValtTreeItem[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const fullPath = path.join(dir, entry.name);
      const stem = entry.name.replace(/\.md$/, "");
      const siblingDir = path.join(dir, stem);
      const hasChildren =
        fs.existsSync(siblingDir) && fs.statSync(siblingDir).isDirectory();

      const label = this.labelFor(fullPath, entry.name);
      items.push(
        new ValtTreeItem(
          label,
          fullPath,
          hasChildren ? siblingDir : null,
          hasChildren
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        )
      );
    }

    return this.sortItems(items);
  }

  private labelFor(fsPath: string, basename: string): string {
    const entry: PageEntry | undefined = this.pageIndex?.getByPath(fsPath);
    if (entry) {
      return entry.emoji ? `${entry.emoji} ${entry.displayName}` : entry.displayName;
    }
    return basename.replace(/\.md$/, "").replace(/^\d+\s+/, "");
  }

  private sortItems(items: ValtTreeItem[]): ValtTreeItem[] {
    return items.sort((a, b) => {
      const entryA = this.pageIndex?.getByPath(a.fsPath);
      const entryB = this.pageIndex?.getByPath(b.fsPath);

      const idA = entryA?.id ?? null;
      const idB = entryB?.id ?? null;

      if (idA !== null && idB !== null) return idA - idB;
      if (idA !== null) return -1;
      if (idB !== null) return 1;
      return (a.label as string).localeCompare(b.label as string);
    });
  }
}
