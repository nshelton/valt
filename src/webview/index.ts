/**
 * Webview entry point.
 * Bootstraps the message bus, injects the stylesheet, and wires up the UI.
 */
import { buildDocumentDOM } from "./renderer";
import { initEditor } from "./editor";
import type { ExtensionMessage, WebviewMessage } from "../shared/messages";
import styles from "./style.css";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Module state ──────────────────────────────────────────────────────────────

let currentFilePath   = "";
let currentFileList:  string[] = [];
let currentBaseUri    = "";

// ── DOM refs ──────────────────────────────────────────────────────────────────

const welcomeEl  = document.getElementById("welcome")  as HTMLDivElement;
const documentEl = document.getElementById("document") as HTMLDivElement;

// ── Stylesheet injection ──────────────────────────────────────────────────────

function injectStyles(): void {
  const el = document.createElement("style");
  el.textContent = styles;
  document.head.appendChild(el);
}

// ── Inbound messages (extension → webview) ────────────────────────────────────

window.addEventListener("message", (event: MessageEvent) => {
  handleExtensionMessage(event.data as ExtensionMessage);
});

function handleExtensionMessage(message: ExtensionMessage): void {
  switch (message.type) {
    case "openFile":
    case "fileChanged":
      currentFilePath  = message.path;
      currentFileList  = message.fileList;
      currentBaseUri   = message.webviewBaseUri;
      showDocument(message.path, message.content, message.webviewBaseUri, message.fileList);
      break;

    case "imageSaved":
      // Implemented in Step 5.
      break;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showDocument(
  filePath: string,
  rawMarkdown: string,
  webviewBaseUri: string,
  fileList: string[]
): void {
  const scrollTop = documentEl.scrollTop;

  welcomeEl.style.display  = "none";
  documentEl.style.display = "block";

  const { fragment, blockMap } = buildDocumentDOM(rawMarkdown, filePath, webviewBaseUri, fileList);
  documentEl.innerHTML = "";
  documentEl.appendChild(fragment);

  // Restore scroll position (important when a block write-back triggers re-render).
  documentEl.scrollTop = scrollTop;

  initEditor(documentEl, blockMap, {
    filePath,
    webviewBaseUri,
    fileList,
    postMessage: (msg) => vscode.postMessage(msg),
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  injectStyles();
  vscode.postMessage({ type: "ready" });
}

init();
