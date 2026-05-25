// Page-by-page text extraction from a PDF, preserving paragraph breaks heuristically.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";

export async function extractPdf(path) {
  const buf = await readFile(path);
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(buf),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    })
    .promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    // Build text preserving line breaks by Y coords.
    let lastY = null;
    const lines = [];
    let cur = "";
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(lastY - y) > 4) {
        if (cur.trim()) lines.push(cur.trim());
        cur = "";
      }
      cur += it.str;
      // pdfjs items already may end with space; ensure separation
      if (it.hasEOL) cur += " ";
      else cur += " ";
      lastY = y;
    }
    if (cur.trim()) lines.push(cur.trim());
    const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    pages.push({ index: p - 1, text, width: vp.width, height: vp.height });
  }
  return pages;
}

export function aspectKind(pages) {
  if (!pages.length) return "document";
  const w = pages[0].width, h = pages[0].height;
  return w / h > 1.2 ? "presentation" : "document";
}
