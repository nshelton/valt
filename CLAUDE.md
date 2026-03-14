# Valt — Architecture & Agent Guide

A lightweight personal knowledge base VSCode extension. Markdown stays as plain `.md` on disk. The webview embeds a CodeMirror 6 editor with rich syntax highlighting, heading sizes, fenced code language support, `@decorator` syntax, and a `/`-slash component menu.

## Repository layout

```
src/
  extension.ts           Host entry point. Activates on valt.open. Reads/writes files.
  pageIndex.ts           PageIndex class — UUID system, backlinks graph, auto-rename.
  databaseIndex.ts       DatabaseIndex class — scans .valtdb.json schemas and row files.
  treeProvider.ts        TreeDataProvider for the sidebar file tree (drag-and-drop).
  tagTreeProvider.ts     TreeDataProvider for the sidebar tag tree (colored dots).
  favoritesProvider.ts   TreeDataProvider for the favorites panel (drag-to-pin).
  shared/
    messages.ts          Typed message bus — all host↔webview comms go here.
                         Also exports assertNever() for exhaustive switch checks.
  webview/
    index.ts             Webview bootstrap. Creates CodeMirror editor, home screen.
    decorators.ts        CM6 ViewPlugin + autocomplete + @now ephemeral replacer.
    decoratorProviders.ts  DateTimeProvider, PageProvider, TagProvider.
    tablePlugin.ts       CM6 plugin: markdown tables as interactive <table> widgets.
    emojiPlugin.ts       :query emoji autocomplete + emoji glyph size plugin.
    inlineStylePlugin.ts Hides **bold**/*italic* markers; Ctrl+B / Ctrl+I commands.
    componentMenu.ts     /slash command menu (table, code, tag, link, headings…).
    linkPlugin.ts        CM6 plugin: renders [text](url) links with fetched title/favicon.
    linkMetadataStore.ts Client-side LRU cache for URL metadata (title + favicon).
    imagePlugin.ts       CM6 plugin: renders ![alt](path) images as inline widgets.
    frontmatterPlugin.ts CM6 plugin: hides YAML frontmatter, shows as pill when collapsed.
    twoColumnPlugin.ts   CM6 plugin: <!-- 2col --> blocks rendered as side-by-side editors.
    databaseView.ts      Table/board view for database folders (driven by .valtdb.json).
    style.css            Dark theme + CodeMirror overrides. No framework.
    css.d.ts             Type declaration for .css imports (esbuild text loader).
assets/
  valt-icon.svg
esbuild.js               Dual-bundle: extension (CJS) + webview (IIFE).
```

## Core rules

1. **Typed message bus** — never bypass `messages.ts`. Add interface first, then `case` in the switch. Both switches use `default: assertNever(message)` for compile-time exhaustive checking.
2. **Two worlds** — `dist/extension.js` is Node/CJS. `dist/webview.js` is browser IIFE. Never import `vscode` in `src/webview/`.
3. **No React, no Tailwind, no CSS frameworks.** Vanilla TS + CodeMirror.
4. Small focused libraries are acceptable (e.g. `chrono-node`, `emoji-mart`).

## Defensive patterns

These patterns exist throughout the codebase to prevent common failure modes:

- **Atomic writes** — all file writes go through `atomicWriteSync()` (write to `.valt-tmp`, then `fs.renameSync`). A crash mid-write cannot corrupt the original file.
- **Message validation** — `validateWebviewMessage()` checks `typeof raw.type === "string"` and validates critical fields before the switch. Malformed messages are logged and rejected.
- **Exhaustive switches** — both `handleWebviewMessage()` and `handleExtensionMessage()` use `default: assertNever(message)`. Adding a new message type without a handler is a compile error.
- **Watcher suppression** — `suppressWatcher` flag prevents redundant index rebuilds during the save→rename window in `handleSaveFile`.
- **Bounded caches** — `linkMetaCache` (extension, max 500) and `LinkMetadataStore` (webview, max 200) use LRU eviction to prevent unbounded memory growth.
- **Per-panel state** — `PanelState { panel, currentFilePath }` tracks which file each panel has open. Enables targeted broadcasts (favorites, delete notifications).
- **Output channel** — `vscode.window.createOutputChannel("Valt")` provides structured diagnostics. All catch blocks log to it with context (file path, operation).

## Panel state model

```typescript
interface PanelState {
  panel: vscode.WebviewPanel;
  currentFilePath: string;  // set by sendFileTo(), "" when on home/database
}
let panels: PanelState[];   // last element = most-recently-focused
```

- `getActivePanel()` returns the last element.
- `broadcastToAll()` iterates all panels via `ps.panel.webview.postMessage()`.
- `sendFileTo()` sets `target.currentFilePath = filePath` after posting.
- Favorite toggles broadcast to all panels showing the same file.
- Delete operations broadcast `showHome` to all panels.

## Page identity & file naming

Files use a stable 8-char hex UUID prefix: `a3f2bc1d Getting Started.md`.

- `pageIndex.ts` (`PageIndex` class) owns all ID logic — parsing, link graph, rename computation.
- Links are always `@[a3f2bc1d]` (UUID only). Display-name or filename links are not supported.
- On save, `computeRename()` checks if the H1 title changed and returns a new canonical filename. The extension renames the file on disk and notifies the webview via `FileRenamedMessage`.
- `PageIndex` maintains a reverse-link graph so backlinks can be computed per file.

