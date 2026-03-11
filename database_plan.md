# Valt Database Feature Plan

## Context
Add a Notion-like database feature to Valt. Users can create a database via `/database` slash command, which scaffolds a folder of row pages. Each row is a full `.md` file with YAML frontmatter for typed properties and a markdown body. A table view is rendered as an HTML panel (outside CodeMirror) when the user opens the database. This also enables importing Notion CSV/markdown exports.

---

## Storage Model

**On disk:**
```
[uuid] My Tasks/
  .valtdb.json          ← schema: columns, views, options
  [uuid] Task One.md    ← row page with YAML frontmatter + markdown body
  [uuid] Task Two.md
```

**`[uuid] Task One.md`:**
```markdown
---
col_01: "In Progress"
col_02: "2026-03-15"
col_03: true
---

# Task One

Body text here...
```

**`.valtdb.json`:**
```json
{
  "schemaVersion": 1,
  "columns": [
    { "id": "col_01", "name": "Status", "type": "select", "options": ["Todo", "In Progress", "Done"] },
    { "id": "col_02", "name": "Due Date", "type": "date" },
    { "id": "col_03", "name": "Done", "type": "checkbox" }
  ],
  "views": [
    { "id": "view_01", "type": "table", "name": "All", "sort": [], "filters": [] }
  ],
  "defaultView": "view_01"
}
```

**How opening works:** Clicking a database folder in the sidebar (or following an `@[uuid]` link to a database) sends `OpenDatabaseMessage` to the webview. The webview hides the CM6 editor and renders the table view panel instead. Clicking a row opens the row as a full page in the CM6 editor with a properties panel above the H1.

---

## New Files

| File | Purpose |
|------|---------|
| `src/databaseIndex.ts` | `DatabaseIndex` class — scans `**/.valtdb.json`, parses schemas + row frontmatter, provides query/update methods |
| `src/webview/databaseView.ts` | Table view renderer — vanilla HTML/CSS, cell editing, column management, sort |
| `src/webview/frontmatterPlugin.ts` | CM6 plugin — hides raw YAML frontmatter block when cursor is outside it, shows rendered properties panel |

---

## Modified Files

### `src/shared/messages.ts`
Add shared types and new message interfaces:

**Shared types:**
```typescript
type ColumnType = "text" | "number" | "select" | "multi-select" | "date" | "checkbox" | "relation" | "url";
interface ColumnDef { id, name, type, options? }
interface ViewConfig { id, type: "table"|"board", name, sort, filters }
interface DatabaseSchema { schemaVersion, columns, views, defaultView }
interface DatabaseRow { fsPath, pageId, title, emoji, properties: Record<string, unknown> }
```

**New Extension → Webview:**
- `OpenDatabaseMessage` — `{ type: "openDatabase", folderPath, schema, rows }`
- `DatabaseSchemaUpdatedMessage` — `{ type: "databaseSchemaUpdated", folderPath, schema }`

**New Webview → Extension:**
- `SaveRowPropertyMessage` — `{ type: "saveRowProperty", rowPath, colId, value }`
- `SaveDatabaseSchemaMessage` — `{ type: "saveDatabaseSchema", folderPath, schema }`
- `CreateDatabaseRowMessage` — `{ type: "createDatabaseRow", folderPath, title, properties }`
- `DeleteDatabaseRowMessage` — `{ type: "deleteDatabaseRow", rowPath }`
- `RequestDatabaseMessage` — `{ type: "requestDatabase", folderPath }`

### `src/extension.ts`
1. Add `DatabaseIndex` instance alongside `pageIndex`
2. Call `dbIndex.build()` inside `rebuildIndexes()`
3. In `sendFileTo()`: detect if clicked item is a database folder → send `OpenDatabaseMessage` instead of `OpenFileMessage`
   Detection: `fs.existsSync(path.join(folderPath, ".valtdb.json"))`
4. Add `.valtdb.json` file watcher (alongside existing `mdWatcher`)
5. Add handlers in the message switch:
   - `"saveRowProperty"` → read file, replace frontmatter block, write back
   - `"saveDatabaseSchema"` → write `.valtdb.json`
   - `"createDatabaseRow"` → `generateId()` + write new `.md` with frontmatter + `# Title`
   - `"deleteDatabaseRow"` → `fs.unlinkSync()`
   - `"requestDatabase"` → load schema + rows, send `OpenDatabaseMessage`

### `src/webview/index.ts`
1. Add `case "openDatabase"` in `handleExtensionMessage` → call `showDatabase()`
2. `showDatabase(msg)` — hides CM6 editor, renders `databaseView.ts` into `editorRoot`
3. `case "databaseSchemaUpdated"` — refresh if same DB is open

### `src/webview/componentMenu.ts`
Add `/database` entry to `COMPONENTS`:
- Creates the database folder + `.valtdb.json` + posts `CreateDatabaseMessage` to extension
- Extension scaffolds folder, sends `RequestDatabaseMessage` response

### `src/treeProvider.ts`
- `getChildren()` already shows subfolders — no structural change needed
- Add `contextValue: "valtDatabase"` for folders containing `.valtdb.json` (for future context menu)

---

## `DatabaseIndex` class (`src/databaseIndex.ts`)

