// Page-by-page text + image extraction from a PDF.
//
// Text: via pdfjs (preserves Y-coord line breaks).
// Images: via `pdfimages` (poppler) for embedded raster bitmaps, with
// a fallback to rendering the full page via `pdftoppm` when a page has
// no embedded raster but pdfjs reported visual content (vector graphics,
// drawn diagrams, equations).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += b.toString(); });
    p.stderr.on("data", (b) => { err += b.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
  });
}

/**
 * Extract embedded raster images from a PDF using `pdfimages -list -png`.
 * Returns a map: pageIndex (0-based) -> Array<{ buffer, ext, w, h }>.
 */
async function extractEmbeddedImages(pdfPath) {
  const dir = await mkdtemp(path.join(tmpdir(), "miet-pdfimg-"));
  try {
    // -list first (parsed), then export -png for raster + -j for jpeg passthrough.
    const { out: listOut } = await run("pdfimages", ["-list", pdfPath]);
    const listLines = listOut.split("\n").slice(2).filter((l) => l.trim());
    const meta = listLines.map((l) => {
      const cols = l.trim().split(/\s+/);
      // page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
      return {
        page: parseInt(cols[0], 10) - 1,
        idx: parseInt(cols[1], 10),
        type: cols[2],
        w: parseInt(cols[3], 10),
        h: parseInt(cols[4], 10),
      };
    }).filter((m) => Number.isFinite(m.page));

    const prefix = path.join(dir, "img");
    await run("pdfimages", ["-all", pdfPath, prefix]);
    const files = (await readdir(dir)).sort();

    const byPage = new Map();
    for (let i = 0; i < meta.length && i < files.length; i++) {
      const m = meta[i];
      const file = files[i];
      const buf = await readFile(path.join(dir, file));
      const ext = path.extname(file).slice(1).toLowerCase();
      // Skip CCITT masks and tiny thumbnails (likely backgrounds / decorations).
      if (m.w < 60 || m.h < 60) continue;
      if (!byPage.has(m.page)) byPage.set(m.page, []);
      byPage.get(m.page).push({ buffer: buf, ext, w: m.w, h: m.h });
    }
    return byPage;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Render a single PDF page to PNG via pdftoppm. Returns Uint8Array.
 */
async function renderPageToPng(pdfPath, pageIdx0, dpi = 110) {
  const dir = await mkdtemp(path.join(tmpdir(), "miet-pgrender-"));
  try {
    const prefix = path.join(dir, "p");
    const pageNum = pageIdx0 + 1;
    await run("pdftoppm", [
      "-png", "-r", String(dpi),
      "-f", String(pageNum), "-l", String(pageNum),
      pdfPath, prefix,
    ]);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png"));
    if (!files.length) return null;
    return await readFile(path.join(dir, files[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractPdf(pdfPath, opts = {}) {
  const { extractImages = true, fallbackPageRender = true } = opts;
  const buf = await readFile(pdfPath);
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(buf),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    })
    .promise;

  // Run image extraction in parallel with text loop.
  const imagesPromise = extractImages
    ? extractEmbeddedImages(pdfPath).catch((e) => {
        console.error("  pdfimages failed:", e.message);
        return new Map();
      })
    : Promise.resolve(new Map());

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
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
      if (it.hasEOL) cur += " ";
      else cur += " ";
      lastY = y;
    }
    if (cur.trim()) lines.push(cur.trim());
    const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    pages.push({ index: p - 1, text, width: vp.width, height: vp.height, images: [] });
  }

  const byPage = await imagesPromise;
  for (const page of pages) {
    page.images = byPage.get(page.index) || [];
  }

  // Fallback: if a page has no embedded raster images but has substantial
  // visual content (heuristic: short text relative to page size suggests
  // figures/equations as vector graphics), render the page itself.
  if (fallbackPageRender) {
    for (const page of pages) {
      const hasSubstantial = page.images.some(
        (im) => im.w >= 200 && im.h >= 200,
      );
      if (hasSubstantial) continue;
      try {
        const png = await renderPageToPng(pdfPath, page.index);
        if (png) {
          // Replace small/no images with the full page render — vector
          // graphics, equations, and diagrams come through this way.
          page.images = [{ buffer: png, ext: "png", w: 0, h: 0, isPageRender: true }];
        }
      } catch (e) {
        console.error(`  page ${page.index + 1} render failed:`, e.message);
      }
    }
  }

  return pages;
}

export function aspectKind(pages) {
  if (!pages.length) return "document";
  const w = pages[0].width, h = pages[0].height;
  return w / h > 1.2 ? "presentation" : "document";
}
