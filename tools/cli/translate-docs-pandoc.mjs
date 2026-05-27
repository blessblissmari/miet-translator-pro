// Vision-driven high-quality DOCX pipeline.
//
//   1. Render every page to a 200-DPI PNG (pdftoppm).
//   2. Extract embedded raster figures (pdfimages -p).
//   3. MiMo vision: page-by-page translate to Russian Markdown with
//      {{FIGURE_N}} tokens.  Each page is verified against the source
//      and retranslated once if anything was missed (docPlannerVision).
//   4. Figure handling per token:
//        - prefer the matching embedded raster (pdfimages)
//        - else crop the page render (fallback)
//        - if REDRAW=1 and the figure looks like a chart, regenerate it
//          with matplotlib via redrawFigure (Python in subprocess).
//   5. Russian post-polish (ruPolish + glossary + math sanitize).
//   6. Pandoc Markdown → DOCX with native OMML equations.
//
// Env:
//   MIMO_API_KEY (required)
//   MODEL=mimo-v2.5  (default; must be vision-capable)
//   OUT_DIR=./outputs
//   REDRAW=1  enable matplotlib regeneration of figures
//   VERIFY=1  enable Pass-2 verify+retry (default ON)

import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractRasterImages, renderPages } from "./lib/extractImages.mjs";
import { translatePagesVision } from "./lib/docPlannerVision.mjs";
import { redrawFigure } from "./lib/redrawFigure.mjs";
import { polishRu } from "./lib/ruPolish.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) { console.error("MIMO_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "mimo-v2.5";
const REDRAW = process.env.REDRAW === "1";
const VERIFY = process.env.VERIFY !== "0";
const CONC = parseInt(process.env.CONCURRENCY || "2", 10);

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => c === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exit ${c}: ${err}`)));
  });
}

async function classifyFigureKind(imgPath) {
  // Lightweight aspect-ratio heuristic: tall narrow strips are likely
  // signal plots, very wide thin ones are time-series, square-ish are
  // diagrams / pole-zero / schematics.  Used to bias REDRAW toggle.
  try {
    const { out } = await runCmd("identify", ["-format", "%w %h", imgPath]);
    const [w, h] = out.trim().split(/\s+/).map(Number);
    if (!w || !h) return "unknown";
    const ar = w / h;
    if (ar > 3) return "wide_signal";
    if (ar < 0.5) return "tall";
    return "general";
  } catch { return "unknown"; }
}

function substituteFigures(md, pageNum, embedded, pageRender, figDir) {
  // Replace {{FIGURE_N}} tokens with markdown image refs.
  // - Use embedded raster N-1 first (raster index inside page).
  // - Fall back to whole-page render (collapsed: same path only embedded once).
  const usedPaths = new Set();
  const out = md.replace(/\{\{FIGURE_(\d+)\}\}/g, (_m, nStr) => {
    const idx = parseInt(nStr, 10) - 1;
    let p = embedded[idx]?.path;
    if (!p) p = pageRender;
    if (!p) return "";
    if (usedPaths.has(p)) return "";
    usedPaths.add(p);
    // Make path relative to figDir so pandoc finds it via --resource-path
    return `\n\n![](${path.relative(figDir, p).replace(/\\/g, "/")})\n\n`;
  });
  return out;
}

function purgeLatexMath(md) {
  // Pandoc fails on a few constructs; normalize them.
  return md
    .replace(/\\overrightarrow/g, "\\vec")
    .replace(/\\xrightarrow/g, "\\to")
    // Strip dangling text-mode \text{Re} that pandoc miscompiles
    .replace(/\\text\{([^{}]*?)\}/g, "\\mathrm{$1}");
}

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-docs-pandoc.mjs <pdf...>"); process.exit(1); }

const outDir = process.env.OUT_DIR || "./outputs";
await mkdir(outDir, { recursive: true });
const report = [];

for (const pdfPath of inputs) {
  const t0 = Date.now();
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} ===`);
  try {
    const figDir = path.join(outDir, "figures", base, "figs");
    const pagesDir = path.join(outDir, "figures", base, "pages");

    // Pass 1a: render every page to PNG at 200 DPI.
    process.stderr.write("  rendering pages…");
    const rendered = await renderPages(pdfPath, pagesDir, 144);
    const pageCount = Object.keys(rendered).length;
    console.log(` ${pageCount} pages`);

    // Pass 1b: extract embedded raster figures.
    process.stderr.write("  extracting embedded figures…");
    const embedded = await extractRasterImages(pdfPath, figDir);
    const totalEmb = Object.values(embedded).reduce((a, b) => a + b.length, 0);
    console.log(` ${totalEmb} embedded`);

    // Optional Pass 1c: redraw raster figures with matplotlib via vision.
    if (REDRAW && totalEmb > 0) {
      process.stderr.write(`  redrawing figures with matplotlib (${MODEL})…`);
      const redrawDir = path.join(outDir, "figures-redrawn", base);
      await mkdir(redrawDir, { recursive: true });
      let done = 0;
      for (const [pn, figs] of Object.entries(embedded)) {
        for (const f of figs) {
          const kind = await classifyFigureKind(f.path);
          if (kind === "tall" || kind === "wide_signal" || kind === "general") {
            try {
              const redrawn = await redrawFigure({
                apiKey, model: MODEL,
                sourcePath: f.path, workDir: redrawDir, retries: 1,
              });
              if (redrawn) { f.path = redrawn; f.redrawn = true; }
            } catch {}
          }
          done++;
          process.stderr.write(`\r  redrawing ${done}/${totalEmb} figures…`);
        }
      }
      const replaced = Object.values(embedded).flat().filter(f => f.redrawn).length;
      console.log(`\n  ✓ redrew ${replaced}/${totalEmb} figures`);
    }

    // Pass 2: vision translation per page, with verify+retry.
    const pageInputs = [];
    for (let i = 1; i <= pageCount; i++) pageInputs.push({ pageImagePath: rendered[i] });
    process.stderr.write(`  vision translation (${MODEL}, verify=${VERIFY ? "on" : "off"})…`);
    const mdPerPage = await translatePagesVision(pageInputs, {
      apiKey, model: MODEL, verify: VERIFY, concurrency: CONC,
      onProgress: (d, t) => process.stderr.write(`\r  translated ${d}/${t}…`),
    });
    console.log();

    // Pass 3: substitute figure tokens + post-polish.
    const fullPages = mdPerPage.map((md, i) => {
      const pn = i + 1;
      const subbed = substituteFigures(md, pn, embedded[pn] || [], rendered[pn], figDir);
      const polished = polishRu(sanitizeLatexMath(purgeLatexMath(subbed)));
      return polished.trim();
    });

    const full = `# ${base}\n\n` + fullPages.join("\n\n---\n\n");
    const mdPath = path.join(outDir, `${base}.md`);
    await writeFile(mdPath, full, "utf8");

    // Pass 4: pandoc → DOCX with OMML.
    const docxPath = path.join(outDir, `${base}_ru.docx`);
    await runCmd("pandoc", [
      mdPath, "-o", docxPath,
      "--from", "markdown+tex_math_dollars+pipe_tables+raw_attribute",
      "--to", "docx",
      "--standalone",
      `--resource-path=${figDir}:${pagesDir}:${path.dirname(figDir)}:${outDir}`,
    ]);

    const buf = await readFile(docxPath);
    const ms = Date.now() - t0;
    console.log(`  ✓ ${docxPath}  (${(ms / 1000).toFixed(1)}s, ${buf.length} bytes)`);
    report.push({ file: base, status: "ok", ms, bytes: buf.length });
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    report.push({ file: base, status: "error", err: e.message });
  }
}

console.log("\n--- summary ---");
for (const r of report) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.file}  ${r.err || `${(r.ms / 1000).toFixed(1)}s`}`);
