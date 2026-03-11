/**
 * Slash-command component menu.
 * Trigger: type `/` at the start of a word to see insertable components.
 *
 * /table    → markdown table starter
 * /tag      → @tag() pill (cursor inside)
 * /link     → @[] file link (cursor inside)
 * /code     → fenced code block (cursor on blank inner line)
 * /todo     → - [ ] checkbox
 * /divider  → --- horizontal rule
 * /quote    → > blockquote prefix
 * /h1–/h3  → heading prefixes
 * /date     → today's date (YYYY-MM-DD)
 * /2column  → two-column layout placeholder (not yet rendered)
 * /page     → create a new page and insert a link to it here
 */
import { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { WebviewMessage } from "../shared/messages";

// ── Component definitions ─────────────────────────────────────────────────────

interface ComponentItem {
  label: string;
  detail: string;
  section?: string;
  apply: (view: EditorView, from: number, to: number) => void;
}

function buildComponents(
  postMessage: (msg: WebviewMessage) => void,
  getCurrentFilePath: () => string,
  setPendingLinkPos: (pos: number) => void,
): ComponentItem[] {
  return [
    // ── Structure ────────────────────────────────────────────────────────────
    {
      label: "/table",
      detail: "markdown table",
      section: "structure",
      apply(view, from, to) {
        const insert = "| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |";
        view.dispatch({ changes: { from, to, insert } });
      },
    },
    {
      label: "/2column",
      detail: "two-column layout",
      section: "structure",
      apply(view, from, to) {
        const insert = "<!-- 2col -->\n\n<!-- col -->\n\n<!-- /2col -->";
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(from + "<!-- 2col -->\n".length),
        });
      },
    },
    {
      label: "/divider",
      detail: "horizontal rule",
      section: "structure",
      apply(view, from, to) {
        const before = view.state.doc.lineAt(from);
        const needsLeading = before.text.trim().length > 0 && from > before.from;
        const insert = (needsLeading ? "\n" : "") + "---\n";
        view.dispatch({ changes: { from, to, insert } });
      },
    },
    {
      label: "/code",
      detail: "fenced code block",
      section: "structure",
      apply(view, from, to) {
        const insert = "```\n\n```";
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(from + 4),
        });
      },
    },
    {
      label: "/quote",
      detail: "blockquote",
      section: "structure",
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: "> " } });
      },
    },

    // ── Headings ─────────────────────────────────────────────────────────────
    {
      label: "/h1",
      detail: "Heading 1",
      section: "headings",
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: "# " } });
      },
    },
    {
      label: "/h2",
      detail: "Heading 2",
      section: "headings",
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: "## " } });
      },
    },
    {
      label: "/h3",
      detail: "Heading 3",
      section: "headings",
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: "### " } });
      },
    },

    // ── Inline ───────────────────────────────────────────────────────────────
    {
      label: "/tag",
      detail: "@tag() pill",
      section: "inline",
      apply(view, from, to) {
        const insert = "@tag()";
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(from + 5),
        });
      },
    },
    {
      label: "/link",
      detail: "file link",
      section: "inline",
      apply(view, from, to) {
        const insert = "@[]";
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(from + 2),
        });
      },
    },
    {
      label: "/date",
      detail: "today's date",
      section: "inline",
      apply(view, from, to) {
        const today = new Date().toISOString().slice(0, 10);
        view.dispatch({ changes: { from, to, insert: today } });
      },
    },
    {
      label: "/todo",
      detail: "checkbox item",
      section: "inline",
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: "- [ ] " } });
      },
    },

    // ── Pages ────────────────────────────────────────────────────────────────
    {
      label: "/page",
      detail: "new page + insert link",
      section: "pages",
      apply(view, from, to) {
        // Remove the /page text, save cursor position, ask extension to create page
        view.dispatch({
          changes: { from, to, insert: "" },
          selection: EditorSelection.cursor(from),
        });
        setPendingLinkPos(from);
        postMessage({ type: "createPageFromEditor", currentFilePath: getCurrentFilePath() });
      },
    },
  ];
}

// ── Completion source factory ─────────────────────────────────────────────────

export function createComponentMenuCompletionSource(
  postMessage: (msg: WebviewMessage) => void,
  getCurrentFilePath: () => string,
  setPendingLinkPos: (pos: number) => void,
) {
  const components = buildComponents(postMessage, getCurrentFilePath, setPendingLinkPos);

  return function componentMenuCompletionSource(
    context: CompletionContext,
  ): CompletionResult | null {
    const match = context.matchBefore(/\/\w*/);
    if (!match) return null;
    if (match.from === match.to && !context.explicit) return null;

    const query = match.text.toLowerCase();

    const options: Completion[] = components
      .filter((c) => c.label.startsWith(query))
      .map((c): Completion => ({
        label: c.label,
        detail: c.detail,
        section: c.section,
        type: "function",
        apply(view: EditorView, _completion: Completion, from: number, to: number) {
          c.apply(view, from, to);
        },
      }));

    return options.length > 0 ? { from: match.from, options } : null;
  };
}