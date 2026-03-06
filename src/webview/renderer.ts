/**
 * Markdown renderer.
 * Parses to a token list first (to capture source offsets), then renders
 * each top-level block individually so the editor can track positions.
 */
import { marked, Renderer, type Tokens } from "marked";
import hljs from "highlight.js";
import { applyDecorators } from "./decorators";
import { renderInlineNodes } from "./inlineParser";

// ── marked renderer ───────────────────────────────────────────────────────────

const renderer = new Renderer();

renderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

marked.use({ renderer, async: false });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlockInfo {
  id: number;
  raw: string;
  start: number;
  end: number;
  /** Space tokens between blocks — non-interactive. */
  isSpace: boolean;
  /** marked token type: "paragraph", "heading", "code", "blockquote", etc. */
  tokenType: string;
  /** Heading depth 1–6, only present when tokenType === "heading". */
  depth?: number;
}

export interface RenderedDocument {
  html: string;
  blockMap: Map<number, BlockInfo>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderDocument(
  markdown: string,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): RenderedDocument {
  const tokens = marked.lexer(markdown);
  const blockMap = new Map<number, BlockInfo>();
  const htmlParts: string[] = [];
  let offset = 0;

  tokens.forEach((token, i) => {
    const raw = token.raw;
    const isSpace = token.type === "space";
    const depth = "depth" in token ? (token as Tokens.Heading).depth : undefined;

    blockMap.set(i, { id: i, raw, start: offset, end: offset + raw.length, isSpace, tokenType: token.type, depth });

    if (!isSpace) {
      const html = renderBlockRaw(raw, filePath, webviewBaseUri, fileList);
      htmlParts.push(`<div class="valt-block" data-block-id="${i}">${html}</div>`);
    }

    offset += raw.length;
  });

  return { html: htmlParts.join(""), blockMap };
}

/**
 * Render a single raw markdown block string to HTML.
 * Used both during full-document render and by the live preview in the editor.
 */
export function renderBlock(
  raw: string,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): string {
  return renderBlockRaw(raw, filePath, webviewBaseUri, fileList);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function renderBlockRaw(
  raw: string,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): string {
  const decorated = applyDecorators(raw, filePath, fileList);
  const html = marked.parse(decorated) as string;
  return rewriteImageSrcs(html, webviewBaseUri);
}

function rewriteImageSrcs(html: string, baseUri: string): string {
  const base = baseUri.endsWith("/") ? baseUri : baseUri + "/";
  return html.replace(/<img([^>]*)\ssrc="([^"]+)"([^>]*)>/gi, (_m, before, src, after) => {
    const resolved = isRelativeUri(src) ? base + src : src;
    return `<img${before} src="${resolved}"${after}>`;
  });
}

function isRelativeUri(uri: string): boolean {
  return (
    !uri.startsWith("http://") &&
    !uri.startsWith("https://") &&
    !uri.startsWith("data:") &&
    !uri.startsWith("vscode-webview-resource:")
  );
}

// ── DOM-based document builder ─────────────────────────────────────────────────

export function buildDocumentDOM(
  markdown: string,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): { fragment: DocumentFragment; blockMap: Map<number, BlockInfo> } {
  const tokens = marked.lexer(markdown);
  const blockMap = new Map<number, BlockInfo>();
  const fragment = document.createDocumentFragment();
  let offset = 0;

  tokens.forEach((token, i) => {
    const raw = token.raw;
    const isSpace = token.type === "space";
    const depth = "depth" in token ? (token as Tokens.Heading).depth : undefined;
    blockMap.set(i, { id: i, raw, start: offset, end: offset + raw.length, isSpace, tokenType: token.type, depth });

    if (!isSpace) {
      fragment.appendChild(buildBlockElement(blockMap.get(i)!, filePath, webviewBaseUri, fileList));
    }
    offset += raw.length;
  });

  return { fragment, blockMap };
}

export function buildBlockElement(
  block: BlockInfo,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "valt-block";
  wrapper.dataset.blockId = String(block.id);
  if (block.isSpace) return wrapper;

  switch (block.tokenType) {
    case "heading":    wrapper.appendChild(buildHeading(block));    break;
    case "paragraph":  wrapper.appendChild(buildParagraph(block));  break;
    case "code":       wrapper.appendChild(buildCode(block));       break;
    case "blockquote": wrapper.appendChild(buildBlockquote(block)); break;
    case "list":       wrapper.appendChild(buildList(block));       break;
    default:           wrapper.appendChild(buildFallback(block, filePath, webviewBaseUri, fileList)); break;
  }
  return wrapper;
}

// ── Block builders ─────────────────────────────────────────────────────────────

function makeEditable(extraClass?: string): HTMLElement {
  const div = document.createElement("div");
  div.contentEditable = "true";
  div.spellcheck = false;
  div.className = ["valt-block-editor", extraClass].filter(Boolean).join(" ");
  return div;
}

function buildHeading(block: BlockInfo): HTMLElement {
  const depth = block.depth ?? 1;
  const marker = "#".repeat(depth) + " ";
  const content = block.raw.trimEnd().startsWith(marker)
    ? block.raw.trimEnd().slice(marker.length)
    : block.raw.trimEnd();
  const div = makeEditable(`valt-editor-h${depth}`);
  const ms = document.createElement("span");
  ms.className = "md-syn md-heading-marker";
  ms.textContent = marker;
  div.appendChild(ms);
  for (const n of renderInlineNodes(content)) div.appendChild(n);
  return div;
}

function buildParagraph(block: BlockInfo): HTMLElement {
  const div = makeEditable();
  for (const n of renderInlineNodes(block.raw.trimEnd())) div.appendChild(n);
  return div;
}

function buildCode(block: BlockInfo): HTMLElement {
  const div = makeEditable("valt-editor-code");
  div.textContent = block.raw.trimEnd();
  return div;
}

function buildBlockquote(block: BlockInfo): HTMLElement {
  const div = makeEditable("valt-editor-blockquote");
  const lines = block.raw.trimEnd().split("\n");
  lines.forEach((line, i) => {
    if (i > 0) div.appendChild(document.createTextNode("\n"));
    const m = line.match(/^(>\s?)/);
    if (m) {
      const ms = document.createElement("span");
      ms.className = "md-syn md-blockquote-marker";
      ms.textContent = m[1];
      div.appendChild(ms);
      for (const n of renderInlineNodes(line.slice(m[1].length))) div.appendChild(n);
    } else {
      for (const n of renderInlineNodes(line)) div.appendChild(n);
    }
  });
  return div;
}

function buildList(block: BlockInfo): HTMLElement {
  const div = makeEditable("valt-editor-list");
  const lines = block.raw.trimEnd().split("\n");
  lines.forEach((line, i) => {
    if (i > 0) div.appendChild(document.createTextNode("\n"));
    const m = line.match(/^(\s*(?:[-*+]|\d+\.)\s)/);
    if (m) {
      const ms = document.createElement("span");
      ms.className = "md-list-marker";
      ms.textContent = m[1];
      div.appendChild(ms);
      for (const n of renderInlineNodes(line.slice(m[1].length))) div.appendChild(n);
    } else {
      for (const n of renderInlineNodes(line)) div.appendChild(n);
    }
  });
  return div;
}

function buildFallback(
  block: BlockInfo,
  filePath: string,
  webviewBaseUri: string,
  fileList: string[]
): HTMLElement {
  // HR, table, image, raw HTML — rendered via marked, non-editable
  const div = document.createElement("div");
  div.className = "valt-block-static";
  div.innerHTML = renderBlockRaw(block.raw, filePath, webviewBaseUri, fileList);
  return div;
}
