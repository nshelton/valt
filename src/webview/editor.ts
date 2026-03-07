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

interface DragState {
  blockId: number;
  block: BlockInfo;
  blockEl: HTMLElement;
}

// ── Module state ──────────────────────────────────────────────────────────────

let autocomplete: AutocompleteState | null = null;
let contextMenu: HTMLElement | null = null;
let currentDrag: DragState | null = null;
let selectionTrackingSetup = false;
/** File offset at which to focus the next block after a re-render. */
let pendingFocusAfterOffset: number | null = null;
/** File offset after which to spawn an ephemeral new block after re-render. */
let pendingEphemeralAtOffset: number | null = null;
let currentBlockMap: Map<number, BlockInfo> | null = null;
let currentContainer: HTMLElement | null = null;

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
  currentContainer = container;
  currentBlockMap = blockMap;
  setupSelectionTracking();

  container.querySelectorAll<HTMLElement>(".valt-block").forEach((blockEl) => {
    const id = parseInt(blockEl.dataset.blockId ?? "-1");
    const block = blockMap.get(id);
    if (!block || block.isSpace) return;

    const editable = blockEl.querySelector<HTMLElement>("[contenteditable]");
    if (!editable) return;

    editable.addEventListener("input", () => handleAutocompleteInput(editable, ctx.fileList));
    editable.addEventListener("keydown", (e) => handleKeydown(e, editable, block, ctx));
    editable.addEventListener("blur", () => {
      setTimeout(() => finalizeEdit(editable, block, ctx), 160);
    });

    setupBlockHandle(blockEl, block, ctx);
  });

  // Restore focus after re-render (e.g. Enter with no content change)
  if (pendingFocusAfterOffset !== null) {
    const offset = pendingFocusAfterOffset;
    pendingFocusAfterOffset = null;
    focusBlockNearOffset(offset, container, blockMap);
  }

  // Spawn ephemeral new-block after re-render (e.g. Enter with content change)
  if (pendingEphemeralAtOffset !== null) {
    const offset = pendingEphemeralAtOffset;
    pendingEphemeralAtOffset = null;
    spawnEphemeralBlockAtOffset(offset, container, blockMap, ctx);
  }
}

// ── Selection tracking — reveal inline markers near cursor ────────────────────

