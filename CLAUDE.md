# Valt — Architecture & Agent Guide

A lightweight personal knowledge base VSCode extension. Markdown stays as plain `.md` on disk. The webview embeds a CodeMirror 6 editor with rich syntax highlighting, heading sizes, fenced code language support, `@decorator` syntax, and a `/`-slash component menu.

## Repository layout

```
src/
  extension.ts           Host entry point. Activates on valt.open. Reads/writes files.
  pageIndex.ts           PageIndex class — UUID system, backlinks graph, auto-rename.
  treeProvider.ts        TreeDataProvider for the sidebar file tree.
  tagTreeProvider.ts     TreeDataProvider for the sidebar tag tree (colored dots).
  favoritesProvider.ts   TreeDataProvider for the favorites panel (drag-to-pin).
  shared/
    messages.ts          Typed message bus — all host↔webview comms go here.
  webview/
    index.ts             Webview bootstrap. Creates CodeMirror editor, home screen.
    decorators.ts        CM6 ViewPlugin + autocomplete + @now ephemeral replacer.
    decoratorProviders.ts  DateTimeProvider, PageProvider, TagProvider.
    tablePlugin.ts       CM6 plugin: markdown tables as interactive <table> widgets.
    emojiPlugin.ts       :query emoji autocomplete + emoji glyph size plugin.
    inlineStylePlugin.ts Hides **bold**/*italic* markers; Ctrl+B / Ctrl+I commands.
    componentMenu.ts     /slash command menu (table, code, tag, link, headings…).
    style.css            Dark theme + CodeMirror overrides. No framework.
    css.d.ts             Type declaration for .css imports (esbuild text loader).
assets/
  valt-icon.svg
esbuild.js               Dual-bundle: extension (CJS) + webview (IIFE).
```

## Core rules

1. **Typed message bus** — never bypass `messages.ts`. Add interface first, then `case` in the switch.
2. **Two worlds** — `dist/extension.js` is Node/CJS. `dist/webview.js` is browser IIFE. Never import `vscode` in `src/webview/`.
3. **No React, no Tailwind, no CSS frameworks.** Vanilla TS + CodeMirror.
4. Small focused libraries are acceptable (e.g. `chrono-node`, `emoji-mart`).

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
  → extension.ts sendFileToWebview()
  → posts OpenFileMessage { path, content, webviewBaseUri, backlinks, outgoingLinks,
                            createdAt, modifiedAt, breadcrumb }
  → index.ts showDocument() — replaces editor content or creates editor
```

## Data flow — editing & save

```
User types in CodeMirror
  → EditorView.updateListener fires on docChanged
  → scheduleSave() — 500ms debounce
  → posts SaveFileMessage { filePath, content }
  → extension.ts handleSaveFile()
      fs.writeFileSync (full content, no splicing)
      computeRename() → rename on disk if H1 changed → FileRenamedMessage
      updateTagIndexForFile() → TagIndexMessage
      updatePageIndex() → FileIndexMessage
```

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
- **Component menu** — type `/` to insert: table, code block, quote, divider, tag pill, link, headings, todo checkbox, date.
- **Table plugin** — markdown pipe tables rendered as interactive `<table>` widgets.

## Tag system

- `rebuildTagIndex()` scans all `.md` files on activate; `updateTagIndexForFile()` updates incrementally on save.
- `ValtTagTreeProvider` — sidebar tree with SVG colored dots. Colors auto-assigned from 8-color palette; overridable via `valt.tagColors` setting or right-click → **Set Tag Color**.
- `TagIndexMessage` sends `tags: Record<string, string[]>` and `colors: Record<string, string>` to webview.
- Tags are color-tinted in the editor via `TagProvider.tryMatch()` using inline `style` attributes.

## Message bus (`messages.ts`)

**Extension → Webview:**
- `OpenFileMessage` — path, content, webviewBaseUri, backlinks, outgoingLinks, createdAt, modifiedAt, breadcrumb
- `FileIndexMessage` — `pages: PageInfo[]`
- `TagIndexMessage` — `tags`, `colors`
- `FileRenamedMessage` — oldPath, newPath
- `RecentFilesMessage` — `files: RecentFileEntry[]`
- `ShowHomeMessage` — navigate to home screen

**Webview → Extension:**
- `ReadyMessage` — handshake; triggers file index + tag index send
- `RequestFileMessage` — path (absolute fsPath or UUID) to open
- `SaveFileMessage` — filePath + full content string
- `CreateFileMessage` — create a blank new page and open it
- `CreateDailyNoteMessage` — create/open today's daily note

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```

## What's next

- Image paste handler
- Multi-panel layout
