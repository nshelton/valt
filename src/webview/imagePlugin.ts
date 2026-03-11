/**
 * CM6 plugin: renders ![alt](./img-*.ext)<!-- valt: size=medium align=center -->
 * as an image widget with a hover toolbar for size and alignment.
 *
 * Metadata is stored in the optional HTML comment immediately following the
 * image syntax on the same line. Plain markdown renderers ignore the comment.
 *
 * Sizes:   small=25%  medium=50%  large=100%
 * Aligns:  left | center | right
 */
import { StateField, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { DecorationSet, Decoration, WidgetType, EditorView } from "@codemirror/view";

// ── Types ─────────────────────────────────────────────────────────────────────

type ImageSize  = "small" | "medium" | "large";
type ImageAlign = "left" | "center" | "right";

interface ImageSpec {
  from: number;           // start of the full matched region (including comment)
  to: number;             // end of the full matched region
  src: string;            // the URL/path from the markdown
  alt: string;
  size: ImageSize;
  align: ImageAlign;
  commentFrom: number;    // -1 if no comment present
  commentTo: number;
}

// ── Parser ────────────────────────────────────────────────────────────────────

const IMG_RE   = /!\[([^\]]*)\]\((\.\/img-[^)]+)\)/g;
const META_RE  = /^<!--\s*valt:\s*([^>]*?)-->/ ;

function parseMeta(raw: string): { size: ImageSize; align: ImageAlign } {
  const size  = (raw.match(/size=(\w+)/)  ?.[1] ?? "medium") as ImageSize;
  const align = (raw.match(/align=(\w+)/) ?.[1] ?? "left")   as ImageAlign;
  return {
    size:  ["small","medium","large"].includes(size)  ? size  : "medium",
    align: ["left","center","right"].includes(align)  ? align : "left",
  };
}

function buildComment(size: ImageSize, align: ImageAlign): string {
  return `<!-- valt: size=${size} align=${align} -->`;
}

function findImages(state: EditorState): ImageSpec[] {
  const doc = state.doc.toString();
  const results: ImageSpec[] = [];

  for (const m of doc.matchAll(IMG_RE)) {
    const imgFrom = m.index!;
    const imgTo   = imgFrom + m[0].length;
    const alt     = m[1];
    const src     = m[2];

    // Look for <!-- valt: ... --> immediately after (on same line, optional space)
    const rest = doc.slice(imgTo, Math.min(imgTo + 80, doc.length));
    const commentMatch = rest.match(/^[ \t]*<!--\s*valt:\s*([^>]*?)-->/);

    let size:  ImageSize  = "medium";
    let align: ImageAlign = "left";
    let commentFrom = -1;
    let commentTo   = -1;
    let to = imgTo;

    if (commentMatch) {
      const meta = parseMeta(commentMatch[1]);
      size  = meta.size;
      align = meta.align;
      commentFrom = imgTo + (rest.indexOf("<!--"));
      commentTo   = commentFrom + commentMatch[0].trimStart().length;
      to = commentTo;
    }

    results.push({ from: imgFrom, to, src, alt, size, align, commentFrom, commentTo });
  }
  return results;
}

// ── Widget ────────────────────────────────────────────────────────────────────

const SIZE_PCT: Record<ImageSize, string> = { small: "25%", medium: "50%", large: "100%" };

class ImageWidget extends WidgetType {
  constructor(
    private readonly spec: ImageSpec,
    private readonly webviewBaseUri: string,
  ) { super(); }

  eq(other: ImageWidget): boolean {
    return (
      this.spec.src === other.spec.src &&
      this.spec.size === other.spec.size &&
      this.spec.align === other.spec.align
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `cm-image-wrap cm-image-align-${this.spec.align}`;

    const img = document.createElement("img");
    // Convert the relative ./img-xxx.ext path to an absolute webview URI
    const rel = this.spec.src.replace(/^\.\//, "");
    img.src = `${this.webviewBaseUri}/${rel}`;
    img.alt = this.spec.alt;
    img.style.width = SIZE_PCT[this.spec.size];
    img.draggable = false;
    img.className = "cm-image-el";

    const toolbar = this.buildToolbar(view, img);
    wrap.appendChild(img);
    wrap.appendChild(toolbar);

    return wrap;
  }

  private buildToolbar(view: EditorView, imgEl: HTMLImageElement): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-image-toolbar";

    const sizes: ImageSize[]   = ["small", "medium", "large"];
    const aligns: ImageAlign[] = ["left", "center", "right"];
    const alignLabels: Record<ImageAlign, string> = { left: "⬅", center: "⬛", right: "➡" };

    for (const s of sizes) {
      const btn = document.createElement("button");
      btn.className = "cm-image-btn" + (s === this.spec.size ? " active" : "");
      btn.textContent = s[0].toUpperCase();
      btn.title = s;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.applyMeta(view, s, this.spec.align);
      });
      bar.appendChild(btn);
    }

    const sep = document.createElement("span");
    sep.className = "cm-image-sep";
    bar.appendChild(sep);

    for (const a of aligns) {
      const btn = document.createElement("button");
      btn.className = "cm-image-btn" + (a === this.spec.align ? " active" : "");
      btn.textContent = alignLabels[a];
      btn.title = a;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.applyMeta(view, this.spec.size, a);
      });
      bar.appendChild(btn);
    }

    const sep2 = document.createElement("span");
    sep2.className = "cm-image-sep";
    bar.appendChild(sep2);

    const copyBtn = document.createElement("button");
    copyBtn.className = "cm-image-btn";
    copyBtn.textContent = "⎘";
    copyBtn.title = "Copy image";
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.copyImageToClipboard(imgEl);
    });
    bar.appendChild(copyBtn);

    return bar;
  }

  private copyImageToClipboard(imgEl: HTMLImageElement): void {
    const canvas = document.createElement("canvas");
    canvas.width  = imgEl.naturalWidth  || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(imgEl, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {
        // Clipboard API not available — silently ignore
      });
    }, "image/png");
  }

  private applyMeta(view: EditorView, size: ImageSize, align: ImageAlign): void {
    const comment = buildComment(size, align);
    const { commentFrom, commentTo, to } = this.spec;
    if (commentFrom >= 0) {
      view.dispatch({ changes: { from: commentFrom, to: commentTo, insert: comment } });
    } else {
      // Insert comment immediately after the image markdown (no space before)
      view.dispatch({ changes: { from: to, to, insert: comment } });
    }
  }

  ignoreEvent(): boolean { return false; }
}

// ── StateField ────────────────────────────────────────────────────────────────

function buildDecos(state: EditorState, webviewBaseUri: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const specs = findImages(state).sort((a, b) => a.from - b.from);
  for (const spec of specs) {
    builder.add(
      spec.from, spec.to,
      Decoration.replace({ widget: new ImageWidget(spec, webviewBaseUri) }),
    );
  }
  return builder.finish();
}

export function createImagePlugin(webviewBaseUri: string): Extension {
  const imageField = StateField.define<DecorationSet>({
    create(state) { return buildDecos(state, webviewBaseUri); },
    update(decos, tr) {
      return tr.docChanged ? buildDecos(tr.state, webviewBaseUri) : decos;
    },
    provide(f) { return EditorView.decorations.from(f); },
  });

  // Make each image range atomic so the cursor jumps over the whole thing
  // and delete/cut commands remove the entire markdown+comment in one operation.
  const atomicRanges = EditorView.atomicRanges.of((view) => view.state.field(imageField));

  return [imageField, atomicRanges];
}
