/**
 * CodeMirror 6 decorator plugin + autocomplete + @now ephemeral replacer.
 *
 * Supported syntax:
 *   @now              → ephemeral: immediately replaced with current timestamp
 *   @yesterday        → date badge (chrono-node parsed)
 *   @"next friday"    → date badge (quoted natural language)
 *   @tag(Label)       → purple pill
 *   @filename.md      → blue wikilink; click opens the file
 */
import {
  ViewPlugin, DecorationSet, Decoration, WidgetType, EditorView, ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, Annotation, Extension } from "@codemirror/state";
import { autocompletion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { DecoratorProvider } from "./decoratorProviders";
import { formatDate } from "./decoratorProviders";
import type { WebviewMessage } from "../shared/messages";

// ── Regex ─────────────────────────────────────────────────────────────────────
// Priority: tag > file > quoted datetime > bare word datetime
const DECORATOR_PATTERN =
  /(?<tag>@tag\((?<tagLabel>[^)]*)\))|(?<file>@(?<fileName>[\w.-]+\.md))|(?<quoted>@"(?<phrase>[^"]*)")|(?<word>@(?<wordText>[\w-]+))/g;

// ── Generic widget ────────────────────────────────────────────────────────────

class DecoratorWidget extends WidgetType {
  constructor(readonly text: string, readonly cssClass: string) { super(); }

  eq(other: DecoratorWidget): boolean {
    return other.text === this.text && other.cssClass === this.cssClass;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cssClass;
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean { return false; }
}

// ── Decoration builder ────────────────────────────────────────────────────────

function buildDecorations(view: EditorView, providers: DecoratorProvider[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from: curFrom, to: curTo } = view.state.selection.main;

  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    let pos = rangeFrom;
    while (pos <= rangeTo) {
      const line = view.state.doc.lineAt(pos);
      const re = new RegExp(DECORATOR_PATTERN.source, "g");
      let match: RegExpExecArray | null;

      while ((match = re.exec(line.text)) !== null) {
        const mFrom = line.from + match.index;
        const mTo = mFrom + match[0].length;

        // Cursor inside → show raw text for editing
        if (curFrom <= mTo && curTo >= mFrom) continue;

        // Determine what comes after the @
        const g = match.groups ?? {};
        let afterAt: string;
        if (g.tag)    afterAt = `tag(${g.tagLabel ?? ""})`;
        else if (g.file)   afterAt = g.fileName ?? "";
        else if (g.quoted) afterAt = g.phrase ?? "";
        else if (g.word)   afterAt = g.wordText ?? "";
        else continue;

        // Ask providers in order
        let spec = null;
        for (const p of providers) {
          spec = p.tryMatch(afterAt);
          if (spec) break;
        }
        if (!spec) continue;

        if (spec.isReplace) {
          builder.add(mFrom, mTo, Decoration.replace({
            widget: new DecoratorWidget(spec.displayText, spec.cssClass),
          }));
        } else {
          builder.add(mFrom, mTo, Decoration.mark({ class: spec.cssClass }));
        }
      }

      if (line.to >= rangeTo) break;
      pos = line.to + 1;
    }
  }

  return builder.finish();
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

function createDecoratorPlugin(
  providers: DecoratorProvider[],
  postMessage: (msg: WebviewMessage) => void,
  resolveFile: (name: string) => string,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, providers);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, providers);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        click(event: MouseEvent, view: EditorView) {
          const target = event.target as HTMLElement;
          if (!target.classList.contains("cm-decorator-file")) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          const fileRe = /@([\w.-]+\.md)/g;
          let m: RegExpExecArray | null;
          while ((m = fileRe.exec(line.text)) !== null) {
            const from = line.from + m.index;
            const to = from + m[0].length;
            if (pos >= from && pos <= to) {
              postMessage({ type: "requestFile", path: resolveFile(m[1]) });
              return true;
            }
          }
          return false;
        },
      },
    },
  );
}

// ── Autocomplete ──────────────────────────────────────────────────────────────

function createCompletionSource(providers: DecoratorProvider[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/@\w*/);
    if (!match || (match.from === match.to && !context.explicit)) return null;
    const query = match.text.slice(1); // strip leading @
    const options = providers.flatMap((p) => p.completions(query));
    return options.length > 0 || context.explicit ? { from: match.from, options } : null;
  };
}

// ── @now ephemeral replacer ───────────────────────────────────────────────────

const nowReplacedAnnotation = Annotation.define<true>();

const nowReplacer = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return;
  if (update.transactions.some((tr) => tr.annotation(nowReplacedAnnotation))) return;

  const text = update.state.doc.toString();
  const cursor = update.state.selection.main.head;
  const re = /@now\b/g;
  const changes: { from: number; to: number; insert: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    // Replace only once cursor has moved past the token (user finished typing it)
    if (cursor < from || cursor > to) {
      changes.push({ from, to, insert: "@" + formatDate(new Date()) });
    }
  }

  if (changes.length > 0) {
    update.view.dispatch({ changes, annotations: nowReplacedAnnotation.of(true) });
  }
});

// ── Public factory ────────────────────────────────────────────────────────────

export function createDecoratorExtensions(
  providers: DecoratorProvider[],
  postMessage: (msg: WebviewMessage) => void,
  resolveFile: (name: string) => string,
): Extension[] {
  return [
    createDecoratorPlugin(providers, postMessage, resolveFile),
    autocompletion({ override: [createCompletionSource(providers)] }),
    nowReplacer,
  ];
}
