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
  displayText: string; // text shown in the badge / widget
  cssClass: string;    // class(es) on the rendered element
  isReplace: boolean;  // true → Decoration.replace (widget); false → Decoration.mark
}

export abstract class DecoratorProvider {
  /** Given text after the @, return a decoration spec or null if not handled. */
  abstract tryMatch(afterAt: string): DecoratorSpec | null;
  /** Return autocomplete completions for the query typed after @. */
  abstract completions(query: string): Completion[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const date = d.toISOString().slice(0, 10);
  if (d.getHours() === 0 && d.getMinutes() === 0) return date;
  return `${date} ${d.toTimeString().slice(0, 5)}`;
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
      isReplace: true,
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
        return { label, type: "keyword", detail: d ? formatDate(d) : undefined };
      });

    // Always include @now if query could match "now"
    const results: Completion[] = [];
    if ("now".startsWith(q)) results.push(nowCompletion);
    results.push(...dateCompletions);
    return results;
  }
}

// ── Page provider ─────────────────────────────────────────────────────────────

export class PageProvider extends DecoratorProvider {
  private fileSet = new Set<string>();

  setFiles(basenames: string[]): void {
    this.fileSet = new Set(basenames);
  }

  tryMatch(afterAt: string): DecoratorSpec | null {
    if (!afterAt.endsWith(".md")) return null;
    return {
      displayText: "@" + afterAt,
      cssClass: "cm-decorator-file",
      isReplace: false,
    };
  }

  completions(query: string): Completion[] {
    const q = query.toLowerCase();
    return [...this.fileSet]
      .filter((f) => f.toLowerCase().includes(q))
      .map((f): Completion => ({ label: "@" + f, type: "file" }));
  }
}

// ── Tag provider ──────────────────────────────────────────────────────────────

export class TagProvider extends DecoratorProvider {
  tryMatch(afterAt: string): DecoratorSpec | null {
    const m = afterAt.match(/^tag\(([^)]*)\)$/);
    if (!m) return null;
    return {
      displayText: m[1] || "tag",
      cssClass: "cm-decorator cm-decorator-tag",
      isReplace: true,
    };
  }

  completions(query: string): Completion[] {
    const q = query.toLowerCase();
    if ("tag".startsWith(q) || q.startsWith("tag")) {
      return [{ label: "@tag()", type: "keyword", detail: "tag pill" }];
    }
    return [];
  }
}
