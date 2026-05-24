import type { ExtractedDoc, ExtractedPage, ExtractedImage } from "./types";

interface TextItem { str: string; transform: number[]; height: number; width: number; }

/** Extract a PDF's pages with text + bounding boxes + embedded raster images. */
export async function extractPdf(
  file: File,
  onProgress?: (page: number, total: number) => void,
  renderScale = 1.5,
): Promise<ExtractedDoc> {
  const pdfjsLib = await (await import("./pdfjs")).getPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: ExtractedPage[] = [];
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const pageH = baseViewport.height;

    // Probe text first to decide render scale (sparse text → likely scan/handwriting → render hi-res)
    const tc = await page.getTextContent();
    const items = tc.items as TextItem[];
    const probedText = items.map(it => it.str).join("").trim();
    const isSparse = probedText.length < 30;

    // Choose scale, then cap so the canvas longest side stays ≤ 2200 px. This
    // keeps OCR detail high but bounds memory + the resulting data URL size.
    let scale = isSparse ? Math.max(2.5, renderScale) : renderScale;
    const longestAtScale = Math.max(baseViewport.width, baseViewport.height) * scale;
    const MAX_RENDER_DIM = 2200;
    if (longestAtScale > MAX_RENDER_DIM) {
      scale = MAX_RENDER_DIM / Math.max(baseViewport.width, baseViewport.height);
    }
    const viewport = page.getViewport({ scale });

    // Render full page → fallback raster (used for vision-OCR fallback and previews)
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Always JPEG: pages are mostly text on white — JPEG q=0.85 yields 5–10× smaller
    // payload than PNG with no perceptible loss in OCR. Sparse pages get higher
    // quality since handwriting strokes are sensitive to JPEG ringing.
    const imageDataUrl = canvas.toDataURL("image/jpeg", isSparse ? 0.9 : 0.82);
    const lines: Array<{ text: string; x: number; y: number; w: number; h: number; fontSize: number }> = [];
    // PDF y is from bottom; convert to top-origin so it's intuitive.
    // Group items by Y (rows of glyphs that share a baseline).
    const grouped: Array<{ y: number; items: TextItem[] }> = [];
    const TOL = 2;
    for (const it of items) {
      const yBottom = it.transform[5];
      const yTop = pageH - yBottom;
      let bucket = grouped.find(g => Math.abs(g.y - yTop) <= TOL);
      if (!bucket) { bucket = { y: yTop, items: [] }; grouped.push(bucket); }
      bucket.items.push(it);
    }
    grouped.sort((a, b) => a.y - b.y);

    // Build line objects (x-sorted within each row).
    interface Line { text: string; x: number; y: number; w: number; h: number; fontSize: number }
    const rowLines: Line[] = [];
    for (const g of grouped) {
      g.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const text = g.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const xs = g.items.map(it => it.transform[4]);
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs.map((x, idx) => x + g.items[idx].width));
      const fontSize = Math.max(...g.items.map(it => it.height || 10));
      rowLines.push({ text, x: xMin, y: g.y, w: xMax - xMin, h: fontSize, fontSize });
    }

    // Detect 2-column layout and re-order lines into reading order. Most academic
    // papers and textbooks use 2 columns; a naive top-to-bottom sort produces
    // zigzag text that breaks translation. We detect columns from the histogram
    // of line start-X values and split the page at the natural gap.
    const ordered = reorderByColumns(rowLines, baseViewport.width);
    lines.push(...ordered);

    // Embedded raster images
    const images = await extractImages(pdfjsLib, page, pageH).catch(() => []);

    pages.push({
      index: i - 1,
      text: lines.map(l => l.text).join("\n"),
      imageDataUrl,
      width: baseViewport.width,
      height: pageH,
      lines,
      images,
    });
    onProgress?.(i, doc.numPages);
  }
  return { pages, meta: { title: info.Title, author: info.Author } };
}

interface PdfPageWithObjs {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  commonObjs: { get(name: string, cb: (obj: unknown) => void): void; has(name: string): boolean };
  objs: { get(name: string, cb: (obj: unknown) => void): void; has(name: string): boolean };
  getViewport(opts: { scale: number }): { transform: number[] };
}

async function extractImages(pdfjsLib: typeof import("pdfjs-dist"), page: unknown, pageH: number): Promise<ExtractedImage[]> {
  const p = page as PdfPageWithObjs;
  const ops = await p.getOperatorList();
  const OPS = pdfjsLib.OPS as unknown as Record<string, number>;
  const PAINT_IMG = OPS.paintImageXObject ?? 85;
  const PAINT_IMG_INLINE = OPS.paintInlineImageXObject ?? 86;
  const TRANSFORM = OPS.transform ?? 12;
  const SAVE = OPS.save ?? 10;
  const RESTORE = OPS.restore ?? 11;

  const out: ExtractedImage[] = [];
  // Track CTM stack
  const stack: number[][] = [[1, 0, 0, 1, 0, 0]];
  const cur = () => stack[stack.length - 1];
  const mul = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === SAVE) stack.push([...cur()]);
    else if (fn === RESTORE) { if (stack.length > 1) stack.pop(); }
    else if (fn === TRANSFORM) {
      stack[stack.length - 1] = mul(cur(), args as number[]);
    } else if (fn === PAINT_IMG) {
      // args[0] is a named XObject reference (string like "img_p4_1")
      const name = args[0];
      if (typeof name !== "string") continue; // not a named ref → skip
      const ctm = cur();
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      const yPdf = ctm[5];
      const yTop = pageH - (yPdf + h);

      let obj: unknown;
      try { obj = await getObj(p, name); } catch { continue; }
      if (!obj) continue;
      const oo = obj as { width?: number; height?: number };
      if ((oo.width ?? 0) < 24 || (oo.height ?? 0) < 24) continue;
      let dataUrl: string | null;
      try { dataUrl = await imageObjectToDataUrl(obj); } catch { continue; }
      if (!dataUrl) continue;
      out.push({ dataUrl, y: yTop, w, h });
    } else if (fn === PAINT_IMG_INLINE) {
      // Inline image: args[0] is the image data directly (not a name ref).
      const img = args[0];
      if (!img || typeof img !== "object") continue;
      const ctm = cur();
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      const yPdf = ctm[5];
      const yTop = pageH - (yPdf + h);
      const oo = img as { width?: number; height?: number };
      if ((oo.width ?? 0) < 24 || (oo.height ?? 0) < 24) continue;
      let dataUrl: string | null;
      try { dataUrl = await imageObjectToDataUrl(img); } catch { continue; }
      if (!dataUrl) continue;
      out.push({ dataUrl, y: yTop, w, h });
    }
  }
  // Sort top-to-bottom
  out.sort((a, b) => a.y - b.y);
  return out;
}

