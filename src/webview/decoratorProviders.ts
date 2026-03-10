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
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(d: Date): string {
  const dateStr = `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  const h = d.getHours(), m = d.getMinutes();
  // chrono-node defaults to 12:00 for date-only phrases; treat that as no time
  if ((h === 0 && m === 0) || (h === 12 && m === 0)) return dateStr;
  return `${dateStr} ${d.toTimeString().slice(0, 5)}`;
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
      displayText: "@" + formatDate(d),
      cssClass: "cm-decorator cm-decorator-now",
      isReplace: false,
    };
  }

  completions(query: string): Completion[] {
    const q = query.toLowerCase();

    // @now is special — ephemeral: immediately replaces itself with timestamp
    const nowCompletion: Completion = {
      label: "@now",
      type: "keyword",
      detail: formatDate(new Date()),
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
          detail: d ? formatDate(d) : undefined,
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
  filename: string;
  displayName: string;
  emoji: string | null;
}

export class PageProvider extends DecoratorProvider {
  /** displayName.toLowerCase() → PageInfo */
  private pageMap: Map<string, PageInfo> = new Map();
  /** Raw filename set for backward-compat @filename.md links */
  private fileSet = new Set<string>();

  setPages(pages: PageInfo[]): void {
    this.pageMap.clear();
    this.fileSet.clear();
    for (const p of pages) {
      this.pageMap.set(p.displayName.toLowerCase(), p);
      this.fileSet.add(p.filename);
    }
  }

  tryMatch(afterAt: string): DecoratorSpec | null {
    // New style: @[Display Name] — bracket content without .md
    if (!afterAt.endsWith(".md")) {
      const page = this.pageMap.get(afterAt.toLowerCase());
      if (!page) return null;
      const display = page.emoji ? `${page.emoji} ${page.displayName}` : page.displayName;
      return {
        displayText: display,
        cssClass: "cm-decorator-file",
        isReplace: false,
      };
    }

    // Legacy style: @[filename.md] or @simple.md — match by raw filename
    if (this.fileSet.has(afterAt)) {
      // Strip leading `[id] ` prefix for display
      const stem = afterAt.replace(/\.md$/, "").replace(/^\d+\s+/, "").trim();
      return {
        displayText: stem || afterAt,
        cssClass: "cm-decorator-file",
        isReplace: false,
      };
    }

    return null;
  }

  completions(query: string): Completion[] {
    // query may start with "[" when triggered from the bracket @[ matcher
    const isBracket = query.startsWith("[");
    const q = (isBracket ? query.slice(1) : query).toLowerCase();

    return [...this.pageMap.values()]
      .filter((p) => p.displayName.toLowerCase().includes(q))
      .map((p): Completion => {
        const label = `@[${p.displayName}]`;
        const detail = p.emoji ?? undefined;
        return { label, type: "file", detail };
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
