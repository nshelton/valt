/**
 * Inline markdown → DOM nodes with hidden syntax markers.
 * Critical invariant: textContent of all returned nodes == original markdown source.
 *
 * Handles: **bold**, *italic*, `code`, ~~strike~~, [link](url)
 * Syntax markers are wrapped in .md-syn spans (opacity:0 by default, revealed near cursor).
 */

// Priority order matters: ** before *, ~~ before ~
const INLINE_RE = /\*\*([\s\S]*?)\*\*|\*((?!\*)[^*\n]*?)\*|`([^`\n]+)`|~~([\s\S]*?)~~|\[([^\]]*)\]\(([^)]+)\)/g;

function syn(marker: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "md-syn";
  s.textContent = marker;
  return s;
}

function wrapEl(tag: string, open: string, close: string, inner: string): HTMLElement {
  const el = document.createElement(tag);
  el.appendChild(syn(open));
  for (const n of renderInlineNodes(inner)) el.appendChild(n);
  el.appendChild(syn(close));
  return el;
}

function linkEl(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "valt-wikilink";
  a.appendChild(syn("["));
  for (const n of renderInlineNodes(text)) a.appendChild(n);
  a.appendChild(syn(`](${href})`));
  return a;
}

export function renderInlineNodes(text: string): Node[] {
  const nodes: Node[] = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));

    if      (m[1] !== undefined) nodes.push(wrapEl("strong", "**", "**", m[1]));
    else if (m[2] !== undefined) nodes.push(wrapEl("em",     "*",  "*",  m[2]));
    else if (m[3] !== undefined) nodes.push(wrapEl("code",   "`",  "`",  m[3]));
    else if (m[4] !== undefined) nodes.push(wrapEl("s",      "~~", "~~", m[4]));
    else if (m[5] !== undefined) nodes.push(linkEl(m[5], m[6]));

    last = re.lastIndex;
  }

  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}
