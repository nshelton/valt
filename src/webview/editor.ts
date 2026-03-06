/**
 * Block-level inline editor with live preview and @-autocomplete.
 *
 * Click a rendered block → textarea with raw markdown + live preview below.
 * Type @ → fuzzy dropdown of decorator templates and page filenames.
 * Blur or Escape → write-back via UpdateBlockMessage.
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

let activeBlockEl: HTMLElement | null = null;
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
  container.querySelectorAll<HTMLElement>(".valt-block").forEach((el) => {
    el.addEventListener("click", () => {
      if (activeBlockEl) return;
      const id = parseInt(el.dataset.blockId ?? "-1");
      const block = blockMap.get(id);
      if (block && !block.isSpace) activateBlock(el, block, ctx);
    });
  });
}

// ── Block activation ──────────────────────────────────────────────────────────

function activateBlock(
  blockEl: HTMLElement,
  block: BlockInfo,
  ctx: EditorContext
): void {
  activeBlockEl = blockEl;
  blockEl.classList.add("is-editing");

  const textarea = buildTextarea(block.raw.trimEnd(), block);
  blockEl.innerHTML = "";
  blockEl.appendChild(textarea);

  autoGrow(textarea);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    handleAutocompleteInput(textarea, ctx.fileList);
  });

  textarea.addEventListener("keydown", (e) =>
    handleKeydown(e, textarea, block, blockEl, ctx)
  );

  textarea.addEventListener("blur", () => {
    // Delay so a mousedown on an autocomplete item can fire first.
    setTimeout(() => finalizeEdit(blockEl, textarea, block, ctx), 160);
  });
}

function buildTextarea(raw: string): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.className = "valt-block-editor";
  ta.value = raw;
  ta.spellcheck = false;
  ta.autocomplete = "off";
  return ta;
}

// ── Keyboard handling ─────────────────────────────────────────────────────────

function handleKeydown(
  e: KeyboardEvent,
  textarea: HTMLTextAreaElement,
  block: BlockInfo,
  blockEl: HTMLElement,
  ctx: EditorContext
): void {
  if (autocomplete) {
    if (e.key === "ArrowDown") { e.preventDefault(); shiftActive(1);  return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); shiftActive(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      commitAutocomplete(textarea);
      return;
    }
    if (e.key === "Escape") { dismissAutocomplete(); return; }
  }

  if (e.key === "Escape") {
    dismissAutocomplete();
    blockEl.classList.remove("is-editing");
    activeBlockEl = null;
    // Re-render original content without writing back.
    blockEl.innerHTML = renderBlock(block.raw, ctx.filePath, ctx.webviewBaseUri, ctx.fileList);
  }
}

// ── Finalize ──────────────────────────────────────────────────────────────────

function finalizeEdit(
  blockEl: HTMLElement,
  textarea: HTMLTextAreaElement,
  block: BlockInfo,
  ctx: EditorContext
): void {
  if (!activeBlockEl) return; // already done (e.g. Escape handler ran first)
  dismissAutocomplete();
  activeBlockEl = null;
  blockEl.classList.remove("is-editing");

  const trailingWs = block.raw.match(/\n+$/)?.[0] ?? "\n";
  const newRaw = textarea.value.trimEnd() + trailingWs;

  if (newRaw !== block.raw) {
    ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: block.start, end: block.end, newRaw });
  } else {
    blockEl.innerHTML = renderBlock(block.raw, ctx.filePath, ctx.webviewBaseUri, ctx.fileList);
  }
}

// ── Autocomplete — input detection ────────────────────────────────────────────

function handleAutocompleteInput(textarea: HTMLTextAreaElement, fileList: string[]): void {
  const query = getAtQuery(textarea);
  if (query === null) { dismissAutocomplete(); return; }

  const items = buildItems(query, fileList);
  if (items.length === 0) { dismissAutocomplete(); return; }

  renderAutocomplete(textarea, items);
}

function getAtQuery(textarea: HTMLTextAreaElement): string | null {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const match  = before.match(/@([a-zA-Z0-9_\-./ ]*)$/);
  return match ? match[1] : null;
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
  if (candidate === query) return 4;
  if (candidate.startsWith(query)) return 3;
  if (candidate.includes(query)) return 2;
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  return qi === query.length ? 1 : 0;
}

// ── Autocomplete — rendering ──────────────────────────────────────────────────

function renderAutocomplete(textarea: HTMLTextAreaElement, items: CompletionItem[]): void {
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
      commitAutocomplete(textarea);
    });

    dropdown.appendChild(el);
  });

  positionNearCaret(dropdown, textarea);
  document.body.appendChild(dropdown);
  autocomplete = { dropdown, items, activeIndex: 0 };
}

function positionNearCaret(dropdown: HTMLElement, textarea: HTMLTextAreaElement): void {
  const { top, left } = caretPixelPos(textarea);
  dropdown.style.position = "fixed";
  dropdown.style.top  = `${top + 22}px`;
  dropdown.style.left = `${Math.min(left, window.innerWidth - 260)}px`;
}

function shiftActive(delta: number): void {
  if (!autocomplete) return;
  const { dropdown, items } = autocomplete;
  autocomplete.activeIndex = Math.max(0, Math.min(items.length - 1, autocomplete.activeIndex + delta));
  dropdown.querySelectorAll(".valt-autocomplete-item").forEach((el, i) => {
    el.classList.toggle("is-active", i === autocomplete!.activeIndex);
  });
}

function commitAutocomplete(textarea: HTMLTextAreaElement): void {
  if (!autocomplete) return;
  const item = autocomplete.items[autocomplete.activeIndex];
  if (!item) return;

  const pos    = textarea.selectionStart;
  const before = textarea.value.slice(0, pos);
  const after  = textarea.value.slice(pos);
  const match  = before.match(/@([a-zA-Z0-9_\-./ ]*)$/);
  if (!match) return;

  const newBefore = before.slice(0, before.length - match[0].length) + "@" + item.insert;
  textarea.value  = newBefore + after;
  textarea.selectionStart = textarea.selectionEnd = newBefore.length;

  dismissAutocomplete();
  textarea.dispatchEvent(new Event("input"));
}

function dismissAutocomplete(): void {
  autocomplete?.dropdown.remove();
  autocomplete = null;
}

// ── Caret position (mirror-div technique) ─────────────────────────────────────

function caretPixelPos(ta: HTMLTextAreaElement): { top: number; left: number } {
  const pos   = ta.selectionStart;
  const style = window.getComputedStyle(ta);

  const mirror = document.createElement("div");
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "lineHeight",
    "letterSpacing", "padding", "borderWidth", "boxSizing", "whiteSpace",
    "wordBreak", "overflowWrap",
  ] as const) {
    (mirror.style as Record<string, string>)[prop] = style[prop];
  }
  mirror.style.position   = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.top        = "-9999px";
  mirror.style.left       = "-9999px";
  mirror.style.width      = `${ta.offsetWidth}px`;
  mirror.style.whiteSpace = "pre-wrap";

  const before = document.createElement("span");
  before.textContent = ta.value.slice(0, pos);

  const caret = document.createElement("span");
  caret.textContent = "\u200b";

  mirror.appendChild(before);
  mirror.appendChild(caret);
  document.body.appendChild(mirror);

  const taRect     = ta.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const caretRect  = caret.getBoundingClientRect();
  document.body.removeChild(mirror);

  return {
    top:  taRect.top  + (caretRect.top  - mirrorRect.top)  - ta.scrollTop,
    left: taRect.left + (caretRect.left - mirrorRect.left),
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

function baseName(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}
