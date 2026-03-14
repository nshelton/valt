/**
 * Renders [text](url) markdown links as widgets when the cursor is outside.
 * Raw markdown is shown when the cursor is inside the link span.
 *
 * External links (https?://):
 *   - While metadata is loading: plain underlined link (LinkWidget)
 *   - Once loaded: pill with favicon + page title (LinkMentionWidget)
 *   - On fetch failure: falls back permanently to plain link
 *
 * Anchor links (#slug): scroll to the matching heading in the document.
 */
import {
  ViewPlugin, DecorationSet, Decoration, EditorView, ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { WebviewMessage } from "../shared/messages";
import type { LinkMetadataStore } from "./linkMetadataStore";

/** Dispatch with this effect to force the link plugin to rebuild decorations. */
export const linkMetaUpdated = StateEffect.define<null>();

// Matches [text](url) — external URLs, absolute paths, or #anchor links
const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

type PostMessage = (msg: WebviewMessage) => void;
type AnchorClick = (anchor: string) => void;

// ── Plain link widget (loading state / anchor links) ──────────────────────────

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly url: string,
    readonly postMessage: PostMessage,
    readonly onAnchorClick: AnchorClick,
  ) { super(); }

  eq(other: LinkWidget): boolean {
    return this.text === other.text && this.url === other.url;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-link";
    span.textContent = this.text;
    span.title = this.url;
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (this.url.startsWith("#")) {
        this.onAnchorClick(this.url.slice(1));
      } else {
        this.postMessage({ type: "openUrl", url: this.url });
      }
    });
    return span;
  }

  ignoreEvent() { return false; }
}

// ── Enriched mention pill (loaded state) ──────────────────────────────────────

class LinkMentionWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly url: string,
    readonly title: string,
    readonly faviconDataUrl: string | undefined,
    readonly postMessage: PostMessage,
  ) { super(); }

  eq(other: LinkMentionWidget): boolean {
    return (
      this.url === other.url &&
      this.title === other.title &&
      this.faviconDataUrl === other.faviconDataUrl
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "link-mention";
    span.title = this.url;

    if (this.faviconDataUrl) {
      const img = document.createElement("img");
      img.src = this.faviconDataUrl;
      img.width = 12;
      img.height = 12;
      img.alt = "";
      span.appendChild(img);
    }

    const label = document.createElement("span");
    label.textContent = this.title;
    span.appendChild(label);

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.postMessage({ type: "openUrl", url: this.url });
    });

    return span;
  }

  ignoreEvent() { return false; }
}

// ── Decoration builder ────────────────────────────────────────────────────────

function buildDecorations(
  view: EditorView,
  store: LinkMetadataStore,
  postMessage: PostMessage,
  onAnchorClick: AnchorClick,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from: curFrom, to: curTo } = view.state.selection.main;
  const re = new RegExp(LINK_PATTERN.source, "g");

  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    let pos = rangeFrom;
    while (pos <= rangeTo) {
      const line = view.state.doc.lineAt(pos);
      re.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = re.exec(line.text)) !== null) {
        const mFrom = line.from + match.index;
        const mTo   = mFrom + match[0].length;
        const text  = match[1];
        const url   = match[2];

        const isExternal = url.startsWith("http://") || url.startsWith("https://");
        const isAnchor   = url.startsWith("#");
        if (!isExternal && !isAnchor) continue;

        // Show raw markdown when cursor is anywhere inside the link
        const cursorInside = curFrom <= mTo && curTo >= mFrom;
        if (cursorInside) continue;

        let widget: WidgetType;
        if (isExternal) {
          store.request(url, (u) => postMessage({ type: "fetchLinkMetadata", url: u }));
          const meta = store.get(url);
          if (meta?.status === "loaded") {
            const title = meta.title ?? extractHostname(url);
            widget = new LinkMentionWidget(text, url, title, meta.faviconDataUrl, postMessage);
          } else {
            widget = new LinkWidget(text, url, postMessage, onAnchorClick);
          }
        } else {
          widget = new LinkWidget(text, url, postMessage, onAnchorClick);
        }

        builder.add(mFrom, mTo, Decoration.replace({ widget }));
      }

      if (line.to >= rangeTo) break;
      pos = line.to + 1;
    }
  }

  return builder.finish();
}

function extractHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── Heading scroll helpers ────────────────────────────────────────────────────

/** Convert a heading's text to its URL anchor slug (GitHub-flavoured). */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

/** Scroll the editor to the first heading whose slug matches `anchor`. */
export function scrollToHeading(view: EditorView, anchor: string): void {
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^#{1,6}\s+(.+)/.exec(line.text);
    if (m && headingSlug(m[1]) === anchor) {
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 60 }),
        selection: { anchor: line.from },
      });
      view.focus();
      return;
    }
  }
}

// ── Plugin factory ────────────────────────────────────────────────────────────

export function createLinkPlugin(
  postMessage: PostMessage,
  onAnchorClick: AnchorClick,
  store: LinkMetadataStore,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, store, postMessage, onAnchorClick);
      }
      update(update: ViewUpdate) {
        const metaChanged = update.transactions.some(
          (tr) => tr.effects.some((e) => e.is(linkMetaUpdated)),
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || metaChanged) {
          this.decorations = buildDecorations(update.view, store, postMessage, onAnchorClick);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
