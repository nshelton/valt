/**
 * Webview entry point — CodeMirror 6 markdown editor.
 */
import { EditorView, keymap, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import type { ExtensionMessage, WebviewMessage } from "../shared/messages";
import { tablePlugin } from "./tablePlugin";
import { createDecoratorExtensions, createDecoratorCompletionSource } from "./decorators";
import { emojiCompletionSource } from "./emojiPlugin";
import { componentMenuCompletionSource } from "./componentMenu";
import { inlineStylePlugin, boldCommand, italicCommand } from "./inlineStylePlugin";
import { DateTimeProvider, PageProvider, TagProvider } from "./decoratorProviders";
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

// ── DOM refs ──────────────────────────────────────────────────────────────────

const welcomeEl  = document.getElementById("welcome")  as HTMLDivElement;
const editorRoot = document.getElementById("editor-root") as HTMLDivElement;

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
      inlineStylePlugin,
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
    case "openFile":
      currentFilePath = message.path;
      showDocument(message.content);
      break;
    case "fileIndex":
      pageProvider.setFiles(message.files);
      break;
    case "tagIndex":
      tagProvider.setTagNames(Object.keys(message.tags), message.colors);
      break;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showDocument(content: string): void {
  welcomeEl.style.display  = "none";
  editorRoot.style.display = "block";

  if (editorView) {
    // Replace content without losing undo history if same file
    const currentContent = editorView.state.doc.toString();
    if (currentContent !== content) {
      editorView.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
      });
    }
  } else {
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
