// Per-page image extraction from a PDF.
//
// Returns a map: pageNum (1-indexed) -> [{ path, width, height, kind }]
//
// kind is "raster" for embedded bitmaps (extracted with pdfimages -p) or
// "rendered" for whole-page renders (pdftoppm), used as a fallback for pages
// that have vector-only figures.
//
// Tiny stencils (logos, decorative glyphs <120px) are filtered out.
import { spawn } from "node:child_process";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${stderr}`))));
  });
}

const MIN_DIM = 80;       // ignore raster images smaller than 80px on either side
const MIN_AREA = 8000;    // keep diagrams down to ~90x90 equivalent

async function imageDims(file) {
  // Use ImageMagick `identify` if available; fall back to PNG IHDR parsing.
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((res, rej) => {
      execFile("identify", ["-format", "%w %h", file], (err, stdout) => {
        if (err) return rej(err);
        const [w, h] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
        res({ width: w, height: h });
      });
    });
  } catch {
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(file);
    // PNG: bytes 16..23 are width/height big-endian uint32
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }
    return { width: 0, height: 0 };
  }
}

/**
 * Extract raster images per page.
 * @param {string} pdfPath
 * @param {string} outDir   target directory (created/cleared)
 */
export async function extractRasterImages(pdfPath, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  try {
    await run("pdfimages", ["-p", "-png", pdfPath, path.join(outDir, "img")]);
  } catch (e) {
    return {};
  }
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".png"));
  const byPage = {};
  for (const f of files) {
    const m = /^img-(\d+)-(\d+)\.png$/.exec(f);
    if (!m) continue;
    const pageNum = parseInt(m[1], 10);
    const idx = parseInt(m[2], 10);
    const fp = path.join(outDir, f);
    const { width, height } = await imageDims(fp);
    // Skip tiny stencils (likely glyphs or page-number decorations).
    if (width < MIN_DIM && height < MIN_DIM) continue;
    if (width * height < MIN_AREA) continue;
    if (!byPage[pageNum]) byPage[pageNum] = [];
    byPage[pageNum].push({ path: fp, idx, width, height, kind: "raster" });
  }
  return byPage;
}

/**
 * Render full pages to PNG (used when a slide has vector-only figures or for
 * appendix mode).
 */
export async function renderPages(pdfPath, outDir, dpi = 120) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await run("pdftoppm", ["-r", String(dpi), "-png", pdfPath, path.join(outDir, "page")]);
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
  const byPage = {};
  for (const f of files) {
    const m = /^page-(\d+)\.png$/.exec(f);
    if (!m) continue;
    const pageNum = parseInt(m[1], 10);
    byPage[pageNum] = path.join(outDir, f);
  }
  return byPage;
}

/** PNG file -> data URL string. */
export async function pngToDataUrl(filePath) {
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(filePath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}
