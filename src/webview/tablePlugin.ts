/**
 * Always-on rendered table widgets with editable cells, add/delete row & column,
 * and draggable column resize stored as:  <!-- col-widths: 40% 35% 25% -->
 */
import { StateField, EditorState, RangeSetBuilder } from "@codemirror/state";
import { DecorationSet, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// ── Types & parsing ───────────────────────────────────────────────────────────

interface ParsedTable { headers: string[]; sepCells: string[]; rows: string[][]; alignments: string[]; }

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
  return { headers, sepCells, rows: lines.slice(2).filter((l) => l.trim()).map(parseRow), alignments };
}

function reconstructTable({ headers, sepCells, rows }: ParsedTable): string {
  return [
    "| " + headers.join(" | ") + " |",
    "| " + sepCells.join(" | ") + " |",
    ...rows.map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
}

// ── Width helpers ─────────────────────────────────────────────────────────────

function parseColWidths(line: string): string[] | null {
  const m = line.match(/^<!--\s*col-widths:\s*([\d.\s%]+?)\s*-->$/);
  return m ? m[1].trim().split(/\s+/) : null;
}

function buildWidthComment(widths: number[]): string {
  return `<!-- col-widths: ${widths.map((w) => Math.round(w) + "%").join(" ")} -->`;
}

function removeColWidth(widths: number[], col: number): number[] {
  const share = widths[col] / (widths.length - 1);
  return widths.filter((_, i) => i !== col).map((w) => w + share);
}

function addColWidth(widths: number[]): number[] {
  const share = 100 / (widths.length + 1);
  return [...widths.map((w) => w * (1 - share / 100)), share];
}

function buildColgroup(widths: string[], ncols: number): { colgroup: HTMLElement; cols: HTMLTableColElement[] } {
  const colgroup = document.createElement("colgroup");
  const gutter = document.createElement("col");
  gutter.style.width = "20px";
  colgroup.appendChild(gutter);
  const pcts = widths.length === ncols ? widths.map(parseFloat) : Array(ncols).fill(100 / ncols);
  const cols: HTMLTableColElement[] = pcts.map((p) => {
    const col = document.createElement("col");
    col.style.width = p + "%";
    colgroup.appendChild(col);
    return col;
  });
  return { colgroup, cols };
}

function saveWidths(ws: number[], nodeFrom: number, commentFrom: number, commentTo: number, view: EditorView): void {
  const comment = buildWidthComment(ws);
  if (commentFrom >= 0) {
    view.dispatch({ changes: { from: commentFrom, to: commentTo, insert: comment } });
  } else {
    view.dispatch({ changes: { from: nodeFrom, to: nodeFrom, insert: comment + "\n" } });
  }
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
    document.execCommand("insertText", false, (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
  });
  return cell;
}

/** Header cell: <th class="cm-th-wrap"> wrapping an editable <div> + optional resize handle. */
function buildHeaderCell(text: string, align: string, col: number): { th: HTMLElement; content: HTMLElement } {
  const th = document.createElement("th");
  th.className = "cm-th-wrap";
  const content = document.createElement("div");
  content.className = "cm-th-content";
  content.contentEditable = "true";
  content.textContent = text;
  content.dataset.orig = text;
  content.dataset.row = "-1";
  content.dataset.col = String(col);
  content.spellcheck = false;
  if (align) content.style.textAlign = align;
  content.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
  });
  th.appendChild(content);
  return { th, content };
}

function attachCellKeys(cell: HTMLElement, onCommit: () => void): void {
  cell.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); cell.blur(); }
    if (e.key === "Escape") { cell.textContent = cell.dataset.orig ?? ""; cell.blur(); }
  });
  cell.addEventListener("blur", () => { if (!cell.dataset.dead) onCommit(); });
}

function getPendingEdit(wrap: HTMLElement, parsed: ParsedTable): ParsedTable {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || !wrap.contains(focused) || !focused.isContentEditable) return parsed;
  const r = parseInt(focused.dataset.row ?? "");
  const c = parseInt(focused.dataset.col ?? "");
  if (isNaN(r) || isNaN(c)) return parsed;
  const result = { ...parsed, headers: [...parsed.headers], rows: parsed.rows.map((row) => [...row]) };
  const text = focused.textContent?.trim() ?? "";
  if (r === -1) result.headers[c] = text;
  else if (result.rows[r]) result.rows[r][c] = text;
  return result;
}

function makeDelBtn(title: string, onDel: () => void): HTMLElement {
  const btn = document.createElement("span");
  btn.className = "cm-table-del-btn";
  btn.textContent = "×";
  btn.title = title;
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); onDel(); });
  return btn;
}

// ── Column resize ─────────────────────────────────────────────────────────────

let cleanupDrag: (() => void) | null = null;

function startResize(
  e: MouseEvent, col: number, colEls: HTMLTableColElement[], initW: number[],
  tableEl: HTMLElement, onEnd: (ws: number[]) => void, handle: HTMLElement,
): void {
  e.preventDefault();
  if (cleanupDrag) cleanupDrag();
  const startX = e.clientX;
  handle.classList.add("active");

  function onMove(ev: MouseEvent): void {
    const tw = tableEl.offsetWidth;
    if (!tw) return;
    const d = ((ev.clientX - startX) / tw) * 100;
    colEls[col].style.width = Math.max(5, initW[col] + d) + "%";
    colEls[col + 1].style.width = Math.max(5, initW[col + 1] - d) + "%";
  }

  function onUp(): void {
    cleanup();
    onEnd(colEls.map((c) => parseFloat(c.style.width || "0")));
  }

  function cleanup(): void {
    handle.classList.remove("active");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    cleanupDrag = null;
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  cleanupDrag = cleanup;
}

function attachResizeHandle(
  th: HTMLElement, col: number, cols: HTMLTableColElement[], initW: number[],
  wrap: HTMLElement, nodeFrom: number, commentFrom: number, commentTo: number, view: EditorView,
): void {
  const handle = document.createElement("div");
  handle.className = "cm-col-resize";
  th.appendChild(handle);
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startResize(e, col, cols, [...initW], wrap.querySelector("table") as HTMLElement,
      (ws) => saveWidths(ws, nodeFrom, commentFrom, commentTo, view), handle);
  });
}

// ── Table section builders ────────────────────────────────────────────────────

function buildColDelRow(
  parsed: ParsedTable, from: number, to: number,
  commentFrom: number, commentTo: number, widths: string[],
  view: EditorView, wrap: HTMLElement,
): { tr: HTMLTableRowElement; colDelThs: HTMLElement[] } {
  const tr = document.createElement("tr");
  tr.className = "cm-col-del-row";
  tr.appendChild(document.createElement("th"));
  const colDelThs: HTMLElement[] = [];
  parsed.headers.forEach((_, col) => {
    const th = document.createElement("th");
    th.appendChild(makeDelBtn("Delete column", () => {
      const cur = getPendingEdit(wrap, parsed);
      const newParsed = {
        headers: cur.headers.filter((_, i) => i !== col),
        sepCells: cur.sepCells.filter((_, i) => i !== col),
        rows: cur.rows.map((r) => r.filter((_, i) => i !== col)),
        alignments: cur.alignments.filter((_, i) => i !== col),
      };
      const ws = widths.length === parsed.headers.length ? removeColWidth(widths.map(parseFloat), col) : null;
      const changes: object[] = ws && commentFrom >= 0
        ? [{ from: commentFrom, to: commentTo, insert: buildWidthComment(ws) }, { from, to, insert: reconstructTable(newParsed) }]
        : [{ from, to, insert: reconstructTable(newParsed) }];
      view.dispatch({ changes });
    }));
    th.addEventListener("mouseenter", () => th.classList.add("cm-col-hovered"));
    th.addEventListener("mouseleave", () => th.classList.remove("cm-col-hovered"));
    tr.appendChild(th);
    colDelThs.push(th);
  });
  return { tr, colDelThs };
}

