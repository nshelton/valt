/**
 * Typed message bus — all host↔webview comms go here.
 */

// ── Shared types ──────────────────────────────────────────────────────────────

/** Metadata for one page, sent as part of FileIndexMessage. */
export interface PageInfo {
  filename: string;      // "1 Getting Started.md"
  displayName: string;   // H1 text (no emoji prefix, no numeric ID)
  emoji: string | null;  // leading emoji from H1, if any
}

// ── Extension → Webview ──────────────────────────────────────────────────────

export interface OpenFileMessage {
  type: "openFile";
  path: string;
  content: string;
  webviewBaseUri: string;
}

export interface FileIndexMessage {
  type: "fileIndex";
  pages: PageInfo[];  // all .md files, sorted by numeric ID then alphabetically
}

export interface TagIndexMessage {
  type: "tagIndex";
  tags: Record<string, string[]>;   // tagName → filenames of files containing it
  colors: Record<string, string>;   // tagName → hex color
}

/** Sent when the currently-open file is renamed due to an H1 heading change. */
export interface FileRenamedMessage {
  type: "fileRenamed";
  oldPath: string;
  newPath: string;
}

export type ExtensionMessage =
  | OpenFileMessage
  | FileIndexMessage
  | TagIndexMessage
  | FileRenamedMessage;

// ── Webview → Extension ──────────────────────────────────────────────────────

export interface ReadyMessage {
  type: "ready";
}

export interface RequestFileMessage {
  type: "requestFile";
  /**
   * Either an absolute filesystem path (for legacy @filename.md links)
   * or a page display name (for @[Page Name] links, resolved on extension side).
   */
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
