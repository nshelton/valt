# Valt — Feature Backlog

Ranked roughly by impact vs effort. Each item notes where in the codebase the work lives.

---

## 1. Backlinks panel
**What:** A "Linked from" section at the bottom of each open file listing every note that links to it.

**Why high value:** The link graph is already fully tracked. `PageIndex` maintains a `linkers` map (file → files that reference it). This is pure UI wiring — zero new infrastructure.

**Implementation sketch:**
- Add a `BacklinksMessage { type: "backlinks", links: PageInfo[] }` to `messages.ts`.
- In `extension.ts / handleSaveFile` and `sendFileToWebview`, compute `pageIndex.getLinkers(filePath)` and post the message.
- In `webview/index.ts`, render a collapsible `<div id="backlinks">` below the editor. Each entry is a clickable line that posts `requestFile`.
- Style in `style.css` alongside the existing decorator styles.

**Files touched:** `messages.ts`, `extension.ts`, `webview/index.ts`, `style.css`

---

## 2. New file creation
**What:** A "New note" button in the sidebar and/or a `valt.newFile` command (Ctrl+N).

**Why high value:** There is currently no way to create a note from inside the extension. Users must switch to the OS file manager or terminal.

**Implementation sketch:**
- Register `valt.newFile` in `package.json` (command palette + sidebar toolbar `+` icon).
- In the handler: prompt for a title with `vscode.window.showInputBox`, generate a filename following the existing convention (`[nextId] [Title].md`), write the file with an `# Title` heading, call `rebuildIndexes()`, then open it with `sendFileToWebview`.
- `PageIndex.nextId()` can compute the next numeric prefix from existing entries.

**Files touched:** `package.json`, `extension.ts`, `pageIndex.ts`

---

## 3. Cursor and scroll position persistence
**What:** Remember where the cursor was in each file. When you return to a file you left, restore the cursor position and scroll offset.

**Why:** Currently `createEditor` always starts at position 0. For long notes this means losing your place every time you switch away.

**Implementation sketch:**
- In `webview/index.ts`, keep a `Map<string, { anchor: number; head: number; scrollTop: number }>`.
- Before destroying the old editor (in `showDocument`), snapshot `editorView.state.selection.main` and `editorView.scrollDOM.scrollTop` and store under `currentFilePath`.
- After `createEditor(content)`, if the map has an entry for the new file, dispatch a selection change and set `scrollTop`.

**Files touched:** `webview/index.ts`

---

## 4. Quick open (Ctrl+P style)
**What:** A fuzzy-search popup over all notes triggered by `Ctrl+P` (or a dedicated keybinding).

**Why:** The sidebar file tree is fine for small vaults but becomes unwieldy at scale. A keyboard-driven fuzzy picker is the standard solution.

**Implementation sketch:**
- Register `valt.quickOpen` command; bind to `Ctrl+Shift+P` (or `Ctrl+P` if not conflicting with VS Code).
- In the webview, render a floating `<div id="quick-open">` with an `<input>` and a results list (reuse the existing `pageList` already sent via `fileIndex` message).
- Filter `pageList` by fuzzy match on display name as the user types; click or Enter opens the file via `requestFile`.
- Dismiss on Escape or blur.

**Files touched:** `package.json`, `webview/index.ts`, `style.css`

---

## 5. Create-on-click for missing links
**What:** Clicking a `@[Note Name]` link that doesn't resolve to an existing file should offer to create it.

**Why:** This is the core "wiki" workflow. In Obsidian, clicking an unresolved link immediately creates the file. Without it, users have to manually create the file then add the link.