## Data flow — open a file

```
User clicks tree item
  → valt.openFile command
  → extension.ts sendFileTo(filePath, panelState)
  → posts OpenFileMessage { path, content, webviewBaseUri, backlinks, outgoingLinks,
                            children, createdAt, modifiedAt, breadcrumb, isFavorited }
  → sets panelState.currentFilePath = filePath
  → index.ts showDocument() — replaces editor content or creates editor
```

## Data flow — editing & save

```
User types in CodeMirror
  → EditorView.updateListener fires on docChanged
  → scheduleSave() — 500ms debounce
  → posts SaveFileMessage { filePath, content }
  → extension.ts handleSaveFile()
      suppressWatcher = true
      atomicWriteSync(filePath, content)   ← write to .valt-tmp, then rename
      computeRename() → rename on disk if H1 changed → FileRenamedMessage
      suppressWatcher = false
      updateTagIndexForFile() → TagIndexMessage
      sendFileIndex() → FileIndexMessage to all panels
```

## Database system

Database folders contain a `.valtdb.json` schema file and row files (markdown with YAML frontmatter).

- `databaseIndex.ts` (`DatabaseIndex` class) scans workspace for database folders, parses schemas and rows.
- `databaseView.ts` (`DatabaseView` class) renders table/board views in the webview.
- Row properties are stored as YAML frontmatter; column definitions live in `.valtdb.json`.
- CRUD operations: `CreateDatabaseMessage`, `CreateDatabaseRowMessage`, `SaveRowPropertyMessage`, `SaveDatabaseSchemaMessage`, `DeleteDatabaseRowMessage`, `DeleteDatabaseMessage`.

## @decorator system

Decorators are triggered by `@`. Providers live in `decoratorProviders.ts`, registered via `createDecoratorExtensions()` in `decorators.ts`.

| Syntax | Display | Behaviour |
|---|---|---|
| `@now` | `@Mon March 8, 2026 2:32PM` green badge | **Ephemeral** — immediately replaced in-document with ISO timestamp |
| `@yesterday`, `@"next friday"` | green badge | Chrono-node parsed; stored as ISO date, rendered as badge |
| `@tag(Label)` | purple pill (color-tinted) | Mark decoration — styled even with cursor inside |
| `@[a3f2bc1d]` | page display name, blue | UUID link — stable across renames |

### Provider architecture

```
DecoratorProvider (abstract)
  tryMatch(afterAt: string) → DecoratorSpec | null
  completions(query: string) → Completion[]

DateTimeProvider   — chrono-node; @now ephemeral in apply()
PageProvider       — setPages(PageInfo[]); matches 8-char hex UUIDs
TagProvider        — setTagNames(names[], colors{}); isReplace: false (mark)
```

`DecoratorSpec.isReplace`:
- `true` → `Decoration.replace` widget; raw text shown when cursor is inside
- `false` → `Decoration.mark`; CSS class applied persistently even while editing

## Other editor features

- **Emoji autocomplete** — type `:query` to search by keyword (emoji-mart). Selecting inserts the glyph.
- **Inline style plugin** — `**bold**` / `*italic*` markers hidden when cursor is outside. Ctrl+B / Ctrl+I toggle markers on selection.
- **Component menu** — type `/` to insert: table, code block, quote, divider, tag pill, link, headings, todo checkbox, date, page.
- **Table plugin** — markdown pipe tables rendered as interactive `<table>` widgets with column resize, row/column add/delete.
- **Link plugin** — `[text](url)` links rendered with fetched page title and favicon. Metadata cached in `LinkMetadataStore`.
- **Image plugin** — `![alt](path)` rendered as inline image widgets. Drag-and-drop / paste to insert images.
- **Frontmatter plugin** — YAML frontmatter hidden behind a collapsible pill. Expands when cursor enters.
- **Two-column plugin** — `<!-- 2col -->` blocks rendered as side-by-side nested CodeMirror editors.

## Tag system

- `rebuildTagIndex()` scans all `.md` files on activate; `updateTagIndexForFile()` updates incrementally on save.
- `ValtTagTreeProvider` — sidebar tree with SVG colored dots. Colors auto-assigned from 8-color palette; overridable via `valt.tagColors` setting or right-click → **Set Tag Color**.
- `TagIndexMessage` sends `tags: Record<string, string[]>` and `colors: Record<string, string>` to webview.
- Tags are color-tinted in the editor via `TagProvider.tryMatch()` using inline `style` attributes.

## Message bus

All message types are defined in `src/shared/messages.ts` with full field documentation. Key patterns:
- **Extension → Webview** (12 types): `OpenFileMessage`, `FileIndexMessage`, `TagIndexMessage`, `FileRenamedMessage`, `RecentFilesMessage`, `ShowHomeMessage`, `FavoritesMessage`, `ImageSavedMessage`, `InsertPageLinkMessage`, `OpenDatabaseMessage`, `DatabaseSchemaUpdatedMessage`, `LinkMetadataMessage`
- **Webview → Extension** (17 types): file CRUD, database CRUD, image save, link metadata fetch, daily notes, favorites toggle
- Add new messages: define interface in `messages.ts` → add to union type → add `case` in both switches

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```

## What's next

- Multi-panel conflict detection (mtime-based)
- Full-text search
