/**
 * CM6 plugin — hides raw YAML frontmatter `---` block when cursor is outside,
 * and renders a compact properties panel widget above the document body.
 *
 * Pattern: StateField + Decoration.replace, similar to inlineStylePlugin.ts.
 */
import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect, EditorState } from "@codemirror/state";

// ── Frontmatter detection ─────────────────────────────────────────────────────

interface FrontmatterRange {
  from: number;   // start of first `---` line (inclusive)
  to: number;     // end of closing `---` line (inclusive, includes newline)
  props: Record<string, string>;
}

function detectFrontmatter(state: EditorState): FrontmatterRange | null {
  const doc = state.doc;
  const firstLine = doc.line(1);
  if (firstLine.text.trim() !== "---") return null;

  for (let lineNo = 2; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    if (line.text.trim() === "---") {
      // Parse properties from lines 2..lineNo-1
      const props: Record<string, string> = {};
      for (let i = 2; i < lineNo; i++) {
        const txt = doc.line(i).text;
        const colonIdx = txt.indexOf(":");
        if (colonIdx === -1) continue;
        const key = txt.slice(0, colonIdx).trim();
        const val = txt.slice(colonIdx + 1).trim();
        if (key) props[key] = val;
      }
      // Include the trailing newline after closing --- if present
      const toPos = line.to < doc.length ? line.to + 1 : line.to;
      return { from: firstLine.from, to: toPos, props };
    }
  }
  return null;
}

// ── Widget: rendered properties panel ────────────────────────────────────────

class FrontmatterWidget extends WidgetType {
  constructor(private readonly props: Record<string, string>) { super(); }

  eq(other: FrontmatterWidget): boolean {
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "fm-panel";
    wrap.title = "Click to edit frontmatter";

    for (const [key, val] of Object.entries(this.props)) {
      const row = document.createElement("div");
      row.className = "fm-row";

      const keyEl = document.createElement("span");
      keyEl.className = "fm-key";
      keyEl.textContent = key;

      const valEl = document.createElement("span");
      valEl.className = "fm-val";
      valEl.textContent = val;

      row.appendChild(keyEl);
      row.appendChild(valEl);
      wrap.appendChild(row);
    }

    if (Object.keys(this.props).length === 0) {
      const empty = document.createElement("span");
      empty.className = "fm-empty";
      empty.textContent = "No properties";
      wrap.appendChild(empty);
    }

    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

// ── StateField ────────────────────────────────────────────────────────────────

export const frontmatterPlugin = StateField.define<DecorationSet>({
  create(state) { return buildDecos(state); },
  update(decos, tr) {
    if (tr.docChanged || tr.selection) return buildDecos(tr.state);
    return decos;
  },
  provide(f) { return EditorView.decorations.from(f); },
});

function buildDecos(state: EditorState): DecorationSet {
  const fm = detectFrontmatter(state);
  if (!fm) return Decoration.none;

  const cursor = state.selection.main;
  const cursorInFm = cursor.from >= fm.from && cursor.to <= fm.to;

  if (cursorInFm) {
    // Cursor inside frontmatter — show raw text (no decoration)
    return Decoration.none;
  }

  // Cursor outside — replace the raw frontmatter block with a widget
  const widget = Decoration.replace({
    widget: new FrontmatterWidget(fm.props),
    inclusive: false,
    block: true,
  });

  return Decoration.set([widget.range(fm.from, fm.to)]);
}