function setupSelectionTracking(): void {
  if (selectionTrackingSetup) return;
  selectionTrackingSetup = true;
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

// ── Focus restore after re-render ─────────────────────────────────────────────

function focusBlockNearOffset(
  offset: number,
  container: HTMLElement,
  blockMap: Map<number, BlockInfo>
): void {
  let target: BlockInfo | null = null;
  for (const [, block] of blockMap) {
    if (!block.isSpace && block.start >= offset) {
      if (!target || block.start < target.start) target = block;
    }
  }
  if (!target) return;
  const el = container.querySelector<HTMLElement>(
    `[data-block-id="${target.id}"] [contenteditable]`
  );
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// ── Serialization ─────────────────────────────────────────────────────────────

function getBlockText(el: HTMLElement): string {
  // innerText respects line breaks and includes opacity:0 text (md-syn markers)
  return el.innerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── Finalize ──────────────────────────────────────────────────────────────────

function finalizeEdit(editable: HTMLElement, block: BlockInfo, ctx: EditorContext): void {
  // Guard: detached elements (after re-render) return "" for innerText in Chromium,
  // which would silently delete the block's content.
  if (!editable.isConnected) return;
  // Guard: Enter key pre-saves synchronously to avoid double-post on blur.
  if (editable.dataset.valtFinalized) { delete editable.dataset.valtFinalized; return; }
  dismissAutocomplete();
  const trailingWs = block.raw.match(/\n+$/)?.[0] ?? "\n";
  const newRaw = getBlockText(editable).trimEnd() + trailingWs;
  if (newRaw !== block.raw) {
    ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: block.start, end: block.end, newRaw });
  } else if (pendingFocusAfterOffset !== null) {
    // Content unchanged — no re-render will fire, focus next block immediately
    const offset = pendingFocusAfterOffset;
    pendingFocusAfterOffset = null;
    if (currentContainer && currentBlockMap) {
      focusBlockNearOffset(offset, currentContainer, currentBlockMap);
    }
  }
}

// ── Block navigation ──────────────────────────────────────────────────────────

function isCaretOnFirstLine(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const caret = sel.getRangeAt(0).getBoundingClientRect();
  if (caret.height === 0) return true; // empty block
  return caret.top < el.getBoundingClientRect().top + caret.height * 1.5;
}

function isCaretOnLastLine(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const caret = sel.getRangeAt(0).getBoundingClientRect();
  if (caret.height === 0) return true; // empty block
  return caret.bottom > el.getBoundingClientRect().bottom - caret.height * 1.5;
}

function navigateToAdjacentBlock(
  dir: "up" | "down",
  block: BlockInfo,
  container: HTMLElement,
  blockMap: Map<number, BlockInfo>
): void {
  const sorted = Array.from(blockMap.values())
    .filter((b) => !b.isSpace)
    .sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex((b) => b.id === block.id);
  const target = dir === "down" ? sorted[idx + 1] : sorted[idx - 1];
  if (!target) return;
  const targetEditable = container.querySelector<HTMLElement>(
    `[data-block-id="${target.id}"] [contenteditable]`
  );
  if (!targetEditable) return;
  targetEditable.focus();
  const range = document.createRange();
  if (dir === "down") {
    range.setStart(targetEditable, 0);
    range.collapse(true);
  } else {
    range.selectNodeContents(targetEditable);
    range.collapse(false);
  }
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

// ── Keyboard handling ─────────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent, editable: HTMLElement, block: BlockInfo, ctx: EditorContext): void {
  if (autocomplete) {
    if (e.key === "ArrowDown") { e.preventDefault(); shiftActive(1);  return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); shiftActive(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commitAutocomplete(editable); return; }
    if (e.key === "Escape")    { dismissAutocomplete(); return; }
  }
  if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && currentContainer && currentBlockMap) {
    if (isCaretOnLastLine(editable)) {
      e.preventDefault();
      navigateToAdjacentBlock("down", block, currentContainer, currentBlockMap);
      return;
    }
  }
  if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && currentContainer && currentBlockMap) {
    if (isCaretOnFirstLine(editable)) {
      e.preventDefault();
      navigateToAdjacentBlock("up", block, currentContainer, currentBlockMap);
      return;
    }
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (block.tokenType === "list") {
      handleListEnter(editable);
    } else {
      handleEnterKey(editable, block, ctx);
    }
  }
}

function handleListEnter(editable: HTMLElement): void {
  const before = getTextBeforeCaret(editable);
  const currentLine = before.split("\n").pop() ?? "";
  const markerMatch = currentLine.match(/^(\s*)([-*+]|\d+\.)(\s+)/);

  if (!markerMatch) {
    insertTextAtCaret("\n");
    return;
  }

  const [, indent, marker, space] = markerMatch;
  let nextMarker: string;
  if (/^\d+$/.test(marker)) {
    nextMarker = `${indent}${parseInt(marker, 10) + 1}.${space}`;
  } else {
    nextMarker = `${indent}${marker}${space}`;
  }
  insertTextAtCaret("\n" + nextMarker);
}

function insertTextAtCaret(text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);
}

