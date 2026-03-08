# Valt — Architecture & Agent Guide

A lightweight personal knowledge base VSCode extension. Markdown stays as plain `.md` on disk. The webview embeds a CodeMirror 6 editor — you edit the markdown source directly with rich syntax highlighting, heading sizes, and fenced code language support.

## Repository layout

```
src/
  extension.ts       Host entry point. Activates on valt.open. Reads/writes files.
  treeProvider.ts    TreeDataProvider for the sidebar file tree.
  shared/
    messages.ts      Typed message bus — all host↔webview comms go here.
  webview/
    index.ts         Webview bootstrap. Creates CodeMirror editor, handles save.
    style.css        Dark theme + CodeMirror overrides. No framework.
    css.d.ts         Type declaration for .css imports (esbuild text loader).
assets/
  valt-icon.svg
esbuild.js           Dual-bundle: extension (CJS) + webview (IIFE).
```

## Core rules

1. **Typed message bus** — never bypass `messages.ts`. Add interface first, then `case` in the switch.
2. **Two worlds** — `dist/extension.js` is Node/CJS. `dist/webview.js` is browser IIFE. Never import `vscode` in `src/webview/`.
3. **No React, no Tailwind, no CSS frameworks.** Vanilla TS + CodeMirror.
4. **Runtime deps**: CodeMirror 6 packages only (`@codemirror/*`).
5. **Keep it simple** — the editor is CodeMirror, not a custom content-editable system.

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
```

No block offsets, no splicing — the full file content is sent on every save. CodeMirror handles undo/redo, cursor position, and selection state internally.

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

## Heading styles

Headings get CSS classes (`cm-heading-1` through `cm-heading-6`) via a custom `HighlightStyle`. The CSS applies font sizes matching the old block editor:

- h1: 2rem, h2: 1.4rem, h3: 1.15rem, h4: 1rem, h5: 0.9rem uppercase, h6: 0.85rem muted

## Message bus (messages.ts)

**Extension → Webview:**
- `OpenFileMessage` — path, content, webviewBaseUri

**Webview → Extension:**
- `ReadyMessage` — handshake on load
- `RequestFileMessage` — request a file by path
- `SaveFileMessage` — filePath + full content string

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```

## What's next

- Rendered table widget (replace table source with interactive `<table>` via CM widget decoration)
- Image paste handler
- Quick switcher (`valt.quickOpen`)
- @decorator support (datetime, status, tag pills via CM decorations)
- Wikilink click-to-navigate
