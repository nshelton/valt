import * as vscode from "vscode";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** tagName → full file paths */
export type TagIndex = Map<string, string[]>;

// ── Color helpers ─────────────────────────────────────────────────────────────

const DEFAULT_PALETTE = [
  "#6fa3d8", "#6abf69", "#d4a843", "#a07dd8",
  "#d46a6a", "#d46a9f", "#6abfb8", "#c3a06f",
];

function svgDot(color: string): { light: vscode.Uri; dark: vscode.Uri } {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="4.5" fill="${color}" opacity="0.9"/>` +
    `</svg>`;
  const uri = vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  return { light: uri, dark: uri };
}

// ── Tree items ────────────────────────────────────────────────────────────────

export class TagTreeItem extends vscode.TreeItem {
  constructor(
    readonly kind: "tag" | "file",
    label: string,
    readonly tagName?: string,
    readonly fullPath?: string,
    color?: string,
    fileCount?: number,
  ) {
    super(
      label,
      kind === "tag"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = kind;

    if (kind === "tag") {
      this.iconPath = svgDot(color ?? "#888888");
      this.description = String(fileCount ?? 0);
      this.tooltip = `${fileCount} file(s) tagged @tag(${tagName})`;
    } else {
      this.iconPath = new vscode.ThemeIcon("file");
      if (fullPath) {
        this.command = { command: "valt.openFile", title: "Open File", arguments: [fullPath] };
        this.tooltip = fullPath;
      }
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ValtTagTreeProvider implements vscode.TreeDataProvider<TagTreeItem> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  private index: TagIndex = new Map();
  // Auto-assigned palette colors (persisted for the session)
  private readonly assigned = new Map<string, string>();

  setIndex(index: TagIndex): void {
    this.index = index;
    this._onChange.fire();
  }

  refresh(): void {
    this._onChange.fire();
  }

  colorFor(tagName: string): string {
    const cfg = vscode.workspace.getConfiguration("valt")
      .get<Record<string, string>>("tagColors") ?? {};
    if (cfg[tagName]) return cfg[tagName];

    if (!this.assigned.has(tagName)) {
      this.assigned.set(tagName, DEFAULT_PALETTE[this.assigned.size % DEFAULT_PALETTE.length]);
    }
    return this.assigned.get(tagName)!;
  }

  async promptSetColor(tagName: string): Promise<void> {
    const current = this.colorFor(tagName);
    const value = await vscode.window.showInputBox({
      title: `Color for @tag(${tagName})`,
      prompt: "Enter a hex color, e.g. #a07dd8",
      value: current,
      validateInput: (v) =>
        /^#[0-9a-fA-F]{3,8}$/.test(v) ? null : "Must be a valid hex color like #6fa3d8",
    });
    if (!value) return;

    const cfg = vscode.workspace.getConfiguration("valt");
    const colors = cfg.get<Record<string, string>>("tagColors") ?? {};
    await cfg.update("tagColors", { ...colors, [tagName]: value }, vscode.ConfigurationTarget.Workspace);
    this._onChange.fire();
  }

  getTreeItem(element: TagTreeItem): vscode.TreeItem { return element; }

  getChildren(element?: TagTreeItem): TagTreeItem[] {
    if (!element) {
      return [...this.index.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tagName, files]) =>
          new TagTreeItem("tag", tagName, tagName, undefined, this.colorFor(tagName), files.length)
        );
    }

    if (element.kind === "tag" && element.tagName) {
      return (this.index.get(element.tagName) ?? [])
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
        .map((fp) => new TagTreeItem("file", path.basename(fp), undefined, fp));
    }

    return [];
  }
}
