import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { PageIndex, PageEntry } from "./pageIndex";

// ── Tree item ─────────────────────────────────────────────────────────────────

export class ValtTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fsPath: string,
    public readonly isDirectory: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);

    this.resourceUri = vscode.Uri.file(fsPath);
    this.contextValue = isDirectory ? "valtDirectory" : "valtFile";

    if (!isDirectory) {
      this.command = {
        command: "valt.openFile",
        title: "Open File",
        arguments: [fsPath],
      };
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ValtTreeProvider
  implements
    vscode.TreeDataProvider<ValtTreeItem>,
    vscode.TreeDragAndDropController<ValtTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ValtTreeItem | undefined | null | void>();
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

  getTreeItem(element: ValtTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ValtTreeItem): ValtTreeItem[] {
    const dir = element ? element.fsPath : this.rootPath;
    return this.readDirectory(dir);
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

    const targetDir = !target
      ? this.rootPath
      : target.isDirectory
      ? target.fsPath
      : path.dirname(target.fsPath);

    let moved = false;
    for (const srcPath of sourcePaths) {
      // Skip if already in the target directory
      if (path.dirname(srcPath) === targetDir) continue;
      // Skip if dropping a directory into itself or a descendant
      if (targetDir === srcPath || targetDir.startsWith(srcPath + path.sep)) continue;

      const basename = path.basename(srcPath);
      const destPath = path.join(targetDir, basename);
      try {
        fs.renameSync(srcPath, destPath);
        moved = true;
      } catch {
        vscode.window.showErrorMessage(`Valt: Could not move "${basename}"`);
      }
    }

    if (moved) {
      this._onFileMoved.fire();
      this.refresh();
    }
  }

  private readDirectory(dir: string): ValtTreeItem[] {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: ValtTreeItem[] = [];
    const files: ValtTreeItem[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        dirs.push(
          new ValtTreeItem(
            entry.name,
            fullPath,
            true,
            vscode.TreeItemCollapsibleState.Collapsed
          )
        );
      } else if (entry.name.endsWith(".md")) {
        const label = this.labelFor(fullPath, entry.name);
        files.push(
          new ValtTreeItem(
            label,
            fullPath,
            false,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }

    return [...dirs, ...this.sortFiles(files)];
  }

  /**
   * Compute the display label for a file tree item.
   * If the file is in the page index, use its display name (+ emoji prefix).
   * Otherwise fall back to the filename stem stripped of any leading `[id] `.
   */
  private labelFor(fsPath: string, basename: string): string {
    const entry: PageEntry | undefined = this.pageIndex?.getByPath(fsPath);
    if (entry) {
      return entry.emoji ? `${entry.emoji} ${entry.displayName}` : entry.displayName;
    }
    // Fallback: strip `[id] ` prefix and `.md` extension
    return basename.replace(/\.md$/, "").replace(/^\d+\s+/, "");
  }

  private sortFiles(files: ValtTreeItem[]): ValtTreeItem[] {
    return files.sort((a, b) => {
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
