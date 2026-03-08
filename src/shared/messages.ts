/**
 * Typed message bus — all host↔webview comms go here.
 * Simplified for CodeMirror: just open/save full files.
 */

// ── Extension → Webview ──────────────────────────────────────────────────────

export interface OpenFileMessage {
  type: "openFile";
  path: string;
  content: string;
  webviewBaseUri: string;
}

export interface FileIndexMessage {
  type: "fileIndex";
  files: string[]; // basenames of all .md files in the workspace
}

export interface TagIndexMessage {
  type: "tagIndex";
  tags: Record<string, string[]>;   // tagName → basenames of files containing it
  colors: Record<string, string>;   // tagName → hex color
}

export type ExtensionMessage = OpenFileMessage | FileIndexMessage | TagIndexMessage;

// ── Webview → Extension ──────────────────────────────────────────────────────

export interface ReadyMessage {
  type: "ready";
}

export interface RequestFileMessage {
  type: "requestFile";
  path: string;
}

export interface SaveFileMessage {
  type: "saveFile";
  filePath: string;
  content: string;
}

export type WebviewMessage =
  | ReadyMessage
  | RequestFileMessage
  | SaveFileMessage;
