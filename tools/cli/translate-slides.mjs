// Translate one or more PDFs into PPTX (Russian, MIET template).
//
// Usage: node translate-slides.mjs <pdf...>
//
// Env: MIMO_API_KEY
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { extractPdf, aspectKind } from "./lib/extractPdf.mjs";
import { translateSlides } from "./lib/slidePlanner.mjs";
import { buildPptx } from "./lib/buildPptx.mjs";
import { extractRasterImages } from "./lib/extractImages.mjs";
import { redrawAll } from "./lib/redrawFigure.mjs";
import { cropFiguresForPages } from "./lib/figureCrop.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) { console.error("MIMO_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "mimo-v2.5-pro";

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-slides.mjs <pdf...>"); process.exit(1); }

const outDir = process.env.OUT_DIR || "./outputs";
await mkdir(outDir, { recursive: true });

const report = [];

for (const pdfPath of inputs) {
  const t0 = Date.now();
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} ===`);
  let row = { file: base, status: "ok", pages: 0, ms: 0, err: null };
  try {
    const pages = await extractPdf(pdfPath);
    row.pages = pages.length;
    console.log(`  pages=${pages.length}  aspectKind=${aspectKind(pages)}`);

    const figDir = path.join(outDir, "figures", base);
    const images = await extractRasterImages(pdfPath, figDir);
    const totalImgs = Object.values(images).reduce((a, b) => a + b.length, 0);
    if (totalImgs) console.log(`  extracted ${totalImgs} embedded figures`);

    let figs = images;
    if (process.env.REDRAW === "1" && totalImgs) {
      const redrawModel = process.env.REDRAW_MODEL || "mimo-v2.5";
      process.stdout.write(`  redrawing ${totalImgs} figures with ${redrawModel}…`);
      let dn = 0;
      figs = await redrawAll({
        apiKey,
        model: redrawModel,
        imagesByPage: images,
        workDir: path.join(outDir, "figures-redrawn", base),
        concurrency: 3,
        onProgress: (d, t) => { dn = d; process.stdout.write(`\r  redrawing ${d}/${t} figures…`); },
      });
      const replaced = Object.values(figs).flat().filter(f => f.redrawn).length;
      console.log(`\n  ✓ redrew ${replaced}/${totalImgs} figures (${totalImgs - replaced} kept original)`);
    }

    if (process.env.CROP_VECTOR === "1") {
      const totalPages = pages.length;
      const cropPages = [];
      for (let i = 1; i <= totalPages; i++) {
        if (!figs[i] || figs[i].length === 0) cropPages.push(i);
      }
      if (cropPages.length) {
        const FIG_HINT = /(shown\s+(below|in)|the\s+figure\b|plot|graph|magnitude\s+response|frequency\s+response|impulse\s+response|pole-zero|зависимость|показано|приведе)/i;
        const filtered = cropPages.filter(pn => {
          const t = pages.find(p => p.index + 1 === pn)?.text || "";
          return FIG_HINT.test(t);
        });
        if (filtered.length === 0) {
          console.log("  no plot hints in page text — skipping vector crop");
        } else {
          console.log(`  detecting vector figures on ${filtered.length}/${cropPages.length} hinted pages…`);
          const cropDir = path.join(outDir, "figures-vector", base);
          const crops = await cropFiguresForPages({
            apiKey, pdfPath, pages: filtered, workDir: cropDir,
            onProgress: (d, t, pn) => process.stdout.write(`\r  detecting figures ${d}/${t} (page ${pn})…`),
          });
          const found = Object.keys(crops).length;
          console.log(`\n  ✓ found ${found} vector figures (no pdfimages raster)`);
          for (const [pn, p] of Object.entries(crops)) {
            figs[pn] = [{ path: p, width: 0, height: 0, vector: true }];
          }
        }
      }
    }

    const slides = await translateSlides({
      apiKey,
      model: MODEL,
      pages,
      images: figs,
      concurrency: 5,
      onProgress: (d, t) => process.stdout.write(`\r  translated ${d}/${t}…`),
    });
    console.log();
    const buf = await buildPptx(slides);
    const out = path.join(outDir, `${base}_ru.pptx`);
    await writeFile(out, buf);
    row.ms = Date.now() - t0;
    console.log(`  ✓ ${out}  (${(row.ms / 1000).toFixed(1)}s, ${buf.length} bytes)`);
  } catch (e) {
    row.status = "error";
    row.err = e?.message || String(e);
    row.ms = Date.now() - t0;
    console.error(`  ✗ ${row.err}`);
  }
  report.push(row);
}

console.log("\n--- summary ---");
for (const r of report) {
  console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.file}  ${r.pages}p  ${(r.ms / 1000).toFixed(1)}s  ${r.err || ""}`);
}
