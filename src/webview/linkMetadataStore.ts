/**
 * Client-side cache for URL link metadata (title + favicon data URL).
 *
 * The store is a singleton. When a URL is first encountered by the link plugin,
 * `request()` fires a fetchLinkMetadata message to the extension and marks the
 * entry as 'pending'. When the extension replies the entry moves to 'loaded' or
 * 'failed'. Subscribers (e.g. the editor dispatch trigger) are notified on every
 * state change so CodeMirror can re-run its decoration pass.
 */

type MetaStatus = "pending" | "loaded" | "failed";

export interface LinkMeta {
  status: MetaStatus;
  title?: string;
  faviconDataUrl?: string;
}

type RequestFn = (url: string) => void;
type Listener  = () => void;

const CACHE_MAX = 200;

export class LinkMetadataStore {
  private readonly cache = new Map<string, LinkMeta>();
  private readonly listeners = new Set<Listener>();

  /** Return current metadata for a URL, or undefined if never requested. */
  get(url: string): LinkMeta | undefined {
    return this.cache.get(url);
  }

  /**
   * Ensure metadata for `url` is being fetched. Idempotent — no-ops if the URL
   * is already pending, loaded, or failed.
   */
  request(url: string, requestFn: RequestFn): void {
    if (this.cache.has(url)) return;
    this.cacheSet(url, { status: "pending" });
    requestFn(url);
  }

  /** Called when the extension responds with metadata. */
  receive(url: string, title: string | null, faviconDataUrl: string | null): void {
    if (title === null && faviconDataUrl === null) {
      this.cacheSet(url, { status: "failed" });
    } else {
      this.cacheSet(url, {
        status: "loaded",
        title: title ?? undefined,
        faviconDataUrl: faviconDataUrl ?? undefined,
      });
    }
    this.notify();
  }

  /** Subscribe to any metadata update. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private cacheSet(url: string, meta: LinkMeta): void {
    this.cache.delete(url);
    this.cache.set(url, meta);
    if (this.cache.size > CACHE_MAX) {
      // Evict oldest entries (first in Map iteration order)
      const excess = this.cache.size - CACHE_MAX;
      let i = 0;
      for (const k of this.cache.keys()) {
        if (i++ >= excess) break;
        this.cache.delete(k);
      }
    }
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
