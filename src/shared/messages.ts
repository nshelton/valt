/**
 * Typed message bus for all communication between the extension host
 * and the webview. No stringly-typed postMessage calls anywhere else.
 */

// ── Extension → Webview ──────────────────────────────────────────────────────

export interface OpenFileMessage {
  type: "openFile";
  path: string;
  content: string;
  /** Webview-safe base URI for resolving relative assets (images, etc.) */
  webviewBaseUri: string;
  /** Absolute paths of all .md files in the workspace, for autocomplete. */
  fileList: string[];
}

export interface FileChangedMessage {
  type: "fileChanged";
  path: string;
  content: string;
  webviewBaseUri: string;
  fileList: string[];
}

export interface ImageSavedMessage {
  type: "imageSaved";
  relativePath: string;
}

export type ExtensionMessage =
  | OpenFileMessage
  | FileChangedMessage
  | ImageSavedMessage;

// ── Webview → Extension ──────────────────────────────────────────────────────

export interface RequestFileMessage {
  type: "requestFile";
  path: string;
}

export interface SaveImageMessage {
  type: "saveImage";
  /** Base64-encoded PNG bytes */
  dataBase64: string;
  /** The path of the currently open document — used to derive save location */
  currentFilePath: string;
}

export interface ReadyMessage {
  type: "ready";
}

export interface UpdateBlockMessage {
  type: "updateBlock";
  filePath: string;
  /** Char offset of the block's start in the source file */
  start: number;
  /** Char offset of the block's end in the source file */
  end: number;
  /** New raw markdown for this block (must include trailing newlines) */
  newRaw: string;
}

export interface DeleteBlockMessage {
  type: "deleteBlock";
  filePath: string;
  start: number;
  end: number;
}

export interface MoveBlockMessage {
  type: "moveBlock";
  filePath: string;
  movingStart: number;
  movingEnd: number;
  /** The moving block's raw will be inserted at this offset (before any adjustment for removal) */
  insertAfterOffset: number;
}

export type WebviewMessage =
  | RequestFileMessage
  | SaveImageMessage
  | ReadyMessage
  | UpdateBlockMessage
  | DeleteBlockMessage
  | MoveBlockMessage;
