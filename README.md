# Valt

A lightweight personal knowledge base VSCode extension. Notes stay as plain `.md` files on disk, edited through a CodeMirror 6 webview with a rich set of editing features.

## Features

- **`@decorator` syntax** — type `@now`, `@yesterday`, `@"next friday"` for date badges; `@tag(Label)` for color-tinted tag pills; `@[uuid]` for stable page links
- **`/` component menu** — insert tables, code blocks, headings, todos, dividers, and more
- **Inline styles** — `**bold**` / `*italic*` markers hidden when cursor is outside; Ctrl+B / Ctrl+I to toggle
- **Emoji autocomplete** — type `:query` to search and insert emoji glyphs
- **Table plugin** — markdown pipe tables rendered as interactive widgets
- **Tag sidebar** — color-coded tag tree with auto-assigned or custom colors
- **Backlinks** — reverse-link graph maintained automatically
- **Auto-rename** — changing the H1 heading renames the file on disk
- **Database** - a table but each row corresponds to a page with some YAML frontmatter corresponding to column data

## File naming

Files use a stable 8-char hex prefix: `a3f2bc1d Getting Started.md`. Links use UUID only (`@[a3f2bc1d]`) so they survive renames.

## Build

```bash
npm run build   # one-shot
npm run watch   # esbuild --watch
```
