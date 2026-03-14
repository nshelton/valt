# Valt

A lightweight personal knowledge base VSCode extension. Notes stay as plain `.md` files on disk, edited through a CodeMirror 6 webview with a rich set of editing features.

## Features

- **`@decorator` syntax** — type `@now`, `@yesterday`, `@"next friday"` for date badges; `@tag(Label)` for color-tinted tag pills; `@[uuid]` for stable page links
- **`/` component menu** — insert tables, code blocks, headings, todos, dividers, tags, page links, and more
- **Inline styles** — `**bold**` / `*italic*` markers hidden when cursor is outside; Ctrl+B / Ctrl+I to toggle
- **Emoji autocomplete** — type `:query` to search and insert emoji glyphs
- **Table plugin** — markdown pipe tables rendered as interactive widgets with column resize, row/column add/delete
- **Link previews** — `[text](url)` links display fetched page title and favicon
- **Image support** — drag-and-drop or paste images directly into the editor
- **Two-column layout** — `<!-- 2col -->` blocks rendered as side-by-side editors
- **Frontmatter** — YAML frontmatter hidden behind a collapsible pill
- **Database** — table/board views where each row is a page with YAML frontmatter columns
- **Tag sidebar** — color-coded tag tree with auto-assigned or custom colors
- **Favorites** — drag-to-pin sidebar panel for quick access
- **Backlinks** — reverse-link graph maintained automatically
- **Auto-rename** — changing the H1 heading renames the file on disk
- **Multi-panel** — open multiple Valt panels side by side; state tracked per panel

## File naming

Files use a stable 8-char hex prefix: `a3f2bc1d Getting Started.md`. Links use UUID only (`@[a3f2bc1d]`) so they survive renames.

## Architecture

Two-world design: extension host (Node/CJS) and webview (browser IIFE) communicate through a typed message bus (`src/shared/messages.ts`). All message switches use `assertNever()` for compile-time exhaustive checking.

Key defensive patterns:
- **Atomic writes** — all file writes go through a write-to-temp-then-rename pattern
- **Message validation** — runtime checks reject malformed webview messages before the switch
- **Bounded caches** — link metadata caches use LRU eviction (500 extension-side, 200 webview-side)
- **Structured logging** — errors logged to a dedicated "Valt" output channel

See [CLAUDE.md](CLAUDE.md) for full architecture documentation.

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```
