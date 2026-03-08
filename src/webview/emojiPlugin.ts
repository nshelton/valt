/**
 * Emoji autocomplete plugin.
 * Trigger: type `:query` to search emoji by keyword (e.g. `:dog`, `:green`).
 * Selecting a completion replaces `:query` with the emoji character.
 */
import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import data from "@emoji-mart/data";
import { SearchIndex, init } from "emoji-mart";

init({ data });

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
