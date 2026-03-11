/**
 * Typed message bus — all host↔webview comms go here.
 */

// ── Shared types ──────────────────────────────────────────────────────────────

/** A resolved link to another page. */
export interface PageLink {
  displayName: string;
  fsPath: string;        // absolute filesystem path (use with requestFile)
  emoji: string | null;
}

/** Metadata for one page, sent as part of FileIndexMessage. */
export interface PageInfo {
  id: string | null;     // 8-char hex UUID (used to form stable @[uuid] links)
  filename: string;      // "a3f2bc1d Getting Started.md"
  displayName: string;   // H1 text (no emoji prefix, no UUID prefix)
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
  backlinks: PageLink[];
  outgoingLinks: PageLink[];
  children: PageLink[];   // pages one level deeper in the folder hierarchy
  createdAt: number;     // ms timestamp (0 if unavailable)
  modifiedAt: number;    // ms timestamp
  breadcrumb: string[];  // folder names between workspace root and file
  isFavorited: boolean;
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

/** Sent after a favorite toggle so the webview can update the star button. */
export interface FavoritesMessage {
  type: "favorites";
  isFavorited: boolean;
}

/** Sent after the extension writes an image to disk. */
export interface ImageSavedMessage {
  type: "imageSaved";
  relativePath: string;  // e.g. "./img-d4e5f6a7.png"  (relative to the .md file)
}

/** Sent after a new page is created via /page command; webview inserts the link. */
export interface InsertPageLinkMessage {
  type: "insertPageLink";
  uuid: string;
}

export type ExtensionMessage =
  | OpenFileMessage
  | FileIndexMessage
  | TagIndexMessage
  | FileRenamedMessage
  | RecentFilesMessage
  | ShowHomeMessage
  | FavoritesMessage
  | ImageSavedMessage
  | InsertPageLinkMessage;

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

/** Ask the extension to toggle favorite status for the current file. */
export interface ToggleFavoriteMessage {
  type: "toggleFavorite";
  filePath: string;
}

/** Ask the extension to save a dropped/pasted image next to the current file. */
export interface SaveImageMessage {
  type: "saveImage";
  currentFilePath: string;
  data: string;       // base64-encoded image bytes
  mimeType: string;   // e.g. "image/png"
}

/** Ask the extension to create a new page and insert a link to it at the cursor. */
export interface CreatePageFromEditorMessage {
  type: "createPageFromEditor";
  currentFilePath: string;
}

export type WebviewMessage =
  | ReadyMessage
  | RequestFileMessage
  | SaveFileMessage
  | CreateFileMessage
  | CreateDailyNoteMessage
  | ToggleFavoriteMessage
  | SaveImageMessage
  | CreatePageFromEditorMessage;
