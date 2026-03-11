/**
 * Database table view — vanilla HTML/CSS renderer for .valtdb.json databases.
 * Follows the dark theme in style.css. No framework.
 */
import type {
  DatabaseSchema,
  DatabaseRow,
  ColumnDef,
  ColumnType,
  WebviewMessage,
} from "../shared/messages";

// ── Type icons ────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<ColumnType, string> = {
  text: "T",
  number: "#",
  select: "◉",
  "multi-select": "◈",
  date: "📅",
  checkbox: "✓",
  relation: "↗",
  url: "🔗",
};

// ── Escaping ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

// ── Cell rendering ────────────────────────────────────────────────────────────

function renderCellDisplay(col: ColumnDef, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";

  switch (col.type) {
    case "checkbox":
      return `<span class="db-checkbox-display">${value ? "✓" : ""}</span>`;
    case "select":
      return `<span class="db-select-chip">${esc(String(value))}</span>`;
    case "multi-select": {
      const vals = Array.isArray(value) ? value : [value];
      return vals.map((v) => `<span class="db-select-chip">${esc(String(v))}</span>`).join(" ");
    }
    case "url":
      return `<span class="db-url">${esc(String(value))}</span>`;
    default:
      return esc(String(value));
  }
}

// ── Database view ─────────────────────────────────────────────────────────────

export interface DatabaseViewCallbacks {
  postMessage: (msg: WebviewMessage) => void;
  onOpenRow: (fsPath: string) => void;
}

export class DatabaseView {
  private folderPath = "";
  private schema: DatabaseSchema | null = null;
  private rows: DatabaseRow[] = [];
  private sortColId: string | null = null;
  private sortDir: "asc" | "desc" = "asc";
  private container: HTMLElement;
  private callbacks: DatabaseViewCallbacks;

  constructor(container: HTMLElement, callbacks: DatabaseViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
  }

  load(folderPath: string, schema: DatabaseSchema, rows: DatabaseRow[]): void {
    this.folderPath = folderPath;
    this.schema = schema;
    this.rows = rows;
    this.sortColId = null;
    this.sortDir = "asc";
    this.render();
  }

  updateSchema(folderPath: string, schema: DatabaseSchema): void {
    if (this.folderPath !== folderPath) return;
    this.schema = schema;
    this.render();
  }

  private getSortedRows(): DatabaseRow[] {
    if (!this.sortColId) return this.rows;
    const colId = this.sortColId;
    const dir = this.sortDir;
    return [...this.rows].sort((a, b) => {
      const va = String(a.properties[colId] ?? "");
      const vb = String(b.properties[colId] ?? "");
      const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
      return dir === "asc" ? cmp : -cmp;
    });
  }

  private render(): void {
    if (!this.schema) return;
    const cols = this.schema.columns;
    const rows = this.getSortedRows();

    const headerCells = cols.map((col) => {
      const icon = TYPE_ICONS[col.type] ?? "T";
      const sortMark =
        this.sortColId === col.id
          ? this.sortDir === "asc"
            ? " ▲"
            : " ▼"
          : "";
      return `<th class="db-th" data-col-id="${escAttr(col.id)}">
        <span class="db-col-icon">${icon}</span>
        ${esc(col.name)}${sortMark}
        <button class="db-col-delete" data-col-id="${escAttr(col.id)}" title="Delete column">×</button>
      </th>`;
    }).join("");

    const bodyRows = rows.map((row) => {
      const propCells = cols.map((col) => {
        const val = row.properties[col.id];
        const display = renderCellDisplay(col, val);
        return `<td class="db-td" data-row-path="${escAttr(row.fsPath)}" data-col-id="${escAttr(col.id)}" data-col-type="${col.type}">
          <div class="db-cell-inner">${display}</div>
        </td>`;
      }).join("");

      const emoji = row.emoji ? `${row.emoji} ` : "";
      return `<tr class="db-row" data-row-path="${escAttr(row.fsPath)}">
        <td class="db-td db-td-title">
          <span class="db-row-title" data-row-path="${escAttr(row.fsPath)}">${emoji}${esc(row.title)}</span>
          <button class="db-row-delete" data-row-path="${escAttr(row.fsPath)}" title="Delete row">×</button>
        </td>
        ${propCells}
      </tr>`;
    }).join("");

    const dbName = this.folderPath.split("/").pop()?.replace(/^[0-9a-f]{8}\s+/, "") ?? "Database";

    this.container.innerHTML = `
      <div class="db-view">
        <div class="db-header">
          <h2 class="db-title">🗃 ${esc(dbName)}</h2>
        </div>
        <div class="db-table-wrap">
          <table class="db-table">
            <thead>
              <tr>
                <th class="db-th db-th-title">Title</th>
                ${headerCells}
                <th class="db-th db-th-add-col">
                  <button class="db-add-col-btn" title="Add column">+ Add Column</button>
                </th>
              </tr>
            </thead>
            <tbody>
              ${bodyRows}
            </tbody>
          </table>
        </div>
        <div class="db-footer">
          <button class="db-add-row-btn">+ New Row</button>
        </div>
      </div>
    `;

    this.wireEvents();
  }

