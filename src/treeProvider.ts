import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

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
      this.iconPath = new vscode.ThemeIcon("markdown");
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ValtTreeProvider
  implements vscode.TreeDataProvider<ValtTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ValtTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly rootPath: string) {}

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

  private readDirectory(dir: string): ValtTreeItem[] {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: ValtTreeItem[] = [];
    const files: ValtTreeItem[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

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

  private directoryContainsMarkdown(dir: string): boolean {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.some(
        (e) =>
          (e.isFile() && e.name.endsWith(".md")) ||
          (e.isDirectory() && this.directoryContainsMarkdown(path.join(dir, e.name)))
      );
    } catch {
      return false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sort file tree items: `_index.md` first, then alphabetically by label.
 */
function sortFiles(files: ValtTreeItem[]): ValtTreeItem[] {
  return files.sort((a, b) => {
    const aIsIndex = a.label === "_index.md";
    const bIsIndex = b.label === "_index.md";
    if (aIsIndex && !bIsIndex) return -1;
    if (!aIsIndex && bIsIndex) return 1;
    return (a.label as string).localeCompare(b.label as string);
  });
}