function getObj(p: PdfPageWithObjs, name: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const try1 = () => {
      try {
        if (p.objs.has(name)) { p.objs.get(name, (o) => resolve(o)); return true; }
      } catch { /* ignore */ }
      return false;
    };
    const try2 = () => {
      try {
        if (p.commonObjs.has(name)) { p.commonObjs.get(name, (o) => resolve(o)); return true; }
      } catch { /* ignore */ }
      return false;
    };
    if (try1()) return;
    if (try2()) return;
    // Fallback: get without has — pdfjs callbacks resolve once available
    try { p.objs.get(name, (o) => resolve(o)); }
    catch { resolve(null); }
  });
}

interface PdfImageObject {
  width?: number;
  height?: number;
  bitmap?: ImageBitmap;
  data?: Uint8ClampedArray | Uint8Array;
  kind?: number;
}

async function imageObjectToDataUrl(obj: unknown): Promise<string | null> {
  const o = obj as PdfImageObject;
  if (!o) return null;
  const w = o.width ?? 0;
  const h = o.height ?? 0;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (o.bitmap) {
    ctx.drawImage(o.bitmap, 0, 0);
    return canvas.toDataURL("image/png");
  }
  if (o.data) {
    const bytes = o.data;
    const id = ctx.createImageData(w, h);
    // pdfjs image kinds: 1 = GRAYSCALE 8bpc, 2 = RGB 8bpc, 3 = RGBA 8bpc
    const kind = o.kind ?? 2;
    let p = 0;
    if (kind === 1) {
      for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i];
        id.data[p++] = v; id.data[p++] = v; id.data[p++] = v; id.data[p++] = 255;
      }
    } else if (kind === 2) {
      for (let i = 0; i < bytes.length; i += 3) {
        id.data[p++] = bytes[i]; id.data[p++] = bytes[i + 1]; id.data[p++] = bytes[i + 2]; id.data[p++] = 255;
      }
    } else {
      for (let i = 0; i < bytes.length; i++) id.data[p++] = bytes[i];
    }
    ctx.putImageData(id, 0, 0);
    return canvas.toDataURL("image/png");
  }
  return null;
}



interface Line { text: string; x: number; y: number; w: number; h: number; fontSize: number }

/**
 * Re-order page lines into natural reading order, handling 2-column layouts.
 *
 * Heuristic:
 *   1. Compute the maximum line right-edge (most lines stop at the column edge).
 *      Look for a vertical gap in the X-distribution of line starts.
 *   2. If a substantial fraction of lines start in the right half of the page,
 *      split into "left column" + "right column" at the median gap location.
 *   3. Lines wider than ~70% of page width are kept as full-width (e.g.
 *      headings, figure captions, page-spanning equations) and inserted at
 *      their Y position to preserve their flow with surrounding text.
 *
 * For single-column documents the function returns lines sorted by Y, identical
 * to the previous behavior.
 */
function reorderByColumns(lines: Line[], pageWidth: number): Line[] {
  if (lines.length < 6) return lines.sort((a, b) => a.y - b.y);

  const mid = pageWidth / 2;
  const fullWidthThreshold = pageWidth * 0.62;
  const rightHalfStart = pageWidth * 0.45;

  let leftCount = 0;
  let rightCount = 0;
  let fullCount = 0;
  for (const ln of lines) {
    if (ln.w >= fullWidthThreshold) { fullCount++; continue; }
    if (ln.x < rightHalfStart) leftCount++;
    else rightCount++;
  }
  // Need a meaningful right-column population to call it 2-column
  const total = leftCount + rightCount;
  if (total === 0 || rightCount / total < 0.20 || leftCount / total < 0.20) {
    return lines.sort((a, b) => a.y - b.y);
  }

  // Two columns confirmed. Bucket each line; full-width lines act as section
  // separators that flush both columns at their Y.
  const sorted = lines.slice().sort((a, b) => a.y - b.y);
  const out: Line[] = [];
  let leftBuf: Line[] = [];
  let rightBuf: Line[] = [];
  const flush = () => {
    out.push(...leftBuf);
    out.push(...rightBuf);
    leftBuf = [];
    rightBuf = [];
  };
  for (const ln of sorted) {
    if (ln.w >= fullWidthThreshold) {
      flush();
      out.push(ln);
      continue;
    }
    if (ln.x < mid) leftBuf.push(ln);
    else rightBuf.push(ln);
  }
  flush();
  // Suppress unused-var hint
  void fullCount;
  return out;
}
