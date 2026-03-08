# Valt — Architecture & Agent Guide

A lightweight personal knowledge base VSCode extension. Markdown stays as plain `.md` on disk. The webview embeds a CodeMirror 6 editor — you edit the markdown source directly with rich syntax highlighting, heading sizes, fenced code language support, and `@decorator` syntax.

## Repository layout

```
src/
  extension.ts           Host entry point. Activates on valt.open. Reads/writes files.
  treeProvider.ts        TreeDataProvider for the sidebar file tree.
  tagTreeProvider.ts     TreeDataProvider for the sidebar tag tree (with colored dots).
  shared/
    messages.ts          Typed message bus — all host↔webview comms go here.
  webview/
    index.ts             Webview bootstrap. Creates CodeMirror editor, handles save.
    decorators.ts        CM6 ViewPlugin + autocomplete + @now ephemeral replacer.
    decoratorProviders.ts  Provider classes: DateTimeProvider, PageProvider, TagProvider.
    tablePlugin.ts       CM6 plugin that renders markdown tables as interactive widgets.
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
4. Pulling in small libraries for a specific component is acceptable (e.g. `chrono-node` for date parsing).

## Data flow — open a file

```
User clicks tree item
  → valt.openFile command
  → extension.ts sendFileToWebview()
  → posts OpenFileMessage { path, content, webviewBaseUri }
  → index.ts showDocument()
      if editor exists: dispatch content replacement
      else: createEditor(content)
  → editor.focus()
```

## Data flow — editing & save

```
User types in CodeMirror
  → EditorView.updateListener fires on docChanged
  → scheduleSave() sets a 500ms debounce timer
  → posts SaveFileMessage { filePath, content }
  → extension.ts handleSaveFile() writes full file via fs.writeFileSync
  → updateTagIndexForFile() rescans tags, fires sendTagIndex()
```

No block offsets, no splicing — the full file content is sent on every save. CodeMirror handles undo/redo, cursor position, and selection state internally.

## @decorator system

Decorators are triggered by `@` in the editor. Three provider classes live in `decoratorProviders.ts`, all registered in `decorators.ts` via `createDecoratorExtensions()`.

### Decorator types

| Syntax | Display | Behaviour |
|---|---|---|
| `@now` | `@2026-03-08 14:32` green badge | **Ephemeral** — immediately replaced in-document with current timestamp |
| `@yesterday`, `@"next friday"` | `@2026-03-07` green badge | Chrono-node parsed; stored as typed, rendered as badge |
| `@tag(Label)` | purple pill | Mark decoration — always styled, even with cursor inside |
| `@simple.md` | blue underline | Click to open file |
| `@[Name with spaces.md]` | blue underline | Bracket syntax for files with spaces/parens |

### Provider architecture (`decoratorProviders.ts`)

```
DecoratorProvider (abstract)
  tryMatch(afterAt: string) → DecoratorSpec | null
  completions(query: string) → Completion[]

DateTimeProvider   — uses chrono-node; @now has ephemeral apply() in completion
PageProvider       — setFiles(basenames[]); bracket syntax; strips UUID from display
TagProvider        — setTagNames(names[]); isReplace: false (mark, always styled)
```

`DecoratorSpec.isReplace`:
- `true` → `Decoration.replace` widget; raw text shown when cursor is inside
- `false` → `Decoration.mark`; CSS class applied persistently even while editing

### Regex pattern (priority-ordered)

```
tag  > bracket-file  > simple-file  > full-timestamp  > quoted-phrase  > bare-word
```

Full timestamp pattern (`@YYYY-MM-DD HH:MM`) must precede bare-word so the space-separated time isn't orphaned.

### @now ephemeral replacer

An `EditorView.updateListener` scans for `@now` tokens after each doc change. It only replaces tokens where the cursor has moved past the token (cursor not inside `[from, to]`). Dispatches with a `nowReplacedAnnotation` to prevent infinite loops.

## Tag system

Tags are parsed from all `.md` files on startup and after every save.

### Extension side (`extension.ts` + `tagTreeProvider.ts`)

- `rebuildTagIndex()` — scans all workspace `.md` files on activate
- `updateTagIndexForFile(path, content)` — incremental update on save; sends `TagIndexMessage`
- `ValtTagTreeProvider` — VSCode sidebar tree; each tag shown with an SVG colored dot
- Colors: auto-assigned from an 8-color palette, overridable via `valt.tagColors` workspace setting
- Right-click a tag → **Set Tag Color** → hex input

### Webview side (`index.ts`)

- `tagProvider.setTagNames(Object.keys(message.tags))` — called when `tagIndex` message arrives
- Autocomplete: typing `@tag(` suggests all known tag names filtered by partial input

## CodeMirror extensions in use

| Extension | Purpose |
|---|---|
| `markdown()` + `markdownLanguage` | Markdown parsing + syntax tree |
| `languages` (language-data) | Syntax highlighting in fenced code blocks |
| `history()` + `historyKeymap` | Undo/redo (Ctrl+Z / Ctrl+Shift+Z) |
| `searchKeymap` | Find/replace (Ctrl+F) |
| `highlightActiveLine()` | Subtle highlight on current line |
| `drawSelection()` | Custom selection rendering |
| `EditorView.lineWrapping` | Soft wrap long lines |
| `syntaxHighlighting(headingStyles)` | CSS classes for h1–h6 font sizes |
| `tablePlugin` | Renders markdown tables as interactive `<table>` widgets |
| `createDecoratorExtensions()` | @decorator ViewPlugin + autocomplete + @now replacer |

## Heading styles

Headings get CSS classes (`cm-heading-1` through `cm-heading-6`) via a custom `HighlightStyle`. The CSS applies font sizes:

- h1: 2rem, h2: 1.4rem, h3: 1.15rem, h4: 1rem, h5: 0.9rem uppercase, h6: 0.85rem muted

## Message bus (`messages.ts`)

**Extension → Webview:**
- `OpenFileMessage` — path, content, webviewBaseUri
- `FileIndexMessage` — `files: string[]` (basenames of all `.md` files)
- `TagIndexMessage` — `tags: Record<string, string[]>` (tagName → file basenames)

**Webview → Extension:**
- `ReadyMessage` — handshake on load; triggers `sendFileIndex()` + `sendTagIndex()`
- `RequestFileMessage` — request a file by path (wikilink click)
- `SaveFileMessage` — filePath + full content string

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```

## What's next

- Image paste handler
- Quick switcher (`valt.quickOpen`)
- Tag colors reflected in the webview (not just the sidebar)
