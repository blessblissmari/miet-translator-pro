import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { PdfPreview } from "./Preview";

export function OriginalPreview({
  blob,
  path,
}: {
  blob: Blob;
  path: string;
}) {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "pdf") return <PdfPreview blob={blob} />;
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "webp" ||
    ext === "gif" ||
    ext === "bmp"
  ) {
    return <ImageOnly blob={blob} />;
  }
  if (ext === "docx") return <DocxPreview blob={blob} />;
  if (ext === "pptx") return <PptxPreview blob={blob} />;
  return <RawTextPreview blob={blob} path={path} />;
}

function ImageOnly({ blob }: { blob: Blob }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="preview-pane">
      <img src={url} alt="" style={{ maxWidth: "100%" }} />
    </div>
  );
}

/* ──────────────────────────────────────────────
 * DOCX preview — render via mammoth as styled HTML
 * Mimics a Word page: A4 width, serif font, embedded images
 * ────────────────────────────────────────────── */
function DocxPreview({ blob }: { blob: Blob }) {
  const [html, setHtml] = useState<string>("");
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const mammoth: any = await import("mammoth/mammoth.browser.js");
        const buf = await blob.arrayBuffer();
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buf },
          {
            convertImage: mammoth.images.imgElement((img: any) =>
              img.read("base64").then((data: string) => ({
                src: `data:${img.contentType};base64,${data}`,
              })),
            ),
            styleMap: [
              "p[style-name='Title'] => h1.doc-title:fresh",
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
              "p[style-name='Quote'] => blockquote:fresh",
              "r[style-name='Strong'] => strong",
              "r[style-name='Emphasis'] => em",
            ],
            includeDefaultStyleMap: true,
          },
        );
        setHtml(result.value || "<p><em>(пустой документ)</em></p>");
      } catch (e: any) {
        setErr(e.message || String(e));
      }
    })();
  }, [blob]);

  if (err) return <div className="preview-pane"><pre className="raw-text">Не удалось прочитать DOCX: {err}</pre></div>;
  return (
    <div className="preview-pane docx-pane">
      <div className="word-page" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/* ──────────────────────────────────────────────
 * PPTX preview — parse slide XML and render as
 * absolutely-positioned shapes matching slide aspect ratio
 * ────────────────────────────────────────────── */
type Shape = {
  kind: "text" | "image";
  x: number; y: number; w: number; h: number; // EMU
  // text:
  paragraphs?: Array<{
    align?: "l" | "ctr" | "r" | "just";
    runs: Array<{ text: string; bold?: boolean; italic?: boolean; size?: number; color?: string; font?: string }>;
    bullet?: boolean;
    level?: number;
  }>;
  // image:
  imageUrl?: string;
  // common:
  fill?: string;
  rot?: number; // 60000 = 1deg
};

type Slide = {
  shapes: Shape[];
  bg?: string;
};

const EMU = 914400; // per inch

function PptxPreview({ blob }: { blob: Blob }) {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 9144000, h: 6858000 });
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const presXml = await zip.file("ppt/presentation.xml")?.async("string");
        if (presXml) {
          const m = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
          if (m) setSize({ w: parseInt(m[1]), h: parseInt(m[2]) });
        }

        const slideNames = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => {
            const an = parseInt(a.match(/slide(\d+)/)![1]);
            const bn = parseInt(b.match(/slide(\d+)/)![1]);
            return an - bn;
          });

        const out: Slide[] = [];
        for (const name of slideNames) {
          const xml = await zip.file(name)!.async("string");
          const relsName = name.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels";
          const relsXml = (await zip.file(relsName)?.async("string")) || "";
          const rels = parseRels(relsXml);
          const slide = await parseSlide(xml, rels, zip);
          out.push(slide);
        }
        setSlides(out);
      } catch (e: any) {
        setErr(e.message || String(e));
      }
    })();
  }, [blob]);

  if (err) return <div className="preview-pane"><pre className="raw-text">Не удалось прочитать PPTX: {err}</pre></div>;
  if (!slides) return <div className="preview-pane"><div className="raw-text">Загрузка…</div></div>;

  const aspect = size.w / size.h;
  return (
    <div className="preview-pane pptx-pane">
      {slides.map((s, i) => (
        <div key={i} className="ppt-slide-wrap">
          <div className="ppt-slide-num">{i + 1}</div>
          <div
            className="ppt-slide"
            style={{
              aspectRatio: `${aspect}`,
              background: s.bg || "#fff",
            }}
          >
            {s.shapes.map((shape, j) => (
              <ShapeBox key={j} shape={shape} slideW={size.w} slideH={size.h} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ShapeBox({ shape, slideW, slideH }: { shape: Shape; slideW: number; slideH: number }) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${(shape.x / slideW) * 100}%`,
    top: `${(shape.y / slideH) * 100}%`,
    width: `${(shape.w / slideW) * 100}%`,
    height: `${(shape.h / slideH) * 100}%`,
    overflow: "hidden",
  };
  if (shape.rot) style.transform = `rotate(${shape.rot / 60000}deg)`;
  if (shape.fill) style.background = shape.fill;

  if (shape.kind === "image") {
    return (
      <div style={style}>
        <img src={shape.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </div>
    );
  }
  return (
    <div style={style} className="ppt-text">
      {(shape.paragraphs || []).map((p, i) => (
        <div
          key={i}
          style={{
            textAlign:
              p.align === "ctr" ? "center" :
              p.align === "r" ? "right" :
              p.align === "just" ? "justify" : "left",
            paddingLeft: p.bullet ? `${(p.level ?? 0) * 1.2 + 0.8}em` : 0,
            textIndent: p.bullet ? "-0.8em" : 0,
          }}
        >
          {p.bullet && <span style={{ marginRight: "0.4em" }}>•</span>}
          {p.runs.map((r, j) => (
            <span
              key={j}
              style={{
                fontWeight: r.bold ? 700 : 400,
                fontStyle: r.italic ? "italic" : "normal",
                fontSize: `${((r.size || 1800) * 127) / slideH}cqh`,
                color: r.color ? `#${r.color}` : undefined,
                fontFamily: r.font || undefined,
              }}
            >
              {r.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<Relationship\s+([^/]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const id = /Id="([^"]+)"/.exec(attrs)?.[1];
    const target = /Target="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) out[id] = target;
  }
  return out;
}

async function parseSlide(
  xml: string,
  rels: Record<string, string>,
  zip: JSZip,
): Promise<Slide> {
  const shapes: Shape[] = [];

  // Background fill (basic)
  const bgM = xml.match(/<p:bg[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/);
  const bg = bgM ? `#${bgM[1]}` : undefined;

  // Iterate sp (text shapes) and pic (images) in order
  const blockRe = /<p:(sp|pic)\b[\s\S]*?<\/p:\1>/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(xml))) {
    const kind = bm[1] as "sp" | "pic";
    const block = bm[0];

    // xfrm
    const xfrm = block.match(/<a:xfrm([^>]*)>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!xfrm) continue;
    const rotAttr = /rot="(-?\d+)"/.exec(xfrm[1])?.[1];
    const x = parseInt(xfrm[2]);
    const y = parseInt(xfrm[3]);
    const w = parseInt(xfrm[4]);
    const h = parseInt(xfrm[5]);
    const rot = rotAttr ? parseInt(rotAttr) : 0;

    if (kind === "pic") {
      const rIdM = block.match(/<a:blip[^>]*r:embed="([^"]+)"/);
      if (rIdM) {
        const target = rels[rIdM[1]];
        if (target) {
          const path = "ppt/" + target.replace(/^\.\.\//, "");
          const file = zip.file(path);
          if (file) {
            const blob = await file.async("blob");
            const mime = path.endsWith(".png") ? "image/png"
              : path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg"
              : path.endsWith(".gif") ? "image/gif"
              : path.endsWith(".svg") ? "image/svg+xml"
              : "application/octet-stream";
            const url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: mime }));
            shapes.push({ kind: "image", x, y, w, h, rot, imageUrl: url });
          }
        }
      }
      continue;
    }

    // Text shape
    const fillM = block.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/);
    const fill = fillM ? `#${fillM[1]}` : undefined;

    const paragraphs: NonNullable<Shape["paragraphs"]> = [];
    const txBody = block.match(/<a:txBody[\s\S]*?<\/a:txBody>/)?.[0] || "";
    const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(txBody))) {
      const pBlock = pm[0];
      const pPr = pBlock.match(/<a:pPr([^/>]*)(\/>|>[\s\S]*?<\/a:pPr>)/);
      const algn = pPr ? /algn="([^"]+)"/.exec(pPr[0])?.[1] as Shape["paragraphs"] extends infer T ? T extends Array<infer U> ? U extends { align?: infer A } ? A : never : never : never : undefined;
      const lvl = pPr ? parseInt(/lvl="(\d+)"/.exec(pPr[0])?.[1] || "0") : 0;
      const hasBullet = pPr ? !/<a:buNone/.test(pPr[0]) && /<a:bu(Char|AutoNum|Font)/.test(pPr[0]) : false;

      const runs: Array<{ text: string; bold?: boolean; italic?: boolean; size?: number; color?: string; font?: string }> = [];
      const rRe = /<a:r\b[\s\S]*?<\/a:r>/g;
      let rm: RegExpExecArray | null;
      while ((rm = rRe.exec(pBlock))) {
        const rBlock = rm[0];
        const rPr = rBlock.match(/<a:rPr([^/>]*)(\/>|>[\s\S]*?<\/a:rPr>)/);
        const txt = (rBlock.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/)?.[1] || "")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        if (!txt) continue;
        const bold = rPr ? /b="1"/.test(rPr[0]) : false;
        const italic = rPr ? /i="1"/.test(rPr[0]) : false;
        const sz = rPr ? parseInt(/sz="(\d+)"/.exec(rPr[0])?.[1] || "0") : 0;
        const colorM = rBlock.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/);
        const fontM = rBlock.match(/<a:latin[^>]*typeface="([^"]+)"/);
        runs.push({
          text: txt,
          bold,
          italic,
          size: sz || undefined,
          color: colorM?.[1],
          font: fontM?.[1],
        });
      }
      // Line breaks
      if (/<a:br/.test(pBlock) && runs.length === 0) runs.push({ text: "" });
      if (runs.length > 0) paragraphs.push({
        align: algn as any,
        runs,
        bullet: hasBullet,
        level: lvl,
      });
    }

    if (paragraphs.length > 0) {
      shapes.push({ kind: "text", x, y, w, h, rot, fill, paragraphs });
    }
  }

  return { shapes, bg };
}

function RawTextPreview({ blob, path }: { blob: Blob; path: string }) {
  const [text, setText] = useState("Загрузка…");
  useEffect(() => {
    (async () => {
      try {
        setText(await blob.text());
      } catch (e) {
        setText("Не удалось прочитать: " + (e as Error).message);
      }
    })();
  }, [blob, path]);
  return (
    <div className="preview-pane">
      <pre className="raw-text">{text}</pre>
    </div>
  );
}