function handleEnterKey(editable: HTMLElement, block: BlockInfo, ctx: EditorContext): void {
  editable.dataset.valtFinalized = "1";
  const trailingWs = block.raw.match(/\n+$/)?.[0] ?? "\n";

  if (block.tokenType === "paragraph") {
    const textBefore = getTextBeforeCaret(editable);
    const fullText = getBlockText(editable);
    const textAfter = fullText.slice(textBefore.length);

    if (textAfter.trim()) {
      // Mid-block split: first part stays, second part becomes a new paragraph.
      const firstPart = textBefore.trimEnd();
      const secondPart = textAfter.trimStart();
      const newRaw = firstPart + "\n\n" + secondPart + trailingWs;
      // Focus the new second block after re-render.
      pendingFocusAfterOffset = block.start + firstPart.length + 2;
      ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: block.start, end: block.end, newRaw });
      editable.blur();
      return;
    }
  }

  // Default: save full block content and spawn empty block below.
  const newRaw = getBlockText(editable).trimEnd() + trailingWs;
  const newBlockEnd = block.start + newRaw.length;
  if (newRaw !== block.raw) {
    pendingEphemeralAtOffset = newBlockEnd;
    ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: block.start, end: block.end, newRaw });
  } else {
    const refEl = editable.closest<HTMLElement>(".valt-block");
    if (refEl) spawnEphemeralBlock(refEl, newBlockEnd, ctx);
  }
  editable.blur();
}

// ── Ephemeral new-block ───────────────────────────────────────────────────────

function spawnEphemeralBlockAtOffset(
  insertAfterOffset: number,
  container: HTMLElement,
  blockMap: Map<number, BlockInfo>,
  ctx: EditorContext
): void {
  // Find the non-space block whose end is closest to (and ≤) insertAfterOffset.
  let refBlock: BlockInfo | null = null;
  for (const [, block] of blockMap) {
    if (!block.isSpace && block.end <= insertAfterOffset) {
      if (!refBlock || block.end > refBlock.end) refBlock = block;
    }
  }
  if (!refBlock) return;
  const refEl = container.querySelector<HTMLElement>(`[data-block-id="${refBlock.id}"]`);
  if (refEl) spawnEphemeralBlock(refEl, insertAfterOffset, ctx);
}

function spawnEphemeralBlock(afterEl: HTMLElement, insertAtOffset: number, ctx: EditorContext): void {
  const wrapper = document.createElement("div");
  wrapper.className = "valt-block";
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  editable.spellcheck = false;
  editable.className = "valt-block-editor";
  wrapper.appendChild(editable);
  afterEl.insertAdjacentElement("afterend", wrapper);
  editable.focus();

  editable.addEventListener("input", () => handleAutocompleteInput(editable, ctx.fileList));
  editable.addEventListener("keydown", (e) => {
    if (autocomplete) {
      if (e.key === "ArrowDown") { e.preventDefault(); shiftActive(1);  return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); shiftActive(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commitAutocomplete(editable); return; }
      if (e.key === "Escape")    { dismissAutocomplete(); return; }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commitEphemeral(editable, wrapper, insertAtOffset, ctx, /* spawnNext */ true);
    }
    if (e.key === "Escape") { dismissAutocomplete(); wrapper.remove(); }
  });
  editable.addEventListener("blur", () => {
    setTimeout(() => commitEphemeral(editable, wrapper, insertAtOffset, ctx, /* spawnNext */ false), 160);
  });
}

function commitEphemeral(
  editable: HTMLElement,
  wrapper: HTMLElement,
  insertAtOffset: number,
  ctx: EditorContext,
  spawnNext: boolean
): void {
  if (!editable.isConnected) return;
  dismissAutocomplete();
  const text = getBlockText(editable).trimEnd();
  if (!text) { wrapper.remove(); return; }
  // Leading \n ensures a blank line between the previous block and the new one.
  // If the text looks like a setext heading underline (--- or ===), use \n\n
  // so it can never accidentally merge with the preceding paragraph even when
  // the file has no trailing newline before insertAtOffset.
  const isSetextUnderline = /^[ \t]*[-=]+[ \t]*$/.test(text);
  const newRaw = (isSetextUnderline ? "\n\n" : "\n") + text + "\n\n";
  // Paragraph token starts at insertAtOffset + 1 (after the leading \n),
  // raw = text + \n, so end = insertAtOffset + 1 + text.length + 1.
  const newParagraphEnd = insertAtOffset + text.length + 2;
  if (spawnNext) {
    pendingEphemeralAtOffset = newParagraphEnd;
  } else {
    pendingFocusAfterOffset = insertAtOffset;
  }
  ctx.postMessage({ type: "updateBlock", filePath: ctx.filePath, start: insertAtOffset, end: insertAtOffset, newRaw });
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
  insertTextAtCaret("@" + item.insert);

  dismissAutocomplete();
  editable.dispatchEvent(new Event("input"));
}