  private wireEvents(): void {
    // Sort by column header click
    this.container.querySelectorAll<HTMLElement>(".db-th[data-col-id]").forEach((th) => {
      th.addEventListener("click", (e) => {
        // Don't sort when clicking the delete button
        if ((e.target as HTMLElement).classList.contains("db-col-delete")) return;
        const colId = th.dataset.colId!;
        if (this.sortColId === colId) {
          this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
        } else {
          this.sortColId = colId;
          this.sortDir = "asc";
        }
        this.render();
      });
    });

    // Delete column
    this.container.querySelectorAll<HTMLElement>(".db-col-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colId = btn.dataset.colId!;
        if (!this.schema) return;
        this.schema = {
          ...this.schema,
          columns: this.schema.columns.filter((c) => c.id !== colId),
        };
        this.callbacks.postMessage({
          type: "saveDatabaseSchema",
          folderPath: this.folderPath,
          schema: this.schema,
        });
        this.render();
      });
    });

    // Row title click → open page
    this.container.querySelectorAll<HTMLElement>(".db-row-title").forEach((el) => {
      el.addEventListener("click", () => {
        const rowPath = el.dataset.rowPath!;
        this.callbacks.onOpenRow(rowPath);
      });
    });

    // Delete row
    this.container.querySelectorAll<HTMLElement>(".db-row-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rowPath = btn.dataset.rowPath!;
        this.callbacks.postMessage({ type: "deleteDatabaseRow", rowPath });
      });
    });

    // Cell editing
    this.container.querySelectorAll<HTMLElement>(".db-td[data-col-id]").forEach((td) => {
      if (td.classList.contains("db-td-title")) return;
      td.addEventListener("click", () => this.startCellEdit(td));
    });

    // Add column button
    this.container.querySelector(".db-add-col-btn")?.addEventListener("click", () => {
      this.showAddColumnDialog();
    });

    // Add row button
    this.container.querySelector(".db-add-row-btn")?.addEventListener("click", () => {
      if (!this.schema) return;
      const props: Record<string, unknown> = {};
      for (const col of this.schema.columns) props[col.id] = null;
      this.callbacks.postMessage({
        type: "createDatabaseRow",
        folderPath: this.folderPath,
        title: "New Row",
        properties: props,
      });
    });
  }

  private startCellEdit(td: HTMLElement): void {
    if (td.querySelector("input, select")) return; // already editing

    const rowPath = td.dataset.rowPath!;
    const colId = td.dataset.colId!;
    const colType = td.dataset.colType as ColumnType;
    const col = this.schema?.columns.find((c) => c.id === colId);
    if (!col) return;

    const row = this.rows.find((r) => r.fsPath === rowPath);
    const currentVal = row?.properties[colId];
    const cell = td.querySelector(".db-cell-inner")!;
    const originalHTML = cell.innerHTML;

    const commit = (val: unknown) => {
      if (row) row.properties[colId] = val;
      cell.innerHTML = renderCellDisplay(col, val);
      this.callbacks.postMessage({ type: "saveRowProperty", rowPath, colId, value: val });
    };

    const cancel = () => {
      cell.innerHTML = originalHTML;
    };

    if (colType === "checkbox") {
      commit(!(currentVal));
      return;
    }

    if (colType === "select" && col.options?.length) {
      const sel = document.createElement("select");
      sel.className = "db-cell-select";
      sel.innerHTML = `<option value="">—</option>` +
        col.options.map((o) => `<option value="${escAttr(o)}"${o === currentVal ? " selected" : ""}>${esc(o)}</option>`).join("");
      cell.innerHTML = "";
      cell.appendChild(sel);
      sel.focus();
      sel.addEventListener("change", () => { commit(sel.value || null); });
      sel.addEventListener("blur", () => { commit(sel.value || null); });
      sel.addEventListener("keydown", (e) => { if (e.key === "Escape") cancel(); });
      return;
    }

    if (colType === "date") {
      const inp = document.createElement("input");
      inp.type = "date";
      inp.className = "db-cell-input";
      inp.value = String(currentVal ?? "");
      cell.innerHTML = "";
      cell.appendChild(inp);
      inp.focus();
      inp.addEventListener("blur", () => commit(inp.value || null));
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { inp.blur(); }
        else if (e.key === "Escape") cancel();
      });
      return;
    }

    if (colType === "number") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "db-cell-input";
      inp.value = currentVal !== null && currentVal !== undefined ? String(currentVal) : "";
      cell.innerHTML = "";
      cell.appendChild(inp);
      inp.focus();
      inp.addEventListener("blur", () => {
        commit(inp.value !== "" ? Number(inp.value) : null);
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
        else if (e.key === "Escape") cancel();
      });
      return;
    }

    // Default: contentEditable for text/url/relation/multi-select
    const span = document.createElement("span");
    span.contentEditable = "true";
    span.className = "db-cell-editable";
    span.textContent = currentVal !== null && currentVal !== undefined ? String(currentVal) : "";
    cell.innerHTML = "";
    cell.appendChild(span);
    span.focus();

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    span.addEventListener("blur", () => commit(span.textContent?.trim() || null));
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); span.blur(); }
      else if (e.key === "Escape") { cancel(); }
    });
  }

  private showAddColumnDialog(): void {
    if (!this.schema) return;

    // Simple inline dialog appended to the container
    const existing = this.container.querySelector(".db-add-col-dialog");
    if (existing) { existing.remove(); return; }

    const dialog = document.createElement("div");
    dialog.className = "db-add-col-dialog";
    dialog.innerHTML = `
      <div class="db-dialog-inner">
        <label>Column name <input class="db-dialog-input" type="text" placeholder="Name" /></label>
        <label>Type
          <select class="db-dialog-select">
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="select">Select</option>
            <option value="multi-select">Multi-select</option>
            <option value="date">Date</option>
            <option value="checkbox">Checkbox</option>
            <option value="url">URL</option>
          </select>
        </label>
        <div class="db-dialog-options-wrap" style="display:none;">
          <label>Options (comma-separated) <input class="db-dialog-options" type="text" placeholder="Todo, In Progress, Done" /></label>
        </div>
        <div class="db-dialog-actions">
          <button class="db-dialog-ok">Add</button>
          <button class="db-dialog-cancel">Cancel</button>
        </div>
      </div>
    `;

    this.container.querySelector(".db-view")?.appendChild(dialog);
    const nameInput = dialog.querySelector<HTMLInputElement>(".db-dialog-input")!;
    const typeSelect = dialog.querySelector<HTMLSelectElement>(".db-dialog-select")!;
    const optionsWrap = dialog.querySelector<HTMLElement>(".db-dialog-options-wrap")!;
    const optionsInput = dialog.querySelector<HTMLInputElement>(".db-dialog-options")!;

    nameInput.focus();

    typeSelect.addEventListener("change", () => {
      const needsOptions = typeSelect.value === "select" || typeSelect.value === "multi-select";
      optionsWrap.style.display = needsOptions ? "block" : "none";
    });

    dialog.querySelector(".db-dialog-ok")?.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name || !this.schema) return;
      const type = typeSelect.value as ColumnType;
      const id = `col_${Date.now().toString(36)}`;
      const colDef: ColumnDef = { id, name, type };
      if ((type === "select" || type === "multi-select") && optionsInput.value.trim()) {
        colDef.options = optionsInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      }
      this.schema = { ...this.schema, columns: [...this.schema.columns, colDef] };
      this.callbacks.postMessage({
        type: "saveDatabaseSchema",
        folderPath: this.folderPath,
        schema: this.schema,
      });
      dialog.remove();
      this.render();
    });

    dialog.querySelector(".db-dialog-cancel")?.addEventListener("click", () => {
      dialog.remove();
    });
  }
}
