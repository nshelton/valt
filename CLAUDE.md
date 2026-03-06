# Valt — Architecture & Agent Guide

A lightweight personal knowledge base VSCode extension. Markdown stays as plain `.md` on disk. The webview is a WYSIWYG-style always-on contenteditable editor — no mode switching.

## Repository layout

```
src/
  extension.ts       Host entry point. Activates on valt.open.
  treeProvider.ts    TreeDataProvider for the sidebar.
  shared/
    messages.ts      ★ Typed message bus — all host↔webview comms go here.
  webview/
    index.ts         Bootstrap. Owns currentFilePath, currentFileList, currentBaseUri.
    renderer.ts      marked lexer → BlockInfo map + DOM builder (buildDocumentDOM).
    inlineParser.ts  Inline markdown → DOM nodes with hidden .md-syn markers.
    editor.ts        Contenteditable event wiring + @ autocomplete.
    decorators.ts    @decorator pre-processor (runs before marked.parse).
    style.css        Single stylesheet. No framework.
assets/
  valt-icon.svg
esbuild.js           Dual-bundle: extension (CJS) + webview (IIFE).
```

## Core rules

1. **Typed message bus** — never bypass `messages.ts`. Add interface first, then `case` in the switch.
2. **Two worlds** — `dist/extension.js` is Node/CJS. `dist/webview.js` is browser IIFE. Never import `vscode` in `src/webview/`.
3. **No React, no Tailwind, no CSS frameworks.** Vanilla TS + DOM.
4. **No runtime deps** beyond `marked` and `highlight.js`.
5. **Every function ≤ 40 lines**, single responsibility.

## Data flow — open a file

```
User clicks tree item → valt.openFile → sendFileToWebview()
  posts OpenFileMessage { path, content, webviewBaseUri, fileList }
  → index.ts showDocument()
      buildDocumentDOM() → { fragment, blockMap }
      documentEl.appendChild(fragment)
      initEditor(documentEl, blockMap, ctx)
```

## Data flow — edit a block

```
All blocks are contenteditable at all times (no click-to-activate).
User types → input event → autocomplete check
User blurs → finalizeEdit()
    innerText.trimEnd() + original trailing whitespace → newRaw
    if changed: postMessage(UpdateBlockMessage { filePath, start, end, newRaw })
    → extension splices file, writes disk, posts fileChanged
    → showDocument() re-renders (scroll position preserved)
```

## Key data structures

**BlockInfo** (renderer.ts): one per marked top-level token.
```typescript
{ id, raw, start, end, isSpace, tokenType, depth? }
// start/end are char offsets in the full file — used for splice write-back
```

**Inline DOM invariant** (inlineParser.ts): `textContent` of rendered nodes == original markdown.
`**bold**` → `<strong><span class="md-syn">**</span>bold<span class="md-syn">**</span></strong>`
`.md-syn` is `opacity:0`; revealed via `cursor-here` class on `selectionchange`.

## Block rendering by type

| tokenType | Rendered as |
|---|---|
| heading | `contenteditable` div, `valt-editor-h1`…`h6`, `# ` as `.md-heading-marker` |
| paragraph | `contenteditable` div, inline formatting via `renderInlineNodes` |
| code | `contenteditable` div, `valt-editor-code`, raw fences as text |
| blockquote | `contenteditable` div, `valt-editor-blockquote`, `> ` as `.md-blockquote-marker` |
| list | `contenteditable` div, `valt-editor-list`, `- `/`1. ` as `.md-list-marker` |
| hr / table / image | `renderBlockRaw` via marked, non-editable `.valt-block-static` |

## Decorators (`decorators.ts`)

Pre-processor runs before `marked.parse()`. Order matters (known forms before bare `@`):
`@datetime(...)` · `@status(draft|active|done)` · `@tag(name)` · `@pagename` (bare, wiki-link)

Adding a decorator: add `RE` + `transform*()`, add CSS class, call from `applyDecorators()`.

## Autocomplete

Triggered by `@` in any contenteditable block. Uses Range API (not `selectionStart`).
- `getTextBeforeCaret()` → range from block start to cursor → `.toString()`
- Caret position via `sel.getRangeAt(0).getBoundingClientRect()`
- Commit via `sel.modify('extend', 'backward', ...)` + `execCommand('insertText')`

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```

## What's next

- Image paste handler
- Quick switcher (`valt.quickOpen`)
- Table editing
