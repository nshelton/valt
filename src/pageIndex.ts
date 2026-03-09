/**
 * Page index — tracks all .md files in the workspace, derives display names
 * from H1 headings, manages the `[id] [Name].md` filename convention, and
 * maintains a reverse-link graph so renames can propagate to all linking files.
 *
 * File naming: `1 Getting Started.md`, `2 My Plans.md`, etc.
 * Link syntax: `@[Display Name]` (no .md, no numeric prefix)
 */
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PageEntry {
  id: number | null;     // numeric prefix from filename, or null for un-indexed files
  filename: string;      // basename: "1 Getting Started.md"
  fsPath: string;        // absolute path
  displayName: string;   // from H1 (stripped of leading emoji) or first 20 chars
  emoji: string | null;  // leading emoji of H1, if present
}

export interface PageInfo {
  filename: string;
  displayName: string;
  emoji: string | null;
}

// ── Content parsing ───────────────────────────────────────────────────────────

/**
 * Match one or more emoji code points at the start of a string.
 * Handles simple emoji and basic ZWJ sequences (e.g. 👨‍💻).
 */
function extractLeadingEmoji(text: string): string | null {
  const m = text.match(
    /^(\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?)*)/u
  );
  return m ? m[1] : null;
}

/**
 * Extract the display name from file content.
 * Prefers the first H1 heading (stripped of a leading emoji).
 * Falls back to the first 20 non-whitespace characters of the file.
 */
export function extractTitle(content: string): string {
  const h1 = content.match(/^#[ \t]+(.+)$/m);
  if (h1) {
    let title = h1[1].trim();
    // Strip leading emoji — it's stored separately
    const emoji = extractLeadingEmoji(title);
    if (emoji) title = title.slice(emoji.length).trim();
    if (title) return title;
  }
  // Fallback: first non-blank line, up to 20 chars
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 20) || "Untitled";
  }
  return "Untitled";
}

/**
 * Extract the leading emoji from the first H1 heading, if any.
 */
export function extractEmoji(content: string): string | null {
  const h1 = content.match(/^#[ \t]+(.+)$/m);
  if (!h1) return null;
  return extractLeadingEmoji(h1[1].trim());
}

/**
 * Make a title safe to use as the name portion of a filename.
 * Removes characters forbidden on Windows/macOS, trims length.
 */
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
 * Parse `[id] [name].md` into {id, name}.
 * Files without the numeric prefix return {id: null, name: stem}.
 */
export function parseFilename(basename: string): { id: number | null; name: string } {
  const m = basename.match(/^(\d+)\s+(.+)\.md$/);
  if (m) return { id: parseInt(m[1], 10), name: m[2] };
  return { id: null, name: basename.replace(/\.md$/, "") };
}

/**
 * Build the canonical filename for a page: `[id] [sanitized name].md`
 */
export function buildFilename(id: number, displayName: string): string {
  return `${id} ${sanitizeForFilename(displayName)}.md`;
}

// ── Link extraction ───────────────────────────────────────────────────────────

/**
 * Extract all `@[name]` link targets from file content.
 * Returns the raw bracket contents (no .md expected).
 */
export function extractPageLinks(content: string): string[] {
  const links: string[] = [];
  const re = /@\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    links.push(m[1]);
  }
  return links;
}

/**
 * Replace all occurrences of `@[oldName]` with `@[newName]` in content.
 */
export function rewriteLinks(content: string, oldName: string, newName: string): string {
  // Escape special regex chars in the name
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`@\\[${escaped}\\]`, "g"), `@[${newName}]`);
}

// ── Page index ────────────────────────────────────────────────────────────────

export class PageIndex {
  // fsPath → entry
  private entries: Map<string, PageEntry> = new Map();
  // displayName.toLowerCase() → entry  (last-write wins on collision)
  private byName: Map<string, PageEntry> = new Map();
  // targetFsPath → Set of source fsPaths that contain an @[link] to it
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

  /** Lowest unused integer ≥ 1. */
  nextId(): number {
    let max = 0;
    for (const e of this.entries.values()) {
      if (e.id !== null && e.id > max) max = e.id;
    }
    return max + 1;
  }

