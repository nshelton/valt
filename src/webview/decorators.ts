/**
 * Decorator pre-processor.
 * Runs before marked so the HTML is embedded naturally in the AST.
 *
 * All decorators use the @syntax. Degrades gracefully in plain markdown viewers.
 *
 *   @datetime(2024-03-06)        → date pill
 *   @tag(name)                   → colored tag chip
 *   @status(draft|active|done)   → color-coded status badge
 *   @pagename                    → wiki-link (bare @ with no parens, resolved from fileList)
 */

// ── Public API ────────────────────────────────────────────────────────────────

export function applyDecorators(
  markdown: string,
  currentPath: string,
  fileList: string[]
): string {
  let result = markdown;
  // Run known @word(...) forms first so the bare-@ page-link pass doesn't
  // accidentally match decorator names.
  result = transformDatetime(result);
  result = transformStatus(result);
  result = transformTags(result);
  result = transformPageLinks(result, currentPath, fileList);
  return result;
}

// ── @datetime ─────────────────────────────────────────────────────────────────

const DATETIME_RE = /@datetime\(([^)]+)\)/g;

function transformDatetime(md: string): string {
  return md.replace(DATETIME_RE, (_m, dateStr: string) => {
    const formatted = formatDate(dateStr.trim());
    return `<span class="valt-datetime" title="${escapeAttr(dateStr)}">${escapeHtml(formatted)}</span>`;
  });
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// ── @status ───────────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set(["draft", "active", "done"]);
const STATUS_RE = /@status\(([^)]+)\)/g;

function transformStatus(md: string): string {
  return md.replace(STATUS_RE, (match, raw: string) => {
    const status = raw.trim().toLowerCase();
    if (!VALID_STATUSES.has(status)) return match;
    return `<span class="valt-status" data-status="${status}">${status}</span>`;
  });
}

// ── @tag ──────────────────────────────────────────────────────────────────────

const TAG_RE = /@tag\(([^)]+)\)/g;

function transformTags(md: string): string {
  return md.replace(TAG_RE, (_m, raw: string) => {
    return `<span class="valt-tag">${escapeHtml(raw.trim())}</span>`;
  });
}

// ── @pagename (bare @ — no parens) ───────────────────────────────────────────

// Must be preceded by whitespace, start-of-line, or punctuation to avoid
// matching things like email addresses (foo@bar).
const PAGE_LINK_RE = /(?<![a-zA-Z0-9])@([a-zA-Z0-9][a-zA-Z0-9_\-./ ]*)(?!\()/g;

// Names consumed by the known @word(...) forms above.
const KNOWN_DECORATORS = new Set(["datetime", "status", "tag"]);

function transformPageLinks(md: string, currentPath: string, fileList: string[]): string {
  return md.replace(PAGE_LINK_RE, (match, name: string) => {
    const trimmed = name.trimEnd();
    if (KNOWN_DECORATORS.has(trimmed.toLowerCase())) return match;
    const resolved = resolvePageName(trimmed, currentPath, fileList);
    if (!resolved) return match;
    return `<a class="valt-wikilink" href="#" data-target="${escapeAttr(resolved)}">${escapeHtml(trimmed)}</a>`;
  });
}

function resolvePageName(name: string, currentPath: string, fileList: string[]): string | null {
  const lower = name.toLowerCase();

  // Exact basename match (without .md).
  const exact = fileList.find((f) => baseName(f).toLowerCase() === lower);
  if (exact) return exact;

  // Fuzzy: startsWith, then includes.
  const starts = fileList.find((f) => baseName(f).toLowerCase().startsWith(lower));
  if (starts) return starts;

  const contains = fileList.find((f) => baseName(f).toLowerCase().includes(lower));
  return contains ?? null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? filePath;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
