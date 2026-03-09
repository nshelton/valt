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
import type { ExtensionMessage, WebviewMessage } from "../shared/messages";
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

// ── DOM refs ──────────────────────────────────────────────────────────────────

const welcomeEl   = document.getElementById("welcome")    as HTMLDivElement;
const pageEmojiEl = document.getElementById("page-emoji") as HTMLDivElement;
const editorRoot  = document.getElementById("editor-root") as HTMLDivElement;

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

// ── Code block line decoration ────────────────────────────────────────────────

const codeBlockLineDeco = Decoration.line({ class: "cm-codeblock" });

function buildCodeBlockDecos(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      let node = tree.resolveInner(line.from);
      while (node) {
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          builder.add(line.from, line.from, codeBlockLineDeco);
          break;
        }
        if (!node.parent) break;
        node = node.parent;
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const codeBlockPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildCodeBlockDecos(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildCodeBlockDecos(u.view);
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
      inlineStylePlugin,
      emojiSizePlugin,
      ...createDecoratorExtensions(
        providers,
        (msg) => vscode.postMessage(msg),
        (name) => currentFilePath.substring(0, currentFilePath.lastIndexOf("/") + 1) + name,
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
      const isSameFile = currentFilePath === message.path;
      currentFilePath = message.path;
      showDocument(message.content, isSameFile);
      updateEmojiHeader(message.content);
      break;
    }
    case "fileIndex":
      pageList = message.pages;
      pageProvider.setPages(message.pages);
      break;
    case "tagIndex":
      tagProvider.setTagNames(Object.keys(message.tags), message.colors);
      break;
    case "fileRenamed":
      if (currentFilePath === message.oldPath) {
        currentFilePath = message.newPath;
      }
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

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  injectStyles();
  vscode.postMessage({ type: "ready" });
}

init();