```typescript
class DatabaseIndex {
  build(dbFolders: {folderPath: string}[]): void
  getByFolder(folderPath: string): { schema: DatabaseSchema, rows: DatabaseRow[] } | undefined
  parseRowFrontmatter(content: string): Record<string, unknown>
  replaceFrontmatter(content: string, props: Record<string, unknown>): string
}
```

Frontmatter parser: hand-rolled (~60 lines) — parse `---\nkey: value\n---` block. No new dependencies.

---

## `databaseView.ts` (webview table view)

Renders into `editorRoot` as vanilla HTML. Style follows `style.css` dark theme.

**Features (MVP):**
- Column headers with type icons, click to sort (asc/desc)
- Inline cell editing:
  - `text` → `contentEditable`
  - `select` → `<select>` dropdown with schema options
  - `checkbox` → `<input type="checkbox">`
  - `date` → `<input type="date">`
  - `number` → `<input type="number">`
- Click row title → posts `RequestFileMessage` to open row page in CM6 editor
- "+ New Row" button → posts `CreateDatabaseRowMessage`
- "+ Add Column" → inline schema editor, posts `SaveDatabaseSchemaMessage`
- Delete column/row (hover × button)

Pattern: mirror `tablePlugin.ts`'s approach — `contentEditable` cells, blur/Enter commits, Escape reverts.

---

## `frontmatterPlugin.ts` (CM6 plugin for row pages)

When a row page is open:
- Hide the raw `---\n...\n---` block when cursor is outside it
- Show a rendered properties panel above the editor (`Decoration.replace` widget)
- Clicking the panel reveals the raw frontmatter for editing

This follows the pattern of `inlineStylePlugin.ts` — `StateField` + `Decoration.replace`.

---

## Implementation Order

1. **`messages.ts`** — add all new types first (unblocks TypeScript everywhere)
2. **`databaseIndex.ts`** — build + query + frontmatter parser/writer
3. **`extension.ts`** — wire DatabaseIndex, add message handlers, detection guard in `sendFileTo()`
4. **`databaseView.ts`** — table view HTML/CSS, read-only first, then cell editing
5. **`index.ts`** — `showDatabase()` + `case "openDatabase"`
6. **`componentMenu.ts`** — `/database` slash command
7. **`frontmatterPlugin.ts`** — properties panel in row page editor (can ship after MVP)
8. **Notion CSV import** — `src/csvImporter.ts` + `valt.importNotionCsv` command (post-MVP)

---

## Universal Page Frontmatter (post-MVP)

Add minimal YAML frontmatter to **all** pages, not just database rows.

**Format for regular pages:**
```markdown
---
created: "2026-03-10T14:32:00Z"
tags: ["project", "work"]
links: ["a3f2bc1d", "c1d2e3f4"]
---

# My Page

Body text...
```

**Fields:**
- `created` — ISO timestamp written once at file creation; survives copy/move/sync (unlike `fs.statSync`)
- `tags` — cache of all `@tag(Label)` values found in body; kept in sync on save
- `links` — cache of all `@[uuid]` values found in body; kept in sync on save

**Utility:**
- `created` is the main concrete win — filesystem dates are fragile across git, cloud sync, export/import
- `tags` + `links` allow `PageIndex.build()` to skip full-body parsing by reading frontmatter only — not a big win for small files today, but makes the index rebuild O(frontmatter) instead of O(file) if the corpus grows
- Standard YAML frontmatter means files are readable by Obsidian, Hugo, Jekyll, etc.

**Changes required:**

`src/pageIndex.ts`:
- `updateEntry()` — after computing tags/links from body, write them back to frontmatter if changed
- `build()` — try reading frontmatter-cached links/tags before falling back to full-body parse
- `extractTitle()` — already safe (uses `/^# /m`), frontmatter lines don't match

`src/extension.ts`:
- `handleCreateFile()` — write `created:` timestamp when scaffolding a new page
- `handleSaveFile()` — after `computeRename()`, call `syncFrontmatter(filePath, content)` to keep tags/links cache fresh

`src/webview/frontmatterPlugin.ts` (already planned for DB rows):
- Extend to apply to all pages, not just database rows
- Show a collapsed "metadata" chip above the H1 (created date + tag count); expand on click

**Migration:** One-time `valt.migrateFrontmatter` command — reads all `.md` files, injects `created:` from `fs.statSync().birthtime`, writes back. Run once; idempotent.

---

## Notion Import (post-MVP)

`src/csvImporter.ts` — `importNotionCsv(csvContent, targetDir, pageIndex)`:
1. Parse CSV; infer column types (checkbox if all true/false, date if YYYY-MM-DD, select if <12 distinct values, etc.)
2. Write `.valtdb.json` schema
3. Create one `.md` per row with frontmatter + `# Title` heading
4. For relation fields: attempt `pageIndex.getByDisplayName()` → write `@[uuid]` if found

---

## Verification

1. `npm run build` — no TypeScript errors
2. Open VSCode extension host, type `/database` → folder + schema created, table view opens
3. Add a column (select type with options) — verify `.valtdb.json` updated on disk
4. Edit a cell — verify frontmatter written to row `.md` file
5. Click a row title — verify CM6 editor opens with properties panel above H1
6. Rename row H1 — verify file rename still works (existing `computeRename()` path)
7. Create a `@[uuid]` link to a database row from another page — verify backlinks appear
