/**
 * Page index — tracks all .md files in the workspace, derives display names
 * from H1 headings, manages the `[uuid] [Name].md` filename convention, and
 * maintains a reverse-link graph so backlinks can be computed.
 *
 * File naming: `a3f2bc1d Getting Started.md` (8-char hex + space + title)
 * Link syntax: `@[a3f2bc1d]` (UUID only — never goes stale on rename)
 */
import * as crypto from "crypto";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PageEntry {
  id: string | null;     // 8-char hex UUID from filename, or null for un-indexed files
  filename: string;      // basename: "a3f2bc1d Getting Started.md"
  fsPath: string;        // absolute path
  displayName: string;   // from H1 (stripped of leading emoji) or first 20 chars
  emoji: string | null;  // leading emoji of H1, if present
}

export interface PageInfo {
  id: string | null;
  filename: string;
  displayName: string;
  emoji: string | null;
}

// ── ID generation ─────────────────────────────────────────────────────────────

/** Generate a new random 8-char hex page ID. */
export function generateId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ── Content parsing ───────────────────────────────────────────────────────────

function extractLeadingEmoji(text: string): string | null {
  const m = text.match(
    /^(\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?)*)/u
  );
  return m ? m[1] : null;
}

export function extractTitle(content: string): string {
  const h1 = content.match(/^#[ \t]+(.+)$/m);
  if (h1) {
    let title = h1[1].trim();
    const emoji = extractLeadingEmoji(title);
    if (emoji) title = title.slice(emoji.length).trim();
    if (title) return title;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 20) || "Untitled";
  }
  return "Untitled";
}

export function extractEmoji(content: string): string | null {
  const h1 = content.match(/^#[ \t]+(.+)$/m);
  if (!h1) return null;
  return extractLeadingEmoji(h1[1].trim());
}

export function sanitizeForFilename(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "Untitled"
  );
}

/**
 * Parse `[8hex] [name].md` into {id, name}.
 * Files without a UUID prefix return {id: null, name: stem}.
 */
export function parseFilename(basename: string): { id: string | null; name: string } {
  const m = basename.match(/^([0-9a-f]{8})\s+(.+)\.md$/);
  if (m) return { id: m[1], name: m[2] };
  return { id: null, name: basename.replace(/\.md$/, "") };
}

/** Build the canonical filename for a page: `[uuid] [sanitized name].md` */
export function buildFilename(id: string, displayName: string): string {
  return `${id} ${sanitizeForFilename(displayName)}.md`;
}

// ── Link extraction ───────────────────────────────────────────────────────────

/**
 * Extract all UUID page link targets from file content.
 * Matches `@[8hexchars]` — these links are stable and never go stale.
 */
export function extractPageLinks(content: string): string[] {
  const links: string[] = [];
  const re = /@\[([0-9a-f]{8})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    links.push(m[1]);
  }
  return links;
}

// ── Page index ────────────────────────────────────────────────────────────────

export class PageIndex {
  // fsPath → entry
  private entries: Map<string, PageEntry> = new Map();
  // displayName.toLowerCase() → entry (last-write wins on collision)
  private byName: Map<string, PageEntry> = new Map();
  // UUID → entry
  private byId: Map<string, PageEntry> = new Map();
  // targetFsPath → Set of source fsPaths that contain an @[uuid] link to it
  private linkGraph: Map<string, Set<string>> = new Map();

  // ── Queries ──────────────────────────────────────────────────────────────

  getAll(): PageEntry[] {
    return [...this.entries.values()];
  }

  getByPath(fsPath: string): PageEntry | undefined {
    return this.entries.get(fsPath);
  }

  getByDisplayName(name: string): PageEntry | undefined {
    return this.byName.get(name.toLowerCase());
  }

  getById(uuid: string): PageEntry | undefined {
    return this.byId.get(uuid);
  }

  /** All files (fsPaths) that contain an @[uuid] link pointing to `fsPath`. */
  getLinkers(fsPath: string): string[] {
    return [...(this.linkGraph.get(fsPath) ?? [])];
  }

