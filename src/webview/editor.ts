/**
 * Block editor — contenteditable, always-on WYSIWYG.
 *
 * Each block is a contenteditable div. Inline syntax markers (.md-syn) are
 * hidden by default and revealed when the cursor is inside the formatted span.
 * Save is triggered on blur, same as before. @-autocomplete is adapted for
 * contenteditable via the Selection / Range API.
 */
import type { BlockInfo } from "./renderer";
import type { WebviewMessage } from "../shared/messages";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EditorContext {
  filePath: string;
  webviewBaseUri: string;
  fileList: string[];
  postMessage: (msg: WebviewMessage) => void;
}

interface CompletionItem {
  label: string;
  insert: string;
  kind: "decorator" | "page";
}

interface AutocompleteState {
  dropdown: HTMLElement;
  items: CompletionItem[];
  activeIndex: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

let autocomplete: AutocompleteState | null = null;

const DECORATOR_ITEMS: CompletionItem[] = [
  { label: "datetime(...)", insert: "datetime(", kind: "decorator" },
  { label: "tag(...)",      insert: "tag(",      kind: "decorator" },
  { label: "status(...)",   insert: "status(",   kind: "decorator" },
];

// ── Public API ────────────────────────────────────────────────────────────────

export function initEditor(
  container: HTMLElement,
  blockMap: Map<number, BlockInfo>,
  ctx: EditorContext
): void {
  setupSelectionTracking();

  container.querySelectorAll<HTMLElement>(".valt-block").forEach((blockEl) => {
    const id = parseInt(blockEl.dataset.blockId ?? "-1");
    const block = blockMap.get(id);
    if (!block || block.isSpace) return;

    const editable = blockEl.querySelector<HTMLElement>("[contenteditable]");
    if (!editable) return;

    editable.addEventListener("input", () => handleAutocompleteInput(editable, ctx.fileList));
    editable.addEventListener("keydown", (e) => handleKeydown(e, editable, block));
    editable.addEventListener("blur", () => {
      setTimeout(() => finalizeEdit(editable, block, ctx), 160);
    });
  });
}

// ── Selection tracking — reveal inline markers near cursor ────────────────────

function setupSelectionTracking(): void {
  document.addEventListener("selectionchange", () => {
    document.querySelectorAll<HTMLElement>(".cursor-here").forEach((el) => {
      el.classList.remove("cursor-here");
    });
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    el?.closest("strong, em, code, s, a")?.classList.add("cursor-here");
  });
}

// ── Serialization ─────────────────────────────────────────────────────────────

function getBlockText(el: HTMLElement): string {
  // innerText respects line breaks and includes opacity:0 text (md-syn markers)
  return el.innerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── Finalize ──────────────────────────────────────────────────────────────────

function finalizeEdit(editable: HTMLElement, block: BlockInfo, ctx: EditorContext): void {
  dismissAutocomplete();
  const trailingWs = block.raw.match(/\n+$/)?.[0] ?? "\n";
  const newRaw = getBlockText(editable).trimEnd() + trailingWs;
  if (newRaw !== block.raw) {
    ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: block.start, end: block.end, newRaw });
  }
}

// ── Keyboard handling ─────────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent, editable: HTMLElement, block: BlockInfo): void {
  if (autocomplete) {
    if (e.key === "ArrowDown") { e.preventDefault(); shiftActive(1);  return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); shiftActive(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commitAutocomplete(editable); return; }
    if (e.key === "Escape")    { dismissAutocomplete(); return; }
  }
  // Headings are single-line — Enter blurs instead of inserting a newline
  if (e.key === "Enter" && block.tokenType === "heading") {
    e.preventDefault();
    editable.blur();
  }
}

// ── Autocomplete — input detection ────────────────────────────────────────────

function handleAutocompleteInput(editable: HTMLElement, fileList: string[]): void {
  const query = getAtQuery(editable);
  if (query === null) { dismissAutocomplete(); return; }
  const items = buildItems(query, fileList);
  if (items.length === 0) { dismissAutocomplete(); return; }
  renderAutocomplete(editable, items);
}

function getAtQuery(editable: HTMLElement): string | null {
  const before = getTextBeforeCaret(editable);
  const match = before.match(/@([a-zA-Z0-9_\-./ ]*)$/);
  return match ? match[1] : null;
}

function getTextBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  return range.toString();
}

// ── Autocomplete — items ──────────────────────────────────────────────────────

function buildItems(query: string, fileList: string[]): CompletionItem[] {
  const decorators = fuzzyFilter(query, DECORATOR_ITEMS, (i) => i.label.replace("(...)", ""));
  const pages = fuzzyFilter(
    query,
    fileList.map((fp) => ({ label: baseName(fp), insert: baseName(fp), kind: "page" as const })),
    (i) => i.label
  );
  return [...decorators, ...pages].slice(0, 10);
}

function fuzzyFilter<T>(query: string, items: T[], getLabel: (i: T) => string): T[] {
  if (!query) return items.slice(0, 8);
  const q = query.toLowerCase();
  return items
    .map((item) => ({ item, score: fuzzyScore(q, getLabel(item).toLowerCase()) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

function fuzzyScore(query: string, candidate: string): number {
  if (candidate === query)            return 4;
  if (candidate.startsWith(query))   return 3;
  if (candidate.includes(query))     return 2;
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  return qi === query.length ? 1 : 0;
}

// ── Autocomplete — rendering ──────────────────────────────────────────────────

function renderAutocomplete(editable: HTMLElement, items: CompletionItem[]): void {
  dismissAutocomplete();
  const dropdown = document.createElement("div");
  dropdown.className = "valt-autocomplete";

  items.forEach((item, idx) => {
    const el = document.createElement("div");
    el.className = "valt-autocomplete-item" + (idx === 0 ? " is-active" : "");
    const label = document.createElement("span");
    label.textContent = item.label;
    const kind = document.createElement("span");
    kind.className = "valt-autocomplete-kind";
    kind.textContent = item.kind;
    el.appendChild(label);
    el.appendChild(kind);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      autocomplete!.activeIndex = idx;
      commitAutocomplete(editable);
    });
    dropdown.appendChild(el);
  });

  positionNearCaret(dropdown);
  document.body.appendChild(dropdown);
  autocomplete = { dropdown, items, activeIndex: 0 };
}

function positionNearCaret(dropdown: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.top  = `${rect.bottom + 4}px`;
  dropdown.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
}

function shiftActive(delta: number): void {
  if (!autocomplete) return;
  const { dropdown, items } = autocomplete;
  autocomplete.activeIndex = Math.max(0, Math.min(items.length - 1, autocomplete.activeIndex + delta));
  dropdown.querySelectorAll(".valt-autocomplete-item").forEach((el, i) => {
    el.classList.toggle("is-active", i === autocomplete!.activeIndex);
  });
}

function commitAutocomplete(editable: HTMLElement): void {
  if (!autocomplete) return;
  const item = autocomplete.items[autocomplete.activeIndex];
  if (!item) return;

  const before = getTextBeforeCaret(editable);
  const match = before.match(/@([a-zA-Z0-9_\-./ ]*)$/);
  if (!match) return;

  const sel = window.getSelection();
  if (!sel) return;
  // Extend selection backward to cover @query, then replace with completion
  for (let i = 0; i < match[0].length; i++) sel.modify("extend", "backward", "character");
  document.execCommand("insertText", false, "@" + item.insert);

  dismissAutocomplete();
  editable.dispatchEvent(new Event("input"));
}

function dismissAutocomplete(): void {
  autocomplete?.dropdown.remove();
  autocomplete = null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function baseName(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}
