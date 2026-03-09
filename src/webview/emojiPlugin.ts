/**
 * Emoji autocomplete + size plugin.
 * Trigger: type `:query` to search emoji by keyword (e.g. `:dog`, `:green`).
 * Selecting a completion replaces `:query` with the emoji character.
 * A ViewPlugin scans the visible document and applies a size bump to emoji glyphs.
 */
import { ViewPlugin, DecorationSet, Decoration, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import data from "@emoji-mart/data";
import { SearchIndex, init } from "emoji-mart";

init({ data });

// ── Emoji size plugin ─────────────────────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic})*/gu;
const emojiMark = Decoration.mark({ class: "cm-emoji" });

function buildEmojiDecorations(view: ViewUpdate["view"]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    EMOJI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMOJI_RE.exec(text)) !== null) {
      builder.add(from + m.index, from + m.index + m[0].length, emojiMark);
    }
  }
  return builder.finish();
}

export const emojiSizePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: ViewUpdate["view"]) { this.decorations = buildEmojiDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildEmojiDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Emoji autocomplete ────────────────────────────────────────────────────────

export async function emojiCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const word = context.matchBefore(/:[^\s:]{1,}/);
  if (!word) return null;

  const query = word.text.slice(1); // strip leading ':'
  if (!query.length) return null;

  const results: any[] = await SearchIndex.search(query);
  if (!results?.length) return null;

  return {
    from: word.from,
    options: results.slice(0, 20).map((emoji: any) => ({
      label: `${emoji.skins[0].native}  :${emoji.id}:`,
      apply: emoji.skins[0].native,
      detail: emoji.name,
    })),
  };
}
