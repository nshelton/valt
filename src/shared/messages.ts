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

/** One entry in the recently-opened files list. */
export interface RecentFileEntry {
  path: string;          // absolute filesystem path
  displayName: string;
  emoji: string | null;
  preview: string;       // first ~180 chars of body text, markdown stripped
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

/** Sent (or re-sent) whenever the recent-files list changes. */
export interface RecentFilesMessage {
  type: "recentFiles";
  files: RecentFileEntry[];
}

/** Tell the webview to navigate back to the home screen. */
export interface ShowHomeMessage {
  type: "showHome";
}

export type ExtensionMessage =
  | OpenFileMessage
  | FileIndexMessage
  | TagIndexMessage
  | FileRenamedMessage
  | RecentFilesMessage
  | ShowHomeMessage;

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

/** Ask the extension to create a blank new page and open it. */
export interface CreateFileMessage {
  type: "createFile";
}

/** Ask the extension to create/open today's daily note. */
export interface CreateDailyNoteMessage {
  type: "createDailyNote";
}

export type WebviewMessage =
  | ReadyMessage
  | RequestFileMessage
  | SaveFileMessage
  | CreateFileMessage
  | CreateDailyNoteMessage;
