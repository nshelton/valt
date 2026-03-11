# Notion Importer Plan

## Approach

Import a **Notion ZIP export** (Markdown + CSV format). This is the right approach over the API because:
- No auth/token setup for user
- Works offline, one-time migration
- Databases are cleanly exported as CSV + row `.md` files
- All content is local and final — no ongoing sync complexity

**What is lost:** Created/modified timestamps (Notion doesn't include them in ZIP exports). Colors, embeds, synced blocks, comments. Callouts become blockquotes.

---

## Notion Export Format Reference

### File naming
```
Page Title abcdef1234567890abcdef1234567890.md
```
- UUID is **32 lowercase hex chars** (no dashes), appended after a space before `.md`
- Regex to extract: `/^(.+)\s([0-9a-f]{32})\.md$/`

### Folder structure
```
Export/
  Top Level Page abcdef...32chars.md
  Top Level Page abcdef...32chars/      ← sibling folder for subpages
    Child Page 1234...32chars.md
    Child Page 1234...32chars/
      Grandchild abcd...32chars.md
  My Database abcdef...32chars/
    My Database abcdef...32chars.csv    ← database schema + all rows
    Row Page Title 1234...32chars.md   ← row page bodies (if rows have content)
  media/
    image-abc123.png                   ← all uploaded images/files
```

### Internal links
Links between pages use **relative URL-encoded file paths**:
```markdown
[Page Title](Page%20Title%20abcdef1234567890abcdef1234567890.md)
[Child Page](Subfolder%2FChild%20Page%201234567890abcdef1234567890abcdef.md)
[Parent](../Parent%20Page%20abcdef1234567890abcdef1234567890.md)
```
- Spaces encoded as `%20`
- Slashes encoded as `%2F` for nested paths (or sometimes actual `/`)
- The link text is the page display name (not reliable — use UUID for mapping)
- Some links may be absolute `notion.so` URLs — treat as external, leave as-is

### Images
```markdown
![alt text](media/image-abc123.png)
![](../media/image-def456.jpg)
```
Paths are relative to the `.md` file's location. The `media/` folder may be at the same level or a parent level.

### Callout blocks
Exported as raw HTML — must be converted:
```html
<aside>
💡 This is a callout

With body text
</aside>
```
→ becomes: `> 💡 This is a callout\n> \n> With body text`

### Database CSV format
```csv
Name,Status,Due Date,Priority,Tags,Related Pages
Task One,"In Progress","March 15, 2026","High","work, project","Other Page"
Task Two,Done,"March 10, 2026","Low","work",""
```
- First column is always the page title (Name)
- Column headers are human-readable (not IDs)
- Multi-select values are comma-separated within the field
- Relation fields contain the display name of the linked page (not UUID)
- Dates are human-readable strings (not ISO), e.g. "March 15, 2026"
- Boolean/checkbox: `"Yes"` / `""` or `"true"` / `"false"`

---

## New File: `src/notionImporter.ts`

Single module, runs entirely in extension/Node context. No webview involvement.

### Entry point

```typescript
export async function importNotionZip(
  zipPath: string,
  workspaceRoot: string,
  pageIndex: PageIndex
): Promise<{ imported: number; skipped: number; errors: string[] }>
```

Called from a new VSCode command `valt.importNotionExport`.

### Step 1: Extract ZIP

Use `adm-zip` (add as dependency: `npm install adm-zip @types/adm-zip`).

```typescript
import AdmZip from "adm-zip";

const zip = new AdmZip(zipPath);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "valt-notion-"));
zip.extractAllTo(tmpDir, true);
```

The extracted folder will have one root directory (Notion's workspace name).

### Step 2: Walk all files and build UUID map

Walk the extracted tree, find all `.md` and `.csv` files. For every `.md` file:

```typescript
const NOTION_UUID_RE = /^(.+)\s([0-9a-f]{32})\.md$/;

function parseNotionFilename(basename: string): { title: string; notionId: string } | null {
  const m = basename.match(NOTION_UUID_RE);
  if (!m) return null;
  return { title: m[1].trim(), notionId: m[2] };
}
```

Build two maps:
```typescript
// notionId (32-char) → valtId (8-char)
const idMap = new Map<string, string>();
// notionId → absolute fsPath in extracted dir
const pathMap = new Map<string, string>();
// notionId → output fsPath in workspace
const outPathMap = new Map<string, string>();
```

For each `.md` file found, generate a stable Valt ID by taking the **first 8 chars** of the Notion UUID:
```typescript
const valtId = notionId.slice(0, 8);
idMap.set(notionId, valtId);
```

**Collision handling:** After building the full map, check for duplicate Valt IDs. If two Notion IDs produce the same 8-char prefix, append a counter or use `generateId()` for the second one and log a warning. Collisions are rare (birthday paradox: ~0.02% chance with 1000 pages).

### Step 3: Determine output paths

For each page, compute where it lands in the workspace. Two strategies — prefer **flat** (all pages at root):

```typescript
// Flat: everything goes in workspaceRoot regardless of Notion folder nesting
const safeTitle = sanitizeForFilename(title);  // reuse from pageIndex.ts
const outPath = path.join(workspaceRoot, `${valtId} ${safeTitle}.md`);
outPathMap.set(notionId, outPath);
```

Alternatively, **preserve hierarchy** by mirroring Notion's folder structure. Flat is simpler and matches Valt's flat-file philosophy. Start with flat.

### Step 4: Process each `.md` file

For each page file:

```typescript
function processMarkdownFile(
  srcPath: string,
  notionId: string,
  idMap: Map<string, string>,
  mediaSrcDir: string,    // extracted media/ folder
  mediaDestDir: string,   // workspace media/ folder
): string  // returns processed content
```

**4a. Read raw content**
```typescript
let content = fs.readFileSync(srcPath, "utf8");
```

**4b. Convert callout HTML blocks**
```typescript
content = content.replace(
  /<aside>\n([\s\S]*?)\n<\/aside>/g,
  (_, inner) => inner.split("\n").map(l => `> ${l}`).join("\n")
);
```

**4c. Rewrite internal links** ← the tricky part

Find all markdown links `[text](url)` where the URL looks like a relative path to a Notion `.md` file:

```typescript
const INTERNAL_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

content = content.replace(INTERNAL_LINK_RE, (match, text, rawUrl) => {
  // Skip absolute URLs (http/https/notion://)
  if (/^https?:\/\/|^notion:\/\//.test(rawUrl)) return match;

  // URL-decode the path
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    return match; // malformed URL, leave as-is
  }

  // Extract just the filename (last path segment, ignoring ../ traversal)
  const basename = path.basename(decoded);

  // Try to parse as a Notion page filename
  const parsed = parseNotionFilename(basename);
  if (!parsed) return match; // not a page link — could be an image, leave as-is

  // Look up the Valt ID
  const valtId = idMap.get(parsed.notionId);
  if (!valtId) return match; // orphaned link — leave as plain text or log warning

  // Rewrite to Valt link syntax
  return `@[${valtId}]`;
});
```

**Edge cases for link rewriting:**
- Link URL contains `#section-anchor` — strip the fragment before parsing, discard it (Valt has no anchor links)
- Link URL is just a UUID with no title: `(abcdef...32chars)` — still matches
- Link text is empty `[](url)` — convert to `@[uuid]` with no display override
- Notion sometimes generates `notion://` protocol links for internal references — skip (treat as broken)
- Absolute `notion.so` URLs like `https://www.notion.so/Page-Title-abcdef...` — extract UUID from end of URL path segment, same mapping logic

**4d. Rewrite image paths**

```typescript
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

content = content.replace(IMAGE_RE, (match, alt, rawUrl) => {
  if (/^https?:\/\//.test(rawUrl)) return match; // external image, leave as-is

  let decoded: string;
  try { decoded = decodeURIComponent(rawUrl); } catch { return match; }

  // Resolve relative to the source .md file's directory
  const srcMediaPath = path.resolve(path.dirname(srcPath), decoded);
  if (!fs.existsSync(srcMediaPath)) return match; // missing, leave as-is

  // Copy to workspace media folder
  const filename = path.basename(srcMediaPath);
  const destPath = path.join(mediaDestDir, filename);
  fs.copyFileSync(srcMediaPath, destPath);

  // Rewrite to workspace-relative path
  return `![${alt}](media/${filename})`;
});
```

**4e. Strip Notion UUID from H1 if present**

Notion sometimes puts the UUID in the H1. Usually it's clean, but check:
```typescript
content = content.replace(/^(#\s+.+?)\s+[0-9a-f]{32}$/m, "$1");
```

**4f. Add frontmatter** (per Universal Frontmatter plan)
```typescript
const frontmatter = `---\ncreated: "${new Date().toISOString()}"\n---\n\n`;
content = frontmatter + content;
```
Note: Notion doesn't export timestamps, so `created` will be the import date. This is the main data loss.

### Step 5: Write processed files

```typescript
fs.writeFileSync(outPath, processedContent, "utf8");
```

After all files are written, call:
```typescript
await rebuildIndexes();  // or pageIndex.build(allNewPaths)
```

### Step 6: Process database CSV files

For each `.csv` file found in the walk:

**6a. Parse CSV**

Hand-rolled parser (no dependency needed — Notion's CSV is well-formed):
```typescript
function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  // Handle quoted fields (values with commas inside quotes)
  // Notion multi-select: "val1, val2" (comma+space inside quotes)
}
```

**6b. Infer column types**

```typescript
function inferColumnType(values: string[]): ColumnType {
  const nonEmpty = values.filter(v => v.trim() !== "");
  if (nonEmpty.every(v => /^(true|false|yes|no)$/i.test(v))) return "checkbox";
  if (nonEmpty.every(v => /^\d{4}-\d{2}-\d{2}/.test(v) || isDateLike(v))) return "date";
  if (nonEmpty.every(v => !isNaN(Number(v)))) return "number";
  if (nonEmpty.every(v => /^https?:\/\//.test(v))) return "url";
  const distinct = new Set(nonEmpty);
  if (distinct.size <= 12 && nonEmpty.length > distinct.size) return "select";
  // Check for multi-select: values containing ", " that map to known set
  const allParts = nonEmpty.flatMap(v => v.split(", "));
  const distinctParts = new Set(allParts);
  if (distinctParts.size <= 15 && nonEmpty.some(v => v.includes(", "))) return "multi-select";
  return "text";
}

function isDateLike(v: string): boolean {
  // Matches "March 15, 2026", "Mar 15 2026", "2026/03/15" etc.
  return !isNaN(Date.parse(v));
}
```

**6c. Normalize date values to ISO**

```typescript
function normalizeValue(value: string, type: ColumnType): unknown {
  if (type === "date" && value) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toISOString().split("T")[0]; // YYYY-MM-DD
  }
  if (type === "checkbox") return /^(true|yes)$/i.test(value);
  if (type === "number") return value === "" ? null : Number(value);
  if (type === "multi-select") return value ? value.split(", ") : [];
  return value || null;
}
```

**6d. Handle relation columns**

Notion exports relation fields as display names of linked pages. Attempt to resolve to Valt UUID:
```typescript
if (type === "relation" || columnName.toLowerCase().includes("related")) {
  const linked = pageIndex.getByDisplayName(cellValue);
  return linked ? `@[${linked.id}]` : cellValue; // fallback to plain text
}
```

**6e. Write `.valtdb.json` schema**

```typescript
const schema: DatabaseSchema = {
  schemaVersion: 1,
  columns: headers.slice(1).map((name, i) => ({
    id: `col_${String(i + 1).padStart(2, "0")}`,
    name,
    type: inferColumnType(rows.map(r => r[i + 1])),
    options: type === "select" || type === "multi-select"
      ? [...new Set(rows.flatMap(r => r[i+1].split(", ").filter(Boolean)))]
      : undefined
  })),
  views: [{ id: "view_01", type: "table", name: "All", sort: [], filters: [] }],
  defaultView: "view_01"
};

// Determine database folder path
// CSV file: workspaceRoot/[valtId] Database Name/
const dbFolderName = `${dbValtId} ${sanitizeForFilename(dbTitle)}`;
const dbFolderPath = path.join(workspaceRoot, dbFolderName);
fs.mkdirSync(dbFolderPath, { recursive: true });
fs.writeFileSync(path.join(dbFolderPath, ".valtdb.json"), JSON.stringify(schema, null, 2));
```

**6f. Write row `.md` files**

For each CSV row:
```typescript
const rowId = idMap.get(csvRowNotionId) ?? generateId();
const rowTitle = row[0]; // first column is always Name/Title
const frontmatterProps = Object.fromEntries(
  headers.slice(1).map((name, i) => [schema.columns[i].id, normalizeValue(row[i+1], schema.columns[i].type)])
);

// Check if a matching row .md file exists in the Notion export (has body content)
const notionRowMd = findMatchingRowMd(rowTitle, dbSrcDir); // match by title
const bodyContent = notionRowMd
  ? processMarkdownFile(notionRowMd, ...)  // reuse step 4 pipeline
  : `# ${rowTitle}\n\n`;

const yamlProps = Object.entries(frontmatterProps)
  .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  .join("\n");
const fullContent = `---\n${yamlProps}\n---\n\n${bodyContent}`;

const rowPath = path.join(dbFolderPath, `${rowId} ${sanitizeForFilename(rowTitle)}.md`);
fs.writeFileSync(rowPath, fullContent, "utf8");
```

---

## New VSCode Command: `valt.importNotionExport`

In `src/extension.ts`, register:

```typescript
vscode.commands.registerCommand("valt.importNotionExport", async () => {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showErrorMessage("No workspace open."); return; }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    filters: { "Notion Export ZIP": ["zip"] },
    title: "Select Notion Export ZIP"
  });
  if (!picked?.[0]) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Importing Notion export..." },
    async (progress) => {
      const result = await importNotionZip(picked[0].fsPath, root, pageIndex);
      progress.report({ message: "Rebuilding index..." });
      await rebuildIndexes();
      treeProvider?.refresh();
      vscode.window.showInformationMessage(
        `Notion import complete: ${result.imported} pages imported, ${result.skipped} skipped.${
          result.errors.length ? ` ${result.errors.length} errors — check Output panel.` : ""
        }`
      );
    }
  );
});
```

Register in `package.json` contributes.commands:
```json
{ "command": "valt.importNotionExport", "title": "Import Notion Export (ZIP)..." }
```

---

## Dependencies

Add to `package.json`:
```json
"adm-zip": "^0.5.10",
"@types/adm-zip": "^0.5.5"
```

`adm-zip` is a pure-JS ZIP handler, no native bindings. Small, synchronous API. The only new dependency.

For CSV parsing, write a ~40-line hand-rolled parser to avoid adding another dependency. Notion's CSV is standard RFC 4180 with quoted fields.

---

## Modified Files

| File | Change |
|------|--------|
| `src/notionImporter.ts` | New — full importer module |
| `src/extension.ts` | Register `valt.importNotionExport` command, import `importNotionZip` |
| `package.json` | Add `adm-zip` dependency, register command |

**Reused from existing codebase:**
- `generateId()` from `src/pageIndex.ts` — for new page IDs
- `sanitizeForFilename()` from `src/pageIndex.ts` — for safe output filenames
- `pageIndex.getByDisplayName()` from `src/pageIndex.ts` — for relation field resolution
- `rebuildIndexes()` from `src/extension.ts` — post-import index refresh

---

## Link Rewriting: The Tricky Cases

Summary of all link patterns that must be handled:

| Input | Action |
|-------|--------|
| `[Title](Page%20Title%20abcdef...32.md)` | Decode → extract UUID → `@[valtId]` |
| `[Title](../Folder/Page%20abcdef...32.md)` | Same — take basename only, ignore directory |
| `[Title](Page%20Title%20abcdef...32.md#anchor)` | Strip `#anchor`, then same as above |
| `[Title](https://notion.so/Page-abcdef...32)` | Extract last path segment UUID → `@[valtId]` |
| `[Title](notion://...)` | Leave as-is (broken link, log warning) |
| `[Title](https://external.com)` | Leave as-is (external link) |
| `![alt](media/image.png)` | Copy file, rewrite path |
| `![alt](../media/image.png)` | Resolve relative to src dir, copy, rewrite |
| `<aside>...</aside>` | Convert to blockquote (not a link, but adjacent concern) |

---

## Verification

1. `npm install && npm run build` — no TS errors
2. Export a small Notion workspace as ZIP (Markdown + CSV format, "Include subpages" on)
3. Run `valt.importNotionExport`, select the ZIP
4. Verify: pages appear in sidebar with correct titles (no UUIDs in display names)
5. Open a page that linked to another — verify link shows as `@[uuid]` chip pointing to the right page
6. Open a database — verify table view shows correct columns and row data
7. Open a row page from the database — verify frontmatter properties are visible
8. Verify images render (not broken paths)
9. Check a page that contained a callout — verify it shows as a blockquote
10. Check the Output panel for any logged warnings about unresolved links