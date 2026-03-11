/**
 * Webview entry point — CodeMirror 6 markdown editor.
 */
import { EditorView, keymap, highlightActiveLine, drawSelection, ViewPlugin, DecorationSet, Decoration, ViewUpdate } from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import type { ExtensionMessage, WebviewMessage, RecentFileEntry, OpenFileMessage } from "../shared/messages";
import { tablePlugin } from "./tablePlugin";
import { createDecoratorExtensions, createDecoratorCompletionSource } from "./decorators";
import { emojiCompletionSource, emojiSizePlugin } from "./emojiPlugin";
import { componentMenuCompletionSource } from "./componentMenu";
import { inlineStylePlugin, boldCommand, italicCommand } from "./inlineStylePlugin";
import { DateTimeProvider, PageProvider, TagProvider, type PageInfo } from "./decoratorProviders";
import styles from "./style.css";

const tagProvider = new TagProvider();
const pageProvider = new PageProvider();
const providers = [tagProvider, pageProvider, new DateTimeProvider()];

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Module state ──────────────────────────────────────────────────────────────

let currentFilePath = "";
let editorView: EditorView | null = null;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// ── Module state ── page metadata ─────────────────────────────────────────────

let pageList: PageInfo[] = [];
let recentFiles: RecentFileEntry[] = [];
let tagCount = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const welcomeEl   = document.getElementById("welcome")      as HTMLDivElement;
const pageEmojiEl = document.getElementById("page-emoji")   as HTMLDivElement;
const editorRoot  = document.getElementById("editor-root")  as HTMLDivElement;
const topbarEl    = document.getElementById("page-topbar")  as HTMLDivElement;

// ── Navigation history ────────────────────────────────────────────────────────

let backStack: string[] = [];
let isBackNav = false;

// ── Stylesheet injection ──────────────────────────────────────────────────────

function injectStyles(): void {
  const el = document.createElement("style");
  el.textContent = styles;
  document.head.appendChild(el);
}

// ── Markdown heading styles ───────────────────────────────────────────────────

const headingStyles = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-heading-1" },
  { tag: tags.heading2, class: "cm-heading-2" },
  { tag: tags.heading3, class: "cm-heading-3" },
  { tag: tags.heading4, class: "cm-heading-4" },
  { tag: tags.heading5, class: "cm-heading-5" },
  { tag: tags.heading6, class: "cm-heading-6" },
]);

// ── Inline code decoration (hides backticks when cursor is outside) ────────────

function buildInlineCodeDecos(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  const cursor = selection.main;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        if (node.name !== "InlineCode") return;
        const sample = doc.sliceString(node.from, node.from + 4);
        let delimLen = 0;
        while (delimLen < sample.length && sample[delimLen] === '`') delimLen++;
        const contentFrom = node.from + delimLen;
        const contentTo = node.to - delimLen;
        if (contentFrom >= contentTo) return;
        const cursorInside = cursor.from >= node.from && cursor.to <= node.to;
        if (cursorInside) return; // show raw syntax while editing
        builder.add(node.from, contentFrom, Decoration.replace({}));
        builder.add(contentFrom, contentTo, Decoration.mark({ class: "cm-inline-code" }));
        builder.add(contentTo, node.to, Decoration.replace({}));
      },
    });
  }
  return builder.finish();
}

const inlineCodePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildInlineCodeDecos(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildInlineCodeDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Code block line decoration (with hidden fence markers) ────────────────────

const codeBlockLineDeco  = Decoration.line({ class: "cm-codeblock" });
const codeBlockFenceDeco = Decoration.line({ class: "cm-codeblock cm-codeblock-fence" });
const hideDeco           = Decoration.replace({});

function buildCodeBlockDecos(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  const cursor = selection.main;

  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: rangeFrom, to: rangeTo,
      enter(node) {
        if (node.name !== "FencedCode") return;

        // Collect CodeMark children (open and close fence lines)
        let openMarkLine: { from: number; to: number } | null = null;
        let closeMarkLine: { from: number; to: number } | null = null;
        let child = node.node.firstChild;
        while (child) {
          if (child.name === "CodeMark") {
            const line = doc.lineAt(child.from);
            if (!openMarkLine) openMarkLine = line;
            else closeMarkLine = line;
          }
          child = child.nextSibling;
        }
        // Unclosed block (no closing fence) — don't hide anything
        if (!openMarkLine || !closeMarkLine) return false;

        const cursorInBlock = cursor.from <= node.to && cursor.to >= node.from;

        // Walk visible lines within this block
        let pos = Math.max(node.from, rangeFrom);
        const end = Math.min(node.to, rangeTo);
        while (pos <= end) {
          const line = doc.lineAt(pos);
          const isFence = line.from === openMarkLine.from || line.from === closeMarkLine.from;

          if (isFence) {
            if (cursorInBlock) {
              // Show fence line styled so user can edit it
              builder.add(line.from, line.from, codeBlockFenceDeco);
            } else {
              // Hide fence line; eat newline too so no blank line remains
              const hideEnd = line.to + 1 <= doc.length ? line.to + 1 : line.to;
              builder.add(line.from, hideEnd, hideDeco);
            }
          } else {
            builder.add(line.from, line.from, codeBlockLineDeco);
          }

          if (line.to >= end) break;
          pos = line.to + 1;
        }
        return false; // don't recurse into children
      },
    });
  }
  return builder.finish();
}

const codeBlockPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildCodeBlockDecos(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet)
        this.decorations = buildCodeBlockDecos(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Save logic ────────────────────────────────────────────────────────────────

function scheduleSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (!editorView || !currentFilePath) return;
    const content = editorView.state.doc.toString();
    vscode.postMessage({ type: "saveFile", filePath: currentFilePath, content });
  }, 500);
}

// ── Editor creation ───────────────────────────────────────────────────────────

function createEditor(content: string): EditorView {
  if (editorView) editorView.destroy();

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) scheduleSave();
  });

  const state = EditorState.create({
    doc: content,
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        { key: "Mod-b", run: boldCommand },
        { key: "Mod-i", run: italicCommand },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
      }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(headingStyles),
      tablePlugin,
      codeBlockPlugin,
      inlineCodePlugin,
      inlineStylePlugin,
      emojiSizePlugin,
      ...createDecoratorExtensions(
        providers,
        (msg) => vscode.postMessage(msg),
      ),
      autocompletion({ override: [componentMenuCompletionSource, createDecoratorCompletionSource(providers), emojiCompletionSource] }),
      updateListener,
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({
    state,
    parent: editorRoot,
  });

  editorView = view;
  return view;
}

// ── Inbound messages (extension → webview) ────────────────────────────────────

window.addEventListener("message", (event: MessageEvent) => {
  handleExtensionMessage(event.data as ExtensionMessage);
});

function handleExtensionMessage(message: ExtensionMessage): void {
  switch (message.type) {
    case "openFile": {
      if (!isBackNav && currentFilePath && currentFilePath !== message.path) {
        backStack.push(currentFilePath);
      }
      isBackNav = false;
      const isSameFile = currentFilePath === message.path;
      currentFilePath = message.path;
      showDocument(message.content, isSameFile);
      updateEmojiHeader(message.content);
      renderTopbar(message);
      break;
    }
    case "fileIndex":
      pageList = message.pages;
      pageProvider.setPages(message.pages);
      if (isOnHome()) refreshHomeStats();
      break;
    case "tagIndex":
      tagCount = Object.keys(message.tags).length;
      tagProvider.setTagNames(Object.keys(message.tags), message.colors);
      if (isOnHome()) refreshHomeStats();
      break;
    case "fileRenamed":
      if (currentFilePath === message.oldPath) {
        currentFilePath = message.newPath;
      }
      break;
    case "recentFiles":
      recentFiles = message.files;
      if (isOnHome()) renderHomeScreen();
      break;
    case "showHome":
      showHome();
      break;
  }
}

// ── Emoji header ──────────────────────────────────────────────────────────────

function updateEmojiHeader(content: string): void {
  const h1 = content.match(/^#[ \t]+(.+)$/m);
  if (!h1) { pageEmojiEl.style.display = "none"; return; }

  const title = h1[1].trim();
  const emojiMatch = title.match(
    /^(\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?)*)/u
  );
  if (emojiMatch) {
    pageEmojiEl.textContent = emojiMatch[1];
    pageEmojiEl.style.display = "block";
  } else {
    pageEmojiEl.style.display = "none";
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showDocument(content: string, sameFile = false): void {
  welcomeEl.style.display  = "none";
  editorRoot.style.display = "block";

  if (editorView && sameFile) {
    // Same file (e.g. external edit): patch content in-place to preserve undo history.
    const currentContent = editorView.state.doc.toString();
    if (currentContent !== content) {
      editorView.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
      });
    }
  } else {
    // Different file: fresh editor state so undo history doesn't bleed across files.
    // createEditor() destroys the old view and resets cursor/scroll to position 0.
    createEditor(content);
  }

  editorView?.focus();
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function fmtDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function countWords(content: string): number {
  const stripped = content.replace(/^#{1,6}\s+/gm, "").replace(/[*_`]/g, "").trim();
  return stripped ? stripped.split(/\s+/).length : 0;
}

function renderTopbar(msg: OpenFileMessage): void {
  const words = countWords(msg.content);
  const modified = fmtDate(msg.modifiedAt);
  const created = fmtDate(msg.createdAt);

  const breadcrumbHtml = msg.breadcrumb.length
    ? `<span class="topbar-breadcrumb">${msg.breadcrumb.map(escapeHtml).join(" / ")}</span>`
    : "";

  const metaParts: string[] = [];
  if (words > 0) metaParts.push(`${words} words`);
  if (modified) metaParts.push(`modified ${modified}`);
  if (created && created !== modified) metaParts.push(`created ${created}`);

  const chipHtml = (fsPath: string, displayName: string, emoji: string | null) =>
    `<button class="topbar-chip" data-path="${escapeAttr(fsPath)}">${emoji ? emoji + " " : ""}${escapeHtml(displayName)}</button>`;

  const backlinkChips = msg.backlinks.map((l) => chipHtml(l.fsPath, l.displayName, l.emoji)).join("");
  const outChips = msg.outgoingLinks.map((l) => chipHtml(l.fsPath, l.displayName, l.emoji)).join("");

  const hasLinks = msg.backlinks.length > 0 || msg.outgoingLinks.length > 0;
  const linksRow = hasLinks ? `
    <div class="topbar-row topbar-links-row">
      ${msg.backlinks.length > 0 ? `<span class="topbar-links-label">← refs</span><div class="topbar-chips">${backlinkChips}</div>` : ""}
      ${msg.backlinks.length > 0 && msg.outgoingLinks.length > 0 ? `<span class="topbar-links-sep"></span>` : ""}
      ${msg.outgoingLinks.length > 0 ? `<span class="topbar-links-label">→ links</span><div class="topbar-chips">${outChips}</div>` : ""}
    </div>` : "";

  topbarEl.innerHTML = `
    <div class="topbar-row topbar-nav-row">
      <button id="topbar-home" class="topbar-back-btn" title="Home">◈</button>
      <button id="topbar-back" class="topbar-back-btn" ${backStack.length === 0 ? "disabled" : ""} title="Go back">←</button>
      ${breadcrumbHtml}
      <span class="topbar-spacer"></span>
      ${metaParts.length ? `<span class="topbar-meta">${metaParts.join(" · ")}</span>` : ""}
      <button id="topbar-new" class="topbar-new-btn" title="New page">+</button>
    </div>
    ${linksRow}
  `;
  topbarEl.style.display = "block";

  document.getElementById("topbar-home")?.addEventListener("click", () => showHome());
  document.getElementById("topbar-back")?.addEventListener("click", () => {
    const prev = backStack.pop();
    if (prev) { isBackNav = true; vscode.postMessage({ type: "requestFile", path: prev }); }
  });
  document.getElementById("topbar-new")?.addEventListener("click", () => {
    vscode.postMessage({ type: "createFile" });
  });

  topbarEl.querySelectorAll<HTMLElement>(".topbar-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const p = chip.dataset.path;
      if (p) vscode.postMessage({ type: "requestFile", path: p });
    });
  });
}

// ── Home screen ───────────────────────────────────────────────────────────────

function isOnHome(): boolean {
  return welcomeEl.style.display !== "none";
}

function showHome(): void {
  welcomeEl.style.display = "block";
  editorRoot.style.display = "none";
  pageEmojiEl.style.display = "none";
  topbarEl.style.display = "none";
  currentFilePath = "";
  backStack = [];
  isBackNav = false;
  renderHomeScreen();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function renderHomeScreen(): void {
  welcomeEl.innerHTML = `
    <div class="home-header">
      <div class="home-logo">◈</div>
      <h1 class="home-title">Valt</h1>
    </div>
    <div class="home-toolbar">
      <div class="home-search-wrap">
        <input id="home-search" class="home-search" type="text" placeholder="Search pages…" autocomplete="off" spellcheck="false" />
        <div id="home-search-results" class="home-search-results" hidden></div>
      </div>
      <button id="home-new-btn" class="home-btn-primary">+ New Page</button>
    </div>
    <section class="home-section">
      <h2 class="home-section-title">Recent</h2>
      <div class="home-cards" id="home-cards">
        ${renderCards()}
      </div>
    </section>
    <div class="home-footer">
      <button id="home-daily-btn" class="home-btn-secondary">📅 Daily Note</button>
      <span class="home-stats" id="home-stats">${statsText()}</span>
    </div>
  `;
  wireHomeEvents();
}

function renderCards(): string {
  if (recentFiles.length === 0) {
    return `<p class="home-empty">No recent pages — open a file from the sidebar to get started.</p>`;
  }
  return recentFiles.map((f) => `
    <div class="home-card" data-path="${escapeAttr(f.path)}" role="button" tabindex="0">
      <div class="home-card-inner">
        ${f.emoji ? `<div class="home-card-emoji">${f.emoji}</div>` : ""}
        <div class="home-card-title">${escapeHtml(f.displayName)}</div>
        ${f.preview ? `<div class="home-card-preview">${escapeHtml(f.preview)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

function statsText(): string {
  const p = pageList.length;
  const t = tagCount;
  const parts: string[] = [];
  if (p > 0) parts.push(`${p} page${p !== 1 ? "s" : ""}`);
  if (t > 0) parts.push(`${t} tag${t !== 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function refreshHomeStats(): void {
  const el = document.getElementById("home-stats");
  if (el) el.textContent = statsText();
}

function wireHomeEvents(): void {
  // Card clicks
  welcomeEl.querySelectorAll<HTMLElement>(".home-card").forEach((card) => {
    const open = () => { const p = card.dataset.path; if (p) vscode.postMessage({ type: "requestFile", path: p }); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  });

  // New page button
  document.getElementById("home-new-btn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "createFile" });
  });

  // Daily note button
  document.getElementById("home-daily-btn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "createDailyNote" });
  });

  // Search
  const searchInput = document.getElementById("home-search") as HTMLInputElement | null;
  const searchResults = document.getElementById("home-search-results") as HTMLDivElement | null;
  if (!searchInput || !searchResults) return;

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.hidden = true; return; }
    const matches = pageList.filter((p) => p.displayName.toLowerCase().includes(q)).slice(0, 10);
    if (matches.length === 0) {
      searchResults.innerHTML = `<div class="home-search-empty">No pages found</div>`;
    } else {
      searchResults.innerHTML = matches.map((p) => `
        <div class="home-search-item" data-name="${escapeAttr(p.displayName)}" tabindex="0">
          <span class="home-search-item-icon">${p.emoji ?? "◈"}</span>
          <span>${escapeHtml(p.displayName)}</span>
        </div>
      `).join("");
      searchResults.querySelectorAll<HTMLElement>(".home-search-item").forEach((item) => {
        const open = () => {
          const name = item.dataset.name;
          if (name) vscode.postMessage({ type: "requestFile", path: name });
          searchInput.value = "";
          searchResults.hidden = true;
        };
        item.addEventListener("click", open);
        item.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      });
    }
    searchResults.hidden = false;
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { searchInput.value = ""; searchResults.hidden = true; }
  });

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target as Node) && !searchResults.contains(e.target as Node)) {
      searchResults.hidden = true;
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  injectStyles();
  renderHomeScreen();
  vscode.postMessage({ type: "ready" });
}

init();