  /** All files (fsPaths) that contain an @[link] pointing to `fsPath`. */
  getLinkers(fsPath: string): string[] {
    return [...(this.linkGraph.get(fsPath) ?? [])];
  }

  toPageInfos(): PageInfo[] {
    return this.getAll()
      .sort((a, b) => {
        if (a.id !== null && b.id !== null) return a.id - b.id;
        if (a.id !== null) return -1;
        if (b.id !== null) return 1;
        return a.displayName.localeCompare(b.displayName);
      })
      .map(({ filename, displayName, emoji }) => ({ filename, displayName, emoji }));
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  build(files: { fsPath: string; content: string }[]): void {
    this.entries.clear();
    this.byName.clear();
    this.linkGraph.clear();

    // Pass 1: build entries
    for (const { fsPath, content } of files) {
      this.addEntry(fsPath, content);
    }
    // Pass 2: build link graph
    for (const { fsPath, content } of files) {
      this.indexLinks(fsPath, content);
    }
  }

  // ── Incremental updates ───────────────────────────────────────────────────

  /**
   * Called after a file is saved (before any rename).
   * Returns rename info if the canonical filename changed, otherwise null.
   *
   * Caller is responsible for:
   *  - Renaming the file on disk when `needsRename === true`
   *  - Calling `commitRename()` after the disk rename
   *  - Rewriting links in all `getLinkers()` files
   */
  computeRename(
    fsPath: string,
    content: string
  ): { needsRename: true; newPath: string; newFilename: string; oldDisplayName: string } |
     { needsRename: false } {
    const existing = this.entries.get(fsPath);
    const dir = path.dirname(fsPath);
    const newDisplayName = extractTitle(content);

    // Assign or keep ID
    const id = existing?.id ?? this.nextId();
    const newFilename = buildFilename(id, newDisplayName);
    const newPath = path.join(dir, newFilename);

    const currentFilename = path.basename(fsPath);
    if (newFilename === currentFilename) {
      // No rename — still update display name / emoji in place
      this.updateEntry(fsPath, content);
      return { needsRename: false };
    }

    return {
      needsRename: true,
      newPath,
      newFilename,
      oldDisplayName: existing?.displayName ?? extractTitle(content),
    };
  }

  /**
   * Call this after the OS file rename succeeds.
   * Updates all internal maps from oldPath → newPath.
   */
  commitRename(oldPath: string, newPath: string, newContent: string): void {
    const old = this.entries.get(oldPath);
    if (old) {
      this.byName.delete(old.displayName.toLowerCase());
      this.entries.delete(oldPath);
    }

    // Transfer link-graph target
    const linkers = this.linkGraph.get(oldPath);
    if (linkers) {
      this.linkGraph.delete(oldPath);
      this.linkGraph.set(newPath, linkers);
    }

    // Replace oldPath as a source in other sets
    for (const [, linkerSet] of this.linkGraph) {
      if (linkerSet.has(oldPath)) {
        linkerSet.delete(oldPath);
        linkerSet.add(newPath);
      }
    }

    this.addEntry(newPath, newContent);
    this.indexLinks(newPath, newContent);
  }

  /** Update a single entry's content-derived fields (no rename). */
  updateEntry(fsPath: string, content: string): void {
    const existing = this.entries.get(fsPath);
    if (existing) this.byName.delete(existing.displayName.toLowerCase());
    this.addEntry(fsPath, content);
    this.indexLinks(fsPath, content);
  }

  removeEntry(fsPath: string): void {
    const entry = this.entries.get(fsPath);
    if (entry) {
      this.byName.delete(entry.displayName.toLowerCase());
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
  }

  private indexLinks(sourcePath: string, content: string): void {
    // Remove previous outbound edges from this source
    for (const [, linkers] of this.linkGraph) linkers.delete(sourcePath);

    // Add new edges
    for (const linkName of extractPageLinks(content)) {
      const target = this.byName.get(linkName.toLowerCase());
      if (!target) continue;
      if (!this.linkGraph.has(target.fsPath)) {
        this.linkGraph.set(target.fsPath, new Set());
      }
      this.linkGraph.get(target.fsPath)!.add(sourcePath);
    }
  }
}
