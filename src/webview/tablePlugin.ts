/**
 * Always-on rendered table widgets with editable cells.
 * Hover shows +row / +col buttons. Focus highlight is subtle.
 */
import { StateField, EditorState, RangeSetBuilder } from "@codemirror/state";
import { DecorationSet, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// ── Types & parsing ───────────────────────────────────────────────────────────

interface ParsedTable {
  headers: string[];
  sepCells: string[];
  rows: string[][];
  alignments: string[];
}

function parseRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
}

function parseTable(src: string): ParsedTable {
  const lines = src.split("\n").filter((l) => l.trim());
  const headers = parseRow(lines[0] ?? "");
  const sepCells = parseRow(lines[1] ?? "");
  const alignments = sepCells.map((s) => {
    if (s.startsWith(":") && s.endsWith(":")) return "center";
    if (s.endsWith(":")) return "right";
    return "left";
  });
  const rows = lines.slice(2).filter((l) => l.trim()).map(parseRow);
  return { headers, sepCells, rows, alignments };
}

function reconstructTable({ headers, sepCells, rows }: ParsedTable): string {
  return [
    "| " + headers.join(" | ") + " |",
    "| " + sepCells.join(" | ") + " |",
    ...rows.map((row) => "| " + row.join(" | ") + " |"),
  ].join("\n");
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

function makeCell(tag: "th" | "td", text: string, align: string, row: number, col: number): HTMLElement {
  const cell = document.createElement(tag);
  cell.contentEditable = "true";
  cell.textContent = text;
  cell.dataset.orig = text;
  cell.dataset.row = String(row);
  cell.dataset.col = String(col);
  cell.spellcheck = false;
  if (align) cell.style.textAlign = align;
  cell.addEventListener("paste", (e) => {
    e.preventDefault();
    const plain = (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, plain);
  });
  return cell;
}

function attachCellKeys(cell: HTMLElement, onCommit: () => void): void {
  cell.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); cell.blur(); }
    if (e.key === "Escape") { cell.textContent = cell.dataset.orig ?? ""; cell.blur(); }
  });
  cell.addEventListener("blur", () => {
    if (cell.dataset.dead) return; // widget was replaced mid-edit
    onCommit();
  });
}

/** Read any in-progress cell edit from the DOM into the parsed table. */
function getPendingEdit(wrap: HTMLElement, parsed: ParsedTable): ParsedTable {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || !wrap.contains(focused) || !focused.isContentEditable) return parsed;
  const r = parseInt(focused.dataset.row ?? "");
  const c = parseInt(focused.dataset.col ?? "");
  if (isNaN(r) || isNaN(c)) return parsed;
  const result = { ...parsed, headers: [...parsed.headers], rows: parsed.rows.map((row) => [...row]) };
  const text = focused.textContent?.trim() ?? "";
  if (r === -1) { result.headers[c] = text; }
  else if (result.rows[r]) { result.rows[r][c] = text; }
  return result;
}

// ── Table section builders ────────────────────────────────────────────────────

function buildHead(parsed: ParsedTable, from: number, to: number, view: EditorView, wrap: HTMLElement): HTMLTableSectionElement {
  const { headers, alignments } = parsed;
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  headers.forEach((text, col) => {
    const th = makeCell("th", text, alignments[col] ?? "left", -1, col);
    attachCellKeys(th, () => {
      const updated = { ...parsed, headers: headers.map((h, i) => (i === col ? th.textContent?.trim() ?? h : h)) };
      view.dispatch({ changes: { from, to, insert: reconstructTable(updated) } });
    });
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  return thead;
}

function buildBody(parsed: ParsedTable, from: number, to: number, view: EditorView, wrap: HTMLElement): HTMLTableSectionElement {
  const { rows, alignments } = parsed;
  const tbody = document.createElement("tbody");
  rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");
    row.forEach((text, col) => {
      const td = makeCell("td", text, alignments[col] ?? "left", rowIdx, col);
      attachCellKeys(td, () => {
        const newRows = rows.map((r, ri) => ri === rowIdx ? r.map((c, ci) => (ci === col ? td.textContent?.trim() ?? c : c)) : r);
        view.dispatch({ changes: { from, to, insert: reconstructTable({ ...parsed, rows: newRows }) } });
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  return tbody;
}

function buildFoot(parsed: ParsedTable, from: number, to: number, view: EditorView, wrap: HTMLElement): HTMLTableSectionElement {
  const tfoot = document.createElement("tfoot");
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = parsed.headers.length;
  td.className = "cm-table-add-row";
  td.textContent = "+";
  td.title = "Add row";
  td.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const current = getPendingEdit(wrap, parsed);
    const newRows = [...current.rows, new Array(current.headers.length).fill("")];
    view.dispatch({ changes: { from, to, insert: reconstructTable({ ...current, rows: newRows }) } });
  });
  tr.appendChild(td);
  tfoot.appendChild(tr);
  return tfoot;
}

function buildAddColBtn(parsed: ParsedTable, from: number, to: number, view: EditorView, wrap: HTMLElement): HTMLElement {
  const btn = document.createElement("div");
  btn.className = "cm-table-add-col";
  btn.textContent = "+";
  btn.title = "Add column";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const current = getPendingEdit(wrap, parsed);
    const updated: ParsedTable = {
      ...current,
      headers: [...current.headers, ""],
      sepCells: [...current.sepCells, "---"],
      rows: current.rows.map((r) => [...r, ""]),
      alignments: [...current.alignments, "left"],
    };
    view.dispatch({ changes: { from, to, insert: reconstructTable(updated) } });
  });
  return btn;
}

// ── Widget ────────────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(readonly src: string, readonly docFrom: number, readonly docTo: number) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.src === this.src && other.docFrom === this.docFrom;
  }

  destroy(dom: HTMLElement): void {
    dom.querySelectorAll<HTMLElement>("[contenteditable]").forEach((cell) => {
      cell.dataset.dead = "1";
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const parsed = parseTable(this.src);
    const { docFrom: from, docTo: to } = this;

    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";

    const scroll = document.createElement("div");
    scroll.className = "cm-table-scroll";

    const table = document.createElement("table");
    table.className = "cm-table-widget";
    table.appendChild(buildHead(parsed, from, to, view, wrap));
    table.appendChild(buildBody(parsed, from, to, view, wrap));
    table.appendChild(buildFoot(parsed, from, to, view, wrap));

    scroll.appendChild(table);
    wrap.appendChild(scroll);
    wrap.appendChild(buildAddColBtn(parsed, from, to, view, wrap));
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ── Decoration builder & StateField ──────────────────────────────────────────

function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const lineFrom = state.doc.lineAt(node.from).from;
      const lineTo = state.doc.lineAt(node.to).to;
      const src = state.doc.sliceString(node.from, node.to);
      builder.add(lineFrom, lineTo, Decoration.replace({
        widget: new TableWidget(src, node.from, node.to),
        block: true,
      }));
    },
  });
  return builder.finish();
}

export const tablePlugin = StateField.define<DecorationSet>({
  create(state) { return buildTableDecorations(state); },
  update(decorations, tr) {
    if (tr.docChanged) return buildTableDecorations(tr.state);
    return decorations.map(tr.changes);
  },
  provide(field) { return EditorView.decorations.from(field); },
});