function dismissAutocomplete(): void {
  autocomplete?.dropdown.remove();
  autocomplete = null;
}

// ── Block handle: drag & context menu ────────────────────────────────────────

function setupBlockHandle(blockEl: HTMLElement, block: BlockInfo, ctx: EditorContext): void {
  const handle = blockEl.querySelector<HTMLElement>(".valt-block-handle");
  if (!handle) return;

  handle.addEventListener("dragstart", (e) => {
    currentDrag = { blockId: block.id, block, blockEl };
    e.dataTransfer?.setData("text/plain", String(block.id));
    blockEl.style.opacity = "0.4";
  });
  handle.addEventListener("dragend", () => {
    if (currentDrag) blockEl.style.opacity = "";
    currentDrag = null;
    document.querySelectorAll<HTMLElement>(".drag-over-above, .drag-over-below").forEach((el) => {
      el.classList.remove("drag-over-above", "drag-over-below");
    });
  });
  handle.addEventListener("contextmenu", (e) => showBlockContextMenu(e, block, ctx));

  blockEl.addEventListener("dragover", (e) => {
    if (!currentDrag || currentDrag.blockId === block.id) return;
    e.preventDefault();
    e.dataTransfer && (e.dataTransfer.dropEffect = "move");
    const rect = blockEl.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    blockEl.classList.toggle("drag-over-above", above);
    blockEl.classList.toggle("drag-over-below", !above);
  });
  blockEl.addEventListener("dragleave", () => {
    blockEl.classList.remove("drag-over-above", "drag-over-below");
  });
  blockEl.addEventListener("drop", (e) => handleBlockDrop(e, blockEl, block, ctx));
}

function handleBlockDrop(e: DragEvent, targetEl: HTMLElement, targetBlock: BlockInfo, ctx: EditorContext): void {
  e.preventDefault();
  targetEl.classList.remove("drag-over-above", "drag-over-below");
  if (!currentDrag || currentDrag.blockId === targetBlock.id) return;

  const { block: movingBlock, blockEl } = currentDrag;
  blockEl.style.opacity = "";
  currentDrag = null;

  const rect = targetEl.getBoundingClientRect();
  const above = e.clientY < rect.top + rect.height / 2;
  const insertAfterOffset = above ? targetBlock.start : targetBlock.end;

  ctx.postMessage({
    type: "moveBlock",
    filePath: ctx.filePath,
    movingStart: movingBlock.start,
    movingEnd: movingBlock.end,
    insertAfterOffset,
  });
}

function showBlockContextMenu(e: MouseEvent, block: BlockInfo, ctx: EditorContext): void {
  e.preventDefault();
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "valt-context-menu";

  const debug = document.createElement("div");
  debug.className = "valt-context-menu-debug";
  const depthLine = block.depth != null ? `\ndepth:  ${block.depth}` : "";
  debug.textContent = `id:     ${block.id}\ntype:   ${block.tokenType}\nstart:  ${block.start}\nend:    ${block.end}${depthLine}`;
  menu.appendChild(debug);

  const sep = document.createElement("hr");
  sep.className = "valt-context-menu-sep";
  menu.appendChild(sep);

  const del = document.createElement("div");
  del.className = "valt-context-menu-item danger";
  del.textContent = "Delete block";
  del.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    dismissContextMenu();
    ctx.postMessage({ type: "deleteBlock", filePath: ctx.filePath, start: block.start, end: block.end });
  });
  menu.appendChild(del);

  menu.style.top = `${e.clientY}px`;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
  document.body.appendChild(menu);
  contextMenu = menu;
  setTimeout(() => document.addEventListener("mousedown", dismissContextMenu, { once: true }), 0);
}

function dismissContextMenu(): void {
  contextMenu?.remove();
  contextMenu = null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function baseName(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}
