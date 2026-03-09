/**
 * Hides **bold** and *italic* markers when the cursor is not inside the span.
 * The text between markers is already styled by the markdown language extension
 * via tok-strong / tok-emphasis. This plugin just suppresses the raw markers.
 *
 * Also exports Ctrl+B / Ctrl+I command handlers.
 */
import {
  ViewPlugin, DecorationSet, Decoration, EditorView, ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Priority: bold (**) before italic (*) so **text** doesn't get half-matched as italic.
const INLINE_PATTERN = /(\*\*([^*\n]+)\*\*)|\*([^*\n]+)\*/g;

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from: curFrom, to: curTo } = view.state.selection.main;
  // One regex instance per call; reset lastIndex per line rather than allocating per line.
  const re = new RegExp(INLINE_PATTERN.source, "g");

  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    let pos = rangeFrom;
    while (pos <= rangeTo) {
      const line = view.state.doc.lineAt(pos);
      re.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = re.exec(line.text)) !== null) {
        const mFrom = line.from + match.index;
        const mTo   = mFrom + match[0].length;
        const isBold = match[1] !== undefined;
        const markerLen = isBold ? 2 : 1;

        const cursorInside = curFrom <= mTo && curTo >= mFrom;
        if (cursorInside) continue;

        // Hide opening marker
        builder.add(mFrom, mFrom + markerLen, Decoration.replace({}));
        // Hide closing marker
        builder.add(mTo - markerLen, mTo, Decoration.replace({}));
      }

      if (line.to >= rangeTo) break;
      pos = line.to + 1;
    }
  }

  return builder.finish();
}

export const inlineStylePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Ctrl+B / Ctrl+I commands ──────────────────────────────────────────────────

function toggleMarker(marker: string) {
  return (view: EditorView): boolean => {
    const { from, to } = view.state.selection.main;
    const mLen = marker.length;
    const doc  = view.state.doc;

    if (from === to) {
      // No selection — insert paired markers and place cursor between them
      view.dispatch({
        changes: { from, insert: marker + marker },
        selection: { anchor: from + mLen },
      });
      return true;
    }

    // Check if the selection is already wrapped
    const before = from >= mLen ? doc.sliceString(from - mLen, from) : "";
    const after  = to + mLen <= doc.length ? doc.sliceString(to, to + mLen) : "";

    if (before === marker && after === marker) {
      // Unwrap: remove the surrounding markers
      view.dispatch({
        changes: [
          { from: from - mLen, to: from, insert: "" },
          { from: to,          to: to + mLen, insert: "" },
        ],
        selection: { anchor: from - mLen, head: to - mLen },
      });
    } else {
      // Wrap: add markers around the selection
      view.dispatch({
        changes: [
          { from,  insert: marker },
          { from: to, insert: marker },
        ],
        selection: { anchor: from + mLen, head: to + mLen },
      });
    }
    return true;
  };
}

export const boldCommand  = toggleMarker("**");
export const italicCommand = toggleMarker("*");
