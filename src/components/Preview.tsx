import { useEffect, useRef } from "react";
import temml from "temml";
import type { SlidePlan, DocPlan, DocBlock } from "../lib/types";

/* ──────────────────────────────────────────────
 * Original PDF preview (canvas pages, vertical)
 * ────────────────────────────────────────────── */
export function PdfPreview({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const pdfjsLib = await (await import("../lib/pdfjs")).getPdfjs();
      const buf = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        const targetW = 360;
        const scale = targetW / viewport.width;
        const vp = page.getViewport({ scale });
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.className = "pdf-page";
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        ref.current.appendChild(canvas);
      }
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [blob]);

  return <div className="preview-pane" ref={ref} />;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ──────────────────────────────────────────────
 * Generated PPTX preview — render SlidePlan as HTML slides
 * ────────────────────────────────────────────── */
export function SlidesPreview({ slides }: { slides: SlidePlan[] }) {
  return (
    <div className="preview-pane">
      {slides.map((s, i) => <SlideHTML key={i} slide={s} index={i + 1} />)}
    </div>
  );
}

function SlideHTML({ slide, index }: { slide: SlidePlan; index: number }) {
  const layoutClass = `slide slide-${slide.layout}`;
  // Mirror buildPptx exactly: section-title shows ONLY the title centered;
  // title-image hides bullets and centers the figure full-frame.
  if (slide.layout === "section-title") {
    return (
      <div className={layoutClass}>
        <div className="slide-num">{index}</div>
        <div className="section-title"><InlineMath text={slide.title} /></div>
      </div>
    );
  }
  if (slide.layout === "title-image") {
    return (
      <div className={layoutClass}>
        <div className="slide-num">{index}</div>
        <div className="slide-title"><InlineMath text={slide.title} /></div>
        <div className="slide-body">
          {slide.imageDataUrl
            ? <img src={slide.imageDataUrl} alt={`slide ${index}`} className="slide-img" />
            : <div className="slide-bullets">
                {slide.bullets.map((b, i) => <div key={i} className="bullet">• <InlineMath text={b} /></div>)}
              </div>}
        </div>
      </div>
    );
  }
  return (
    <div className={layoutClass}>
      <div className="slide-num">{index}</div>
      <div className="slide-title"><InlineMath text={slide.title} /></div>
      <div className="slide-body">
        <div className="slide-bullets">
          {slide.bullets.map((b, i) => <div key={i} className="bullet">• <InlineMath text={b} /></div>)}
        </div>
        {slide.imageDataUrl && (
          <img src={slide.imageDataUrl} alt={`slide ${index}`} className="slide-img" />
        )}
      </div>
    </div>
  );
}

/** Render a string that may contain $...$ inline math and $$...$$ display math. */
function InlineMath({ text }: { text: string }) {
  const parts: Array<{ kind: "text" | "inline" | "display"; value: string }> = [];
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: "text", value: text.slice(last, m.index) });
    if (m[1]) parts.push({ kind: "display", value: m[1] });
    else parts.push({ kind: "inline", value: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  if (parts.length === 0) return <>{text}</>;
  return <>{parts.map((p, i) => {
    if (p.kind === "text") return <span key={i}>{p.value}</span>;
    let html: string;
    try { html = temml.renderToString(p.value, { displayMode: p.kind === "display", throwOnError: true }); }
    catch { html = `<code class="formula-fallback">${escapeHtml(p.value)}</code>`; }
    const Tag = p.kind === "display" ? "div" : "span";
    return <Tag key={i} className={p.kind === "display" ? "formula-display" : "formula-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
  })}</>;
}

/* ──────────────────────────────────────────────
 * Generated DOCX preview — render DocPlan blocks as HTML
 * ────────────────────────────────────────────── */
export function DocPreview({ doc }: { doc: DocPlan }) {
  return (
    <div className="preview-pane doc-preview">
      {doc.title && <h1>{doc.title}</h1>}
      {doc.blocks.map((b, i) => <DocBlockEl key={i} block={b} />)}
    </div>
  );
}

function DocBlockEl({ block }: { block: DocBlock }) {
  switch (block.type) {
    case "h1": return <h1><InlineMath text={block.text} /></h1>;
    case "h2": return <h2><InlineMath text={block.text} /></h2>;
    case "h3": return <h3><InlineMath text={block.text} /></h3>;
    case "para": return <p><InlineMath text={block.text} /></p>;
    case "list": {
      if (block.ordered) return <ol>{block.items.map((it, i) => <li key={i}><InlineMath text={it} /></li>)}</ol>;
      return <ul>{block.items.map((it, i) => <li key={i}><InlineMath text={it} /></li>)}</ul>;
    }
    case "table": {
      return (
        <table className="doc-table">
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const isHeader = block.header && ri === 0;
                  const Cell = (isHeader ? "th" : "td") as "th" | "td";
                  return <Cell key={ci}><InlineMath text={cell} /></Cell>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "formula": {
      let html: string;
      try {
        html = temml.renderToString(block.latex, { displayMode: !!block.display, throwOnError: true });
      } catch {
        html = `<code class="formula-fallback">${escapeHtml(block.latex)}</code>`;
      }
      const Tag = block.display ? "div" : "span";
      return <Tag className={block.display ? "formula-display" : "formula-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case "figure":
      return (
        <figure>
          <img src={block.imageDataUrl} alt={block.caption || "figure"} />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
  }
}
