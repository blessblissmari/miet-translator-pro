import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, LevelFormat,
} from "docx";
import JSZip from "jszip";
import { latexToOmml } from "./latexOmml";
import { dataUrlToUint8 as dataUrlToBytes, dataUrlMime } from "./imageOps";
import type { DocPlan, DocBlock } from "./types";

/**
 * Map a data URL MIME to docx ImageRun's `type` field.
 * docx@9 supports: "png" | "jpg" | "gif" | "bmp" | "svg". SVG requires a
 * fallback raster, which we don't have, so we treat any SVG as PNG and let
 * Word handle the bytes.
 */
function imageType(mime: string): "png" | "jpg" | "gif" | "bmp" {
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/bmp") return "bmp";
  return "png";
}

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      // naturalWidth/Height are the truth; .width can be 0 before layout
      const w = img.naturalWidth || img.width || 480;
      const h = img.naturalHeight || img.height || 360;
      resolve({ width: w, height: h });
    };
    img.onerror = () => resolve({ width: 480, height: 360 });
    img.src = dataUrl;
  });
}

/**
 * Workaround: docx@9 doesn't expose a public OMML element, but Paragraph accepts
 * a ConcreteHierarchyElement-like child via constructor.children. We use a small
 * "raw" wrapper that emits arbitrary XML via the docx import-export hook below.
 *
 * Simpler alternative used here: render formulas as italicized monospace text
 * carrying the LaTeX source AND a hidden OMML run is appended via post-processing
 * on the packed file.
 *
 * For now, we render formulas as text in a distinctive style; OMML embedding is
 * applied post-pack on the .docx file by direct XML injection.
 */

interface FormulaMarker { id: string; latex: string; display: boolean; }

/** Split a text run by $...$ (inline) and $$...$$ (display-inside-paragraph) markers and
 *  emit TextRuns interleaved with formula-marker placeholders. */
function runsWithMath(text: string, formulas: FormulaMarker[], opts: { bold?: boolean } = {}): TextRun[] {
  const out: TextRun[] = [];
  // Match $$...$$ first (greedy on inner), then $...$
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const seg = text.slice(last, m.index);
      if (seg) out.push(new TextRun({ text: seg, bold: opts.bold }));
    }
    const isDisplay = !!m[1];
    const latex = (m[1] || m[2] || "").trim();
    const id = `OMMLMARK_${formulas.length.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    formulas.push({ id, latex, display: isDisplay });
    out.push(new TextRun({ text: id, font: "Cambria Math" }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), bold: opts.bold }));
  if (out.length === 0) out.push(new TextRun({ text, bold: opts.bold }));
  return out;
}

export async function buildDocx(plan: DocPlan): Promise<Blob> {
  const formulaMarkers: FormulaMarker[] = [];
  const children: (Paragraph | Table)[] = [];

  if (plan.title?.trim()) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: plan.title, bold: true, size: 36 })],
    }));
  }

  for (const block of plan.blocks) {
    children.push(...(await blockToElements(block, formulaMarkers)));
  }

  const doc = new Document({
    creator: "MIET Translator",
    title: plan.title || "Document",
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 28 }, // 14pt
          paragraph: { spacing: { line: 360, after: 120 } }, // 1.5 line
        },
        heading1: {
          run: { font: "Times New Roman", size: 32, bold: true },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading2: {
          run: { font: "Times New Roman", size: 28, bold: true },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        heading3: {
          run: { font: "Times New Roman", size: 26, bold: true, italics: true },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
              },
            },
          ],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4 in twips
          margin: {
            top: 1134,    // 20 mm
            bottom: 1134, // 20 mm
            left: 1701,   // 30 mm (left bind — ГОСТ)
            right: 850,   // 15 mm
          },
        },
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  if (formulaMarkers.length === 0) return blob;
  return injectOmmlIntoDocx(blob, formulaMarkers);
}

async function blockToElements(block: DocBlock, formulas: FormulaMarker[]): Promise<(Paragraph | Table)[]> {
  switch (block.type) {
    case "table": {
      const rows = block.rows.map((row, ri) => new TableRow({
        children: row.map(cell => new TableCell({
          children: [new Paragraph({
            children: runsWithMath(cell, formulas, { bold: !!(block.header && ri === 0) }),
          })],
        })),
      }));
      const border = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      })];
    }
    case "h1":
      return [new Paragraph({ heading: HeadingLevel.HEADING_1, children: runsWithMath(block.text, formulas, { bold: true }) })];
    case "h2":
      return [new Paragraph({ heading: HeadingLevel.HEADING_2, children: runsWithMath(block.text, formulas, { bold: true }) })];
    case "h3":
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, children: runsWithMath(block.text, formulas, { bold: true }) })];
    case "para":
      return [new Paragraph({ children: runsWithMath(block.text, formulas) })];
    case "list":
      return block.items.map((it) => new Paragraph({
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: "ordered", level: 0 } : undefined,
        children: runsWithMath(it, formulas),
      }));
    case "formula": {
      const id = `OMMLMARK_${formulas.length.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      formulas.push({ id, latex: block.latex, display: !!block.display });
      return [new Paragraph({
        alignment: block.display ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: id, font: "Cambria Math" })],
      })];
    }
    case "figure": {
      const bytes = await dataUrlToBytes(block.imageDataUrl);
      const dims = await imageDimensions(block.imageDataUrl);
      const type = imageType(dataUrlMime(block.imageDataUrl));
      const maxW = 480;
      const scale = dims.width > maxW ? maxW / dims.width : 1;
      const out: Paragraph[] = [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({
            data: bytes,
            type,
            transformation: { width: Math.round(dims.width * scale), height: Math.round(dims.height * scale) },
          })],
        }),
      ];
      if (block.caption) {
        out.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: block.caption, italics: true, size: 20 })],
        }));
      }
      return out;
    }
  }
}

/** After docx is packed, replace each text marker `OMMLMARK_xxx` in
 *  word/document.xml with an actual <m:oMath> block.
 *
 *  Display formulas: also wrap in <m:oMathPara> so Word centers them.
 *  Inline formulas:  drop the <m:oMath> in place of the <w:r> placeholder.
 */
async function injectOmmlIntoDocx(blob: Blob, markers: FormulaMarker[]): Promise<Blob> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) return blob;
  let xml = await docXmlFile.async("string");

  for (const m of markers) {
    const omml = latexToOmml(m.latex, m.display);
    const id = escapeRegex(m.id);
    // The marker lives inside a <w:r>...<w:t>OMMLMARK_xxx</w:t>...</w:r>.
    // We use a non-greedy match anchored to the marker text and bounded by the
    // nearest enclosing </w:r>. (?:(?!</w:r>)[\s\S])*? keeps us inside one run.
    const runRe = new RegExp(`<w:r\\b(?:(?!</w:r>)[\\s\\S])*?${id}(?:(?!</w:r>)[\\s\\S])*?</w:r>`, "g");
    const replaced = xml.replace(runRe, omml);
    if (replaced === xml) {
      // Marker not found — likely the docx packer collapsed our run differently.
      // Fall back to plain-text marker replacement so we don't leave OMMLMARK_xxx
      // visible in the output.
      xml = xml.replace(new RegExp(id, "g"), escapeXml(m.latex));
    } else {
      xml = replaced;
    }
  }

  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "blob" });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
