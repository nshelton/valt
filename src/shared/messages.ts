/**
 * Typed message bus — all host↔webview comms go here.
 */

// ── Shared types ──────────────────────────────────────────────────────────────

// ── Database types ────────────────────────────────────────────────────────────

export type ColumnType = "text" | "number" | "select" | "multi-select" | "date" | "checkbox" | "relation" | "url";

export interface ColumnDef {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];  // for "select" and "multi-select"
}

export interface ViewConfig {
  id: string;
  type: "table" | "board";
  name: string;
  sort: { colId: string; dir: "asc" | "desc" }[];
  filters: { colId: string; op: string; value: unknown }[];
}

export interface DatabaseSchema {
  schemaVersion: number;
  columns: ColumnDef[];
  views: ViewConfig[];
  defaultView: string;
}

export interface DatabaseRow {
  fsPath: string;
  pageId: string | null;
  title: string;
  emoji: string | null;
  properties: Record<string, unknown>;
}

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
  breadcrumb: { name: string; fsPath: string }[];  // folder names + paths between workspace root and file
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

/** Sent when a database folder is opened — tells webview to show table view. */
export interface OpenDatabaseMessage {
  type: "openDatabase";
  folderPath: string;
  schema: DatabaseSchema;
  rows: DatabaseRow[];
}

/** Sent when the schema for an open database is updated on disk. */
export interface DatabaseSchemaUpdatedMessage {
  type: "databaseSchemaUpdated";
  folderPath: string;
  schema: DatabaseSchema;
}

/** Sent when link metadata (title + favicon) has been fetched for a URL. */
export interface LinkMetadataMessage {
  type: "linkMetadata";
  url: string;
  title: string | null;
  faviconDataUrl: string | null;
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
  | InsertPageLinkMessage
  | OpenDatabaseMessage
  | DatabaseSchemaUpdatedMessage
  | LinkMetadataMessage;

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

/** Ask the extension to save a single property value on a database row. */
export interface SaveRowPropertyMessage {
  type: "saveRowProperty";
  rowPath: string;
  colId: string;
  value: unknown;
}

/** Ask the extension to write an updated schema to a database folder. */
export interface SaveDatabaseSchemaMessage {
  type: "saveDatabaseSchema";
  folderPath: string;
  schema: DatabaseSchema;
}

/** Ask the extension to create a new row in a database and open it. */
export interface CreateDatabaseRowMessage {
  type: "createDatabaseRow";
  folderPath: string;
  title: string;
  properties: Record<string, unknown>;
}

/** Ask the extension to delete a database row file. */
export interface DeleteDatabaseRowMessage {
  type: "deleteDatabaseRow";
  rowPath: string;
}

/** Ask the extension to reload a database and send OpenDatabaseMessage. */
export interface RequestDatabaseMessage {
  type: "requestDatabase";
  folderPath: string;
}

/** Ask the extension to create a new database folder and open it. */
export interface CreateDatabaseMessage {
  type: "createDatabase";
  parentDir: string;
}

/** Ask the extension to delete the current page file. */
export interface DeleteFileMessage {
  type: "deleteFile";
  filePath: string;
}

/** Ask the extension to delete a database folder. */
export interface DeleteDatabaseMessage {
  type: "deleteDatabase";
  folderPath: string;
}

/** Ask the extension to open a URL in the system browser. */
export interface OpenUrlMessage {
  type: "openUrl";
  url: string;
}

/** Ask the extension to fetch title + favicon for a URL and reply with LinkMetadataMessage. */
export interface FetchLinkMetadataMessage {
  type: "fetchLinkMetadata";
  url: string;
}

export type WebviewMessage =
  | ReadyMessage
  | RequestFileMessage
  | SaveFileMessage
  | CreateFileMessage
  | CreateDailyNoteMessage
  | ToggleFavoriteMessage
  | SaveImageMessage
  | CreatePageFromEditorMessage
  | SaveRowPropertyMessage
  | SaveDatabaseSchemaMessage
  | CreateDatabaseRowMessage
  | DeleteDatabaseRowMessage
  | RequestDatabaseMessage
  | CreateDatabaseMessage
  | DeleteFileMessage
  | DeleteDatabaseMessage
  | OpenUrlMessage
  | FetchLinkMetadataMessage;