**Implementation sketch:**
- In `extension.ts / handleRequestFile`, when `pageIndex.getByDisplayName(name)` returns nothing and `findFiles` finds nothing, post a new `LinkNotFoundMessage { type: "linkNotFound", name }` back to the webview.
- In `webview/index.ts`, intercept `linkNotFound` and show an inline banner: *"Note 'X' doesn't exist — Create it?"*
- On confirm, post a new `CreateFileMessage { type: "createFile", title }` to the extension.
- Extension handles it the same way as `valt.newFile` (see feature #2).

**Files touched:** `messages.ts`, `extension.ts`, `webview/index.ts`, `style.css`

---

## 6. File system watcher
**What:** Watch the workspace for external `.md` changes (git checkout, another editor, CLI tools) and rebuild the index automatically.

**Why:** Currently the tag and page indexes go stale if files change outside Valt. This causes wrong autocomplete suggestions and broken sidebar counts until the next save-from-within-Valt.

**Implementation sketch:**
- In `extension.ts / activate`, create a `vscode.workspace.createFileSystemWatcher("**/*.md")`.
- Wire `onDidCreate`, `onDidChange`, `onDidDelete` to call `rebuildIndexes()` (debounced ~300ms to avoid hammering on git operations that touch many files at once).
- Add the watcher to `context.subscriptions`.

**Files touched:** `extension.ts`

---

## 7. Global search
**What:** Full-text search across all notes, accessible from the sidebar or a command.

**Why:** Find-in-file (Ctrl+F) only searches the open document. For a knowledge base, cross-note search is essential.

**Implementation sketch:**
- Register `valt.search` command, shown as a search icon in the sidebar tree toolbar.
- Open a small input panel (VS Code `QuickPick` is the easiest path) that calls `vscode.workspace.findFiles` then greps content with `vscode.workspace.openTextDocument` + regex match.
- Display results as a `QuickPickItem` list (file name + matching line preview); selecting an item fires `valt.openFile` and posts a `ScrollToLineMessage` to position the editor at the match.
- Alternatively, render results in the webview itself for a richer UI.

**Files touched:** `package.json`, `extension.ts`, `messages.ts` (optional webview path)

---

## 8. Image paste / embed
**What:** Paste an image from the clipboard directly into the editor. Save it as a file in the vault and insert the markdown reference.

**Why:** Already listed in the CLAUDE.md "What's next" section. Inserting images currently requires manually saving the file and typing the path.

**Implementation sketch:**
- In `webview/index.ts`, add a `paste` event listener on the editor DOM.
- If `event.clipboardData.files` contains an image, post a `PasteImageMessage { type: "pasteImage", dataUrl: string, mimeType: string }` to the extension.
- In `extension.ts`, decode the data URL, write the file to a `assets/` subfolder of the workspace with a timestamp name, then post back an `InsertTextMessage { type: "insertText", text: "![](assets/xyz.png)" }`.
- In `webview/index.ts`, dispatch an insert at the current cursor position.

**Files touched:** `messages.ts`, `extension.ts`, `webview/index.ts`

---

## 9. Delete / rename from sidebar
**What:** Right-click context menu items on the file tree: "Rename" and "Delete".

**Why:** Currently there is no way to rename (beyond editing the H1 heading) or delete a file from within the extension. Users must use the OS or VS Code's own explorer.

**Implementation sketch:**
- In `package.json`, add `valt.renameFile` and `valt.deleteFile` to `menus["view/item/context"]` with `when: "view == valt.fileTree && viewItem == file"`.
- `valt.renameFile`: `showInputBox` pre-filled with current display name → write the new H1 into the file content → the existing auto-rename logic in `handleSaveFile` takes over.
- `valt.deleteFile`: `showWarningMessage` confirmation → `fs.unlinkSync` → `rebuildIndexes()` → if it was the open file, post a `FileDeletedMessage` so the webview returns to the welcome screen.

**Files touched:** `package.json`, `extension.ts`, `treeProvider.ts`, `messages.ts`

---

## 10. Tag colors in the webview
**What:** Reflect per-tag colors from `valt.tagColors` settings inside the editor's `@tag(Label)` pills, not just in the sidebar dots.

**Why:** The sidebar shows colored dots but the webview pills are all the same purple. This is a consistency gap.

**Implementation sketch:**
- The `tagIndex` message already sends `colors: Record<string, string>` to the webview.
- In `TagProvider.setTagNames`, store the colors map.
- In `TagProvider.tryMatch`, return a `style` attribute (or a CSS custom property) with the tag's color in the `DecoratorSpec`.
- Update `buildDecorations` to pass through `attributes` including the inline style.

**Files touched:** `webview/decoratorProviders.ts`, `webview/decorators.ts`, `style.css`
