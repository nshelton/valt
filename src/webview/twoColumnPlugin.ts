/**
 * Two-column layout plugin.
 *
 * Storage format in markdown:
 *   <!-- 2col -->
 *   Left column content (multiline)
 *   <!-- col -->
 *   Right column content (multiline)
 *   <!-- /2col -->
 *
 * Rendered as a side-by-side widget with two contentEditable panes.
 * A × delete button in the top-right removes the block, restoring content as plain text.
 */
import { StateField, EditorState, RangeSetBuilder } from "@codemirror/state";
import { DecorationSet, Decoration, WidgetType, EditorView } from "@codemirror/view";

const OPEN_TAG  = "<!-- 2col -->";
const SEP_TAG   = "<!-- col -->";
const CLOSE_TAG = "<!-- /2col -->";

interface TwoColBlock {
  from: number;
  to: number;
  left: string;
  right: string;
}

function parseTwoColBlocks(state: EditorState): TwoColBlock[] {
  const text = state.doc.toString();
  const blocks: TwoColBlock[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = text.indexOf(OPEN_TAG, searchFrom);
    if (openIdx === -1) break;
    const closeIdx = text.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length);
    if (closeIdx === -1) break;

    const inner = text.slice(openIdx + OPEN_TAG.length, closeIdx);
    const sepIdx = inner.indexOf(SEP_TAG);

    const left  = sepIdx === -1 ? inner.trim() : inner.slice(0, sepIdx).trim();
    const right = sepIdx === -1 ? ""            : inner.slice(sepIdx + SEP_TAG.length).trim();

    blocks.push({ from: openIdx, to: closeIdx + CLOSE_TAG.length, left, right });
    searchFrom = closeIdx + CLOSE_TAG.length;
  }

  return blocks;
}

function serialize(left: string, right: string): string {
  return `${OPEN_TAG}\n${left}\n${SEP_TAG}\n${right}\n${CLOSE_TAG}`;
}

// ── Widget ────────────────────────────────────────────────────────────────────

class TwoColumnWidget extends WidgetType {
  constructor(
    readonly left: string,
    readonly right: string,
    readonly docFrom: number,
    readonly docTo: number,
  ) { super(); }

  eq(other: TwoColumnWidget): boolean {
    return other.left === this.left && other.right === this.right && other.docFrom === this.docFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-twocol-wrap";

    const makeCol = (initial: string): HTMLDivElement => {
      const col = document.createElement("div");
      col.className = "cm-twocol-col";
      col.contentEditable = "true";
      col.textContent = initial;
      col.spellcheck = false;
      col.addEventListener("keydown", (e) => e.stopPropagation());
      col.addEventListener("paste", (e) => {
        e.preventDefault();
        document.execCommand("insertText", false, (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
      });
      return col;
    };

    const leftCol  = makeCol(this.left);
    const rightCol = makeCol(this.right);

    const commit = (): void => {
      const l = leftCol.textContent?.trim()  ?? "";
      const r = rightCol.textContent?.trim() ?? "";
      view.dispatch({ changes: { from: this.docFrom, to: this.docTo, insert: serialize(l, r) } });
    };

    leftCol.addEventListener("blur",  commit);
    rightCol.addEventListener("blur", commit);

    // Delete button — restores content as plain text (or removes empty blocks)
    const delBtn = document.createElement("button");
    delBtn.className = "cm-twocol-del";
    delBtn.textContent = "×";
    delBtn.title = "Delete column layout";
    delBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const l = leftCol.textContent?.trim()  ?? "";
      const r = rightCol.textContent?.trim() ?? "";
      const restored = [l, r].filter(Boolean).join("\n\n");
      view.dispatch({ changes: { from: this.docFrom, to: this.docTo, insert: restored } });
    });

    wrap.appendChild(delBtn);
    wrap.appendChild(leftCol);
    wrap.appendChild(rightCol);

    return wrap;
  }

  ignoreEvent(): boolean { return true; }
}

// ── StateField ────────────────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of parseTwoColBlocks(state)) {
    builder.add(block.from, block.to, Decoration.replace({
      widget: new TwoColumnWidget(block.left, block.right, block.from, block.to),
      block: true,
    }));
  }
  return builder.finish();
}

export const twoColumnPlugin = StateField.define<DecorationSet>({
  create(state)  { return buildDecorations(state); },
  update(deco, tr) { return tr.docChanged ? buildDecorations(tr.state) : deco.map(tr.changes); },
  provide(field) { return EditorView.decorations.from(field); },
});