  toPageInfos(): PageInfo[] {
    return this.getAll()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(({ id, filename, displayName, emoji }) => ({ id, filename, displayName, emoji }));
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  build(files: { fsPath: string; content: string }[]): void {
    this.entries.clear();
    this.byName.clear();
    this.byId.clear();
    this.linkGraph.clear();

    for (const { fsPath, content } of files) {
      this.addEntry(fsPath, content);
    }
    for (const { fsPath, content } of files) {
      this.indexLinks(fsPath, content);
    }
  }

  // ── Incremental updates ───────────────────────────────────────────────────

  /**
   * Called after a file is saved (before any rename).
   * Returns rename info if the canonical filename changed, otherwise null.
   *
   * The UUID prefix is preserved across renames — only the title portion changes.
   * Caller is responsible for renaming the file and sibling folder on disk.
   */
  computeRename(
    fsPath: string,
    content: string
  ): { needsRename: true; newPath: string; newFilename: string } |
     { needsRename: false } {
    const existing = this.entries.get(fsPath);
    const dir = path.dirname(fsPath);
    const newDisplayName = extractTitle(content);

    // Preserve existing UUID; assign a new one if file has no UUID prefix yet
    const id = existing?.id ?? generateId();
    const newFilename = buildFilename(id, newDisplayName);
    const newPath = path.join(dir, newFilename);

    const currentFilename = path.basename(fsPath);
    if (newFilename === currentFilename) {
      this.updateEntry(fsPath, content);
      return { needsRename: false };
    }

    return { needsRename: true, newPath, newFilename };
  }

  commitRename(oldPath: string, newPath: string, newContent: string): void {
    const old = this.entries.get(oldPath);
    if (old) {
      this.byName.delete(old.displayName.toLowerCase());
      if (old.id) this.byId.delete(old.id);
      this.entries.delete(oldPath);
    }

    const linkers = this.linkGraph.get(oldPath);
    if (linkers) {
      this.linkGraph.delete(oldPath);
      this.linkGraph.set(newPath, linkers);
    }

    for (const [, linkerSet] of this.linkGraph) {
      if (linkerSet.has(oldPath)) {
        linkerSet.delete(oldPath);
        linkerSet.add(newPath);
      }
    }

    this.addEntry(newPath, newContent);
    this.indexLinks(newPath, newContent);
  }

  updateEntry(fsPath: string, content: string): void {
    const existing = this.entries.get(fsPath);
    if (existing) {
      this.byName.delete(existing.displayName.toLowerCase());
      if (existing.id) this.byId.delete(existing.id);
    }
    this.addEntry(fsPath, content);
    this.indexLinks(fsPath, content);
  }

  removeEntry(fsPath: string): void {
    const entry = this.entries.get(fsPath);
    if (entry) {
      this.byName.delete(entry.displayName.toLowerCase());
      if (entry.id) this.byId.delete(entry.id);
      this.entries.delete(fsPath);
    }
    this.linkGraph.delete(fsPath);
    for (const [, linkers] of this.linkGraph) linkers.delete(fsPath);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private addEntry(fsPath: string, content: string): void {
    const basename = path.basename(fsPath);
    const { id } = parseFilename(basename);
    const displayName = extractTitle(content);
    const emoji = extractEmoji(content);
    const entry: PageEntry = { id, filename: basename, fsPath, displayName, emoji };
    this.entries.set(fsPath, entry);
    this.byName.set(displayName.toLowerCase(), entry);
    if (id) this.byId.set(id, entry);
  }

  private indexLinks(sourcePath: string, content: string): void {
    for (const [, linkers] of this.linkGraph) linkers.delete(sourcePath);

    for (const uuid of extractPageLinks(content)) {
      const target = this.byId.get(uuid);
      if (!target) continue;
      if (!this.linkGraph.has(target.fsPath)) {
        this.linkGraph.set(target.fsPath, new Set());
      }
      this.linkGraph.get(target.fsPath)!.add(sourcePath);
    }
  }
}
