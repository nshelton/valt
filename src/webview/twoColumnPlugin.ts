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
 * Each column is a full nested CodeMirror 6 editor, so all rich content
 * (headings, tables, decorators, images, bold/italic, etc.) renders and
 * edits identically to the main document.
 *
 * Content is serialized back to the parent document on focus-out,
 * avoiding circular-update complexity.
 */
import { StateField, EditorState, RangeSetBuilder, Extension } from "@codemirror/state";
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

// ── Nested editor lifecycle ──────────────────────────────────────────────────

interface ColumnEditors {
  left: EditorView;
  right: EditorView;
}

const editorRegistry = new WeakMap<HTMLElement, ColumnEditors>();

// ── Widget ────────────────────────────────────────────────────────────────────

class TwoColumnWidget extends WidgetType {
  constructor(
    readonly left: string,
    readonly right: string,
    readonly docFrom: number,
    readonly docTo: number,
    private readonly getExtensions: () => Extension[],
  ) { super(); }

  eq(other: TwoColumnWidget): boolean {
    return other.left === this.left && other.right === this.right;
  }

  toDOM(parentView: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-twocol-wrap";

    const makeCol = (content: string): { col: HTMLDivElement; editor: EditorView } => {
      const col = document.createElement("div");
      col.className = "cm-twocol-col";
      const editor = new EditorView({
        doc: content,
        parent: col,
        extensions: this.getExtensions(),
      });
      return { col, editor };
    };

    const { col: leftCol, editor: leftEditor }  = makeCol(this.left);
    const { col: rightCol, editor: rightEditor } = makeCol(this.right);

    editorRegistry.set(wrap, { left: leftEditor, right: rightEditor });

    // Commit when focus leaves the entire widget
    const commit = (): void => {
      if (!wrap.isConnected) return; // widget was removed (e.g. delete button)
      const l = leftEditor.state.doc.toString();
      const r = rightEditor.state.doc.toString();
      if (l === this.left && r === this.right) return; // nothing changed
      parentView.dispatch({
        changes: { from: this.docFrom, to: this.docTo, insert: serialize(l, r) },
      });
    };

    wrap.addEventListener("focusout", (e: FocusEvent) => {
      if (!wrap.isConnected) return;
      const related = e.relatedTarget as Node | null;
      if (related && wrap.contains(related)) return; // focus moved within widget
      commit();
    });

    // Delete button — restores content as plain text
    const delBtn = document.createElement("button");
    delBtn.className = "cm-twocol-del";
    delBtn.textContent = "×";
    delBtn.title = "Delete column layout";
    delBtn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent focus shift before dispatch
      const l = leftEditor.state.doc.toString().trim();
      const r = rightEditor.state.doc.toString().trim();
      const restored = [l, r].filter(Boolean).join("\n\n");
      parentView.dispatch({
        changes: { from: this.docFrom, to: this.docTo, insert: restored },
      });
    });

    wrap.appendChild(delBtn);
    wrap.appendChild(leftCol);
    wrap.appendChild(rightCol);

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const editors = editorRegistry.get(dom);
    if (editors) {
      editors.left.destroy();
      editors.right.destroy();
      editorRegistry.delete(dom);
    }
  }

  ignoreEvent(): boolean { return true; }
}

// ── StateField ────────────────────────────────────────────────────────────────

function buildDecorations(state: EditorState, getExts: () => Extension[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of parseTwoColBlocks(state)) {
    builder.add(block.from, block.to, Decoration.replace({
      widget: new TwoColumnWidget(block.left, block.right, block.from, block.to, getExts),
      block: true,
    }));
  }
  return builder.finish();
}

export function createTwoColumnPlugin(getExtensions: () => Extension[]): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state)  { return buildDecorations(state, getExtensions); },
    update(deco, tr) {
      return tr.docChanged ? buildDecorations(tr.state, getExtensions) : deco.map(tr.changes);
    },
    provide(field) { return EditorView.decorations.from(field); },
  });
}
