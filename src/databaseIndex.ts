/**
 * DatabaseIndex — scans workspace for .valtdb.json files, parses schemas and
 * row frontmatter, and provides query/update methods for database operations.
 */
import * as fs from "fs";
import * as path from "path";
import type { DatabaseSchema, DatabaseRow } from "./shared/messages";
import { parseFilename, extractTitle, extractEmoji } from "./pageIndex";

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Parse a YAML frontmatter block from markdown content.
 * Handles `---\nkey: value\n---` blocks at the top of a file.
 * Returns the parsed properties and the body content after the frontmatter.
 */
export function parseFrontmatter(content: string): {
  properties: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { properties: {}, body: content };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { properties: {}, body: content };
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n");
  const properties: Record<string, unknown> = {};

  for (const line of fmLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    properties[key] = parseYamlScalar(rawVal);
  }

  return { properties, body };
}

function parseYamlScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~" || raw === "") return null;
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // YAML array (simple single-line)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseYamlScalar(s.trim()));
  }
  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;
  return raw;
}

/**
 * Serialize a properties object back into YAML frontmatter lines.
 * Produces `key: value` lines suitable for a `---` block.
 */
function serializeYamlScalar(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    const items = val.map((v) => serializeYamlScalar(v)).join(", ");
    return `[${items}]`;
  }
  const str = String(val);
  // Quote if it contains special chars or looks like a keyword
  if (/[:#\[\]{}|>&*!,'"]/g.test(str) || str === "true" || str === "false" || str === "null") {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * Replace the frontmatter block of a markdown file with updated properties.
 * If the file has no frontmatter, prepend a new block.
 */
export function replaceFrontmatter(
  content: string,
  properties: Record<string, unknown>
): string {
  const yamlLines = Object.entries(properties)
    .map(([k, v]) => `${k}: ${serializeYamlScalar(v)}`)
    .join("\n");
  const newFrontmatter = `---\n${yamlLines}\n---`;

  const lines = content.split("\n");
  if (lines[0]?.trim() === "---") {
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { endIdx = i; break; }
    }
    if (endIdx !== -1) {
      const body = lines.slice(endIdx + 1).join("\n");
      return `${newFrontmatter}\n${body}`;
    }
  }

  return `${newFrontmatter}\n${content}`;
}

// ── DatabaseIndex ─────────────────────────────────────────────────────────────

interface DatabaseEntry {
  folderPath: string;
  schema: DatabaseSchema;
  rows: DatabaseRow[];
}

export class DatabaseIndex {
  private dbs: Map<string, DatabaseEntry> = new Map();

  /** Scan the given workspace root for all .valtdb.json files and index them. */
  build(workspaceRoot: string): void {
    this.dbs.clear();
    this.scanDir(workspaceRoot);
  }

  private scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const schemaPath = path.join(dir, ".valtdb.json");
    if (fs.existsSync(schemaPath)) {
      this.indexDatabase(dir, schemaPath);
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        this.scanDir(path.join(dir, entry.name));
      }
    }
  }

  private indexDatabase(folderPath: string, schemaPath: string): void {
    try {
      const schemaRaw = fs.readFileSync(schemaPath, "utf8");
      const schema = JSON.parse(schemaRaw) as DatabaseSchema;
      const rows = this.readRows(folderPath);
      this.dbs.set(folderPath, { folderPath, schema, rows });
    } catch {
      // Malformed schema — skip
    }
  }

  private readRows(folderPath: string): DatabaseRow[] {
    const rows: DatabaseRow[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      return rows;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fsPath = path.join(folderPath, entry.name);
      try {
        const content = fs.readFileSync(fsPath, "utf8");
        const { properties, body } = parseFrontmatter(content);
        const { id } = parseFilename(entry.name);
        const title = extractTitle(body || content);
        const emoji = extractEmoji(body || content);
        rows.push({ fsPath, pageId: id, title, emoji, properties });
      } catch {
        // Skip unreadable files
      }
    }

    return rows;
  }

  /** Returns the schema+rows for a database folder, or undefined if not found. */
  getByFolder(folderPath: string): { schema: DatabaseSchema; rows: DatabaseRow[] } | undefined {
    return this.dbs.get(folderPath);
  }

  /** Returns true if the given folder is a known database. */
  isDatabase(folderPath: string): boolean {
    return this.dbs.has(folderPath) || fs.existsSync(path.join(folderPath, ".valtdb.json"));
  }

  /** Re-index a single database (after schema or row changes). */
  refreshDatabase(folderPath: string): { schema: DatabaseSchema; rows: DatabaseRow[] } | undefined {
    const schemaPath = path.join(folderPath, ".valtdb.json");
    if (!fs.existsSync(schemaPath)) {
      this.dbs.delete(folderPath);
      return undefined;
    }
    this.indexDatabase(folderPath, schemaPath);
    return this.dbs.get(folderPath);
  }

  /** Load and return schema+rows for a folder without storing in index. */
  loadDatabase(folderPath: string): { schema: DatabaseSchema; rows: DatabaseRow[] } | undefined {
    return this.refreshDatabase(folderPath);
  }
}
