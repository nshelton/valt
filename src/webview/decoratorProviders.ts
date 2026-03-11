/**
 * Decorator providers — each one knows how to:
 *   1. tryMatch(afterAt)  → produce a decoration spec
 *   2. completions(query) → suggest autocomplete options for text after @
 */
import * as chrono from "chrono-node";
import type { Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface DecoratorSpec {
  displayText: string;                    // text shown in the badge / widget
  cssClass: string;                       // class(es) on the rendered element
  isReplace: boolean;                     // true → Decoration.replace (widget); false → Decoration.mark
  attributes?: Record<string, string>;   // optional HTML attributes (e.g. inline style for mark decorations)
}

export abstract class DecoratorProvider {
  /** Given text after the @, return a decoration spec or null if not handled. */
  abstract tryMatch(afterAt: string): DecoratorSpec | null;
  /** Return autocomplete completions for the query typed after @. */
  abstract completions(query: string): Completion[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** ISO format stored in document: YYYY-MM-DD or YYYY-MM-DD HH:MM */
function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const h = d.getHours(), m = d.getMinutes();
  const dateStr = `${yyyy}-${mo}-${dd}`;
  // chrono-node defaults to 12:00 for date-only phrases; treat that as no time
  if ((h === 0 && m === 0) || (h === 12 && m === 0)) return dateStr;
  return `${dateStr} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Human-readable format for display widgets: Mon March 3, 2026 4:56PM */
function formatDateDisplay(d: Date): string {
  const day = DAY_NAMES[d.getDay()];
  const month = MONTH_NAMES[d.getMonth()];
  const dateStr = `${day} ${month} ${d.getDate()}, ${d.getFullYear()}`;
  const h = d.getHours(), m = d.getMinutes();
  if ((h === 0 && m === 0) || (h === 12 && m === 0)) return dateStr;
  const hour12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${dateStr} ${hour12}:${String(m).padStart(2, "0")}${ampm}`;
}

// Exported so the @now replacer can reuse it.
export { formatDate };

// ── DateTime provider ─────────────────────────────────────────────────────────

const DATE_SUGGESTIONS = [
  { text: "today" },
  { text: "yesterday" },
  { text: "tomorrow" },
  { text: "next week",   quoted: true },
  { text: "last week",   quoted: true },
  { text: "next month",  quoted: true },
  { text: "next friday", quoted: true },
  { text: "last monday", quoted: true },
];

export class DateTimeProvider extends DecoratorProvider {
  tryMatch(afterAt: string): DecoratorSpec | null {
    if (afterAt.endsWith(".md") || afterAt.startsWith("tag(")) return null;
    const d = chrono.parseDate(afterAt, new Date());
    if (!d) return null;
    return {
      displayText: "@" + formatDateDisplay(d),
      cssClass: "cm-decorator cm-decorator-now",
      isReplace: true,
    };
  }

  completions(query: string): Completion[] {
    const q = query.toLowerCase();

    // @now is special — ephemeral: immediately replaces itself with timestamp
    const nowCompletion: Completion = {
      label: "@now",
      type: "keyword",
      detail: formatDateDisplay(new Date()),
      apply: (view: EditorView, _: Completion, from: number, to: number) => {
        view.dispatch({ changes: { from, to, insert: "@" + formatDate(new Date()) } });
      },
    };

    const dateCompletions = DATE_SUGGESTIONS
      .filter((s) => s.text.startsWith(q))
      .map((s): Completion => {
        const label = s.quoted ? `@"${s.text}"` : `@${s.text}`;
        const d = chrono.parseDate(s.text, new Date());
        const resolved = d ? "@" + formatDate(d) : label;
        return {
          label,
          type: "keyword",
          detail: d ? formatDateDisplay(d) : undefined,
          apply: (view: EditorView, _: Completion, from: number, to: number) => {
            view.dispatch({ changes: { from, to, insert: resolved } });
          },
        };
      });

    // Always include @now if query could match "now"
    const results: Completion[] = [];
    if ("now".startsWith(q)) results.push(nowCompletion);
    results.push(...dateCompletions);
    return results;
  }
}

// ── Page provider ─────────────────────────────────────────────────────────────

export interface PageInfo {
  id: string | null;
  filename: string;
  displayName: string;
  emoji: string | null;
}

export class PageProvider extends DecoratorProvider {
  /** uuid → PageInfo */
  private byId: Map<string, PageInfo> = new Map();
  /** displayName.toLowerCase() → PageInfo (for legacy link compat) */
  private byName: Map<string, PageInfo> = new Map();

  setPages(pages: PageInfo[]): void {
    this.byId.clear();
    this.byName.clear();
    for (const p of pages) {
      if (p.id) this.byId.set(p.id, p);
      this.byName.set(p.displayName.toLowerCase(), p);
    }
  }

  tryMatch(afterAt: string): DecoratorSpec | null {
    // UUID link: @[a3f2bc1d] — 8 hex chars
    if (!/^[0-9a-f]{8}$/.test(afterAt)) return null;
    const page = this.byId.get(afterAt);
    if (!page) return null;
    const display = page.emoji ? `${page.emoji} ${page.displayName}` : `⬝ ${page.displayName}`;
    return { displayText: display, cssClass: "cm-decorator cm-decorator-file", isReplace: true };
  }

  completions(query: string): Completion[] {
    const isBracket = query.startsWith("[");
    const q = (isBracket ? query.slice(1) : query).toLowerCase();

    return [...this.byName.values()]
      .filter((p) => p.displayName.toLowerCase().includes(q))
      .map((p): Completion => {
        const displayLabel = p.emoji ? `${p.emoji} ${p.displayName}` : p.displayName;
        return {
          label: `@[${displayLabel}]`,
          type: "file",
          detail: p.emoji ?? undefined,
          apply: (view, _, from, to) => {
            // Insert UUID link — stable, never goes stale on rename
            const insert = p.id ? `@[${p.id}]` : `@[${p.displayName}]`;
            view.dispatch({ changes: { from, to, insert } });
          },
        };
      });
  }
}

// ── Tag provider ──────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h.padEnd(6, "0");
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export class TagProvider extends DecoratorProvider {
  private tagNames: string[] = [];
  private tagColors: Record<string, string> = {};

  setTagNames(names: string[], colors: Record<string, string> = {}): void {
    this.tagNames = names;
    this.tagColors = colors;
  }

  tryMatch(afterAt: string): DecoratorSpec | null {
    if (!afterAt.startsWith("tag(") || !afterAt.endsWith(")")) return null;
    const label = afterAt.slice(4, -1).trim();
    const color = this.tagColors[label];
    const attributes = color ? {
      style: `color:${color};background:${hexToRgba(color, 0.12)};border-color:${hexToRgba(color, 0.28)};`,
    } : undefined;
    return {
      displayText: afterAt, // not used for mark decorations
      cssClass: "cm-decorator-tag",
      isReplace: false, // mark: keeps styling even when cursor is inside
      attributes,
    };
  }

  completions(query: string): Completion[] {
    const q = query.toLowerCase();
    if (!q.startsWith("tag")) return [];

    // Extract partial label: "tag(" → "", "tag(wo" → "wo"
    const partial = q.startsWith("tag(") ? q.slice(4) : "";

    if (this.tagNames.length > 0) {
      return this.tagNames
        .filter((name) => name.toLowerCase().startsWith(partial))
        .map((name): Completion => ({ label: `@tag(${name})`, type: "keyword" }));
    }

    // Fallback when no tags exist yet — offer the template
    return [{ label: "@tag()", type: "keyword", detail: "tag pill" }];
  }
}
