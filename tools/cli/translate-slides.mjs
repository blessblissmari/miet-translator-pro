// Translate one or more PDFs into PPTX (Russian, MIET template).
//
// Usage: node translate-slides.mjs <pdf...>
//
// Env: OPENROUTER_API_KEY_ONE
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { extractPdf, aspectKind } from "./lib/extractPdf.mjs";
import { translateSlides } from "./lib/slidePlanner.mjs";
import { buildPptx } from "./lib/buildPptx.mjs";

const apiKey = process.env.OPENROUTER_API_KEY_ONE;
if (!apiKey) { console.error("OPENROUTER_API_KEY_ONE not set"); process.exit(1); }
const MODEL = process.env.MODEL || "openai/gpt-oss-120b:free";

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

    const slides = await translateSlides({
      apiKey,
      model: MODEL,
      pages,
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