function buildHead(
  parsed: ParsedTable, from: number, to: number,
  nodeFrom: number, commentFrom: number, commentTo: number,
  widths: string[], view: EditorView, wrap: HTMLElement,
  cols: HTMLTableColElement[], colDelTr: HTMLTableRowElement, colDelThs: HTMLElement[],
): HTMLTableSectionElement {
  const { headers, alignments } = parsed;
  const thead = document.createElement("thead");
  thead.appendChild(colDelTr);
  const tr = document.createElement("tr");
  tr.appendChild(document.createElement("th")); // gutter spacer
  const initW = cols.map((c) => parseFloat(c.style.width) || 100 / headers.length);
  headers.forEach((text, col) => {
    const { th, content } = buildHeaderCell(text, alignments[col] ?? "left", col);
    attachCellKeys(content, () => {
      const updated = { ...parsed, headers: headers.map((h, i) => (i === col ? content.textContent?.trim() ?? h : h)) };
      view.dispatch({ changes: { from, to, insert: reconstructTable(updated) } });
    });
    th.addEventListener("mouseenter", () => colDelThs[col]?.classList.add("cm-col-hovered"));
    th.addEventListener("mouseleave", (e) => {
      if (e.relatedTarget instanceof Element && colDelThs[col]?.contains(e.relatedTarget)) return;
      colDelThs[col]?.classList.remove("cm-col-hovered");
    });
    if (col < headers.length - 1) attachResizeHandle(th, col, cols, initW, wrap, nodeFrom, commentFrom, commentTo, view);
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  return thead;
}

function buildBody(parsed: ParsedTable, from: number, to: number, view: EditorView, wrap: HTMLElement, colDelThs: HTMLElement[]): HTMLTableSectionElement {
  const { rows, alignments } = parsed;
  const tbody = document.createElement("tbody");
  rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");
    const delCell = document.createElement("td");
    delCell.className = "cm-row-del-cell";
    delCell.appendChild(makeDelBtn("Delete row", () => {
      const cur = getPendingEdit(wrap, parsed);
      view.dispatch({ changes: { from, to, insert: reconstructTable({ ...cur, rows: cur.rows.filter((_, i) => i !== rowIdx) }) } });
    }));
    tr.appendChild(delCell);
    row.forEach((text, col) => {
      const td = makeCell("td", text, alignments[col] ?? "left", rowIdx, col);
      attachCellKeys(td, () => {
        const nr = rows.map((r, ri) => ri === rowIdx ? r.map((c, ci) => (ci === col ? td.textContent?.trim() ?? c : c)) : r);
        view.dispatch({ changes: { from, to, insert: reconstructTable({ ...parsed, rows: nr }) } });
      });
      td.addEventListener("mouseenter", () => colDelThs[col]?.classList.add("cm-col-hovered"));
      td.addEventListener("mouseleave", (e) => {
        if (e.relatedTarget instanceof Element && colDelThs[col]?.contains(e.relatedTarget)) return;
        colDelThs[col]?.classList.remove("cm-col-hovered");
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
  td.colSpan = parsed.headers.length + 1;
  td.className = "cm-table-add-row";
  td.textContent = "+";
  td.title = "Add row";
  td.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const cur = getPendingEdit(wrap, parsed);
    view.dispatch({ changes: { from, to, insert: reconstructTable({ ...cur, rows: [...cur.rows, Array(cur.headers.length).fill("")] }) } });
  });
  tr.appendChild(td);
  tfoot.appendChild(tr);
  return tfoot;
}

function buildAddColBtn(
  parsed: ParsedTable, from: number, to: number,
  commentFrom: number, commentTo: number, widths: string[],
  view: EditorView, wrap: HTMLElement,
): HTMLElement {
  const btn = document.createElement("div");
  btn.className = "cm-table-add-col";
  btn.textContent = "+";
  btn.title = "Add column";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const cur = getPendingEdit(wrap, parsed);
    const newParsed = { ...cur, headers: [...cur.headers, ""], sepCells: [...cur.sepCells, "---"],
      rows: cur.rows.map((r) => [...r, ""]), alignments: [...cur.alignments, "left"] };
    const ws = widths.length === parsed.headers.length ? addColWidth(widths.map(parseFloat)) : null;
    const changes: object[] = ws && commentFrom >= 0
      ? [{ from: commentFrom, to: commentTo, insert: buildWidthComment(ws) }, { from, to, insert: reconstructTable(newParsed) }]
      : [{ from, to, insert: reconstructTable(newParsed) }];
    view.dispatch({ changes });
  });
  return btn;
}

// ── Widget ────────────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(
    readonly src: string, readonly docFrom: number, readonly docTo: number,
    readonly widths: string[], readonly commentFrom: number, readonly commentTo: number,
  ) { super(); }

  eq(other: TableWidget): boolean {
    return other.src === this.src && other.docFrom === this.docFrom && other.widths.join() === this.widths.join();
  }

  destroy(dom: HTMLElement): void {
    cleanupDrag?.(); cleanupDrag = null;
    dom.querySelectorAll<HTMLElement>("[contenteditable]").forEach((c) => { c.dataset.dead = "1"; });
  }

  toDOM(view: EditorView): HTMLElement {
    const parsed = parseTable(this.src);
    const { docFrom: nodeFrom, docTo: nodeTo, widths, commentFrom, commentTo } = this;
    const from = nodeFrom, to = nodeTo;

    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const scroll = document.createElement("div");
    scroll.className = "cm-table-scroll";

    const { colgroup, cols } = buildColgroup(widths, parsed.headers.length);
    const { tr: colDelTr, colDelThs } = buildColDelRow(parsed, from, to, commentFrom, commentTo, widths, view, wrap);
    const table = document.createElement("table");
    table.className = "cm-table-widget";
    table.appendChild(colgroup);
    table.appendChild(buildHead(parsed, from, to, nodeFrom, commentFrom, commentTo, widths, view, wrap, cols, colDelTr, colDelThs));
    table.appendChild(buildBody(parsed, from, to, view, wrap, colDelThs));
    table.appendChild(buildFoot(parsed, from, to, view, wrap));

    scroll.appendChild(table);
    wrap.appendChild(scroll);
    wrap.appendChild(buildAddColBtn(parsed, from, to, commentFrom, commentTo, widths, view, wrap));
    return wrap;
  }

  ignoreEvent(): boolean { return true; }
}

// ── Decoration builder & StateField ──────────────────────────────────────────

function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const tableLine = state.doc.lineAt(node.from);
      let lineFrom = tableLine.from;
      let widths: string[] = [];
      let commentFrom = -1, commentTo = -1;
      if (tableLine.number > 1) {
        const prev = state.doc.line(tableLine.number - 1);
        const parsed = parseColWidths(prev.text);
        if (parsed) {
          widths = parsed;
          lineFrom = prev.from;
          commentFrom = prev.from;
          commentTo = prev.to;
        }
      }
      const lineTo = state.doc.lineAt(node.to).to;
      const src = state.doc.sliceString(node.from, node.to);
      builder.add(lineFrom, lineTo, Decoration.replace({
        widget: new TableWidget(src, node.from, node.to, widths, commentFrom, commentTo),
        block: true,
      }));
    },
  });
  return builder.finish();
}

export const tablePlugin = StateField.define<DecorationSet>({
  create(state) { return buildTableDecorations(state); },
  update(deco, tr) { return tr.docChanged ? buildTableDecorations(tr.state) : deco.map(tr.changes); },
  provide(field) { return EditorView.decorations.from(field); },
});
