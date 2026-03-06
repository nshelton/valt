/**
 * Markdown renderer.
 * Parses to a token list first (to capture source offsets), then renders
 * each top-level block individually so the editor can track positions.
 */
import { marked, Renderer, type Tokens } from "marked";
import hljs from "highlight.js";
import { applyDecorators } from "./decorators";

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
