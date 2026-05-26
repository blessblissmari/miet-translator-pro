// Vision-based high-quality DOCX pipeline:
//   PDF → render every page to PNG → MiMo vision reads page (formulas,
//   graphs, captions) → returns Russian Markdown with {{FIGURE_N}}
//   tokens → substitute with embedded raster figures (or page render
//   crop fallback) → concat → pandoc → DOCX with native OMML math.
//
// Default model is mimo-v2.5 (vision-capable). Vector graphics and
// formulas drawn as PDF paths are translated correctly because the
// model SEES the page, not just the extracted text stream.
//
// Usage: node translate-docs-pandoc.mjs <pdf...>

import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractRasterImages } from "./lib/extractImages.mjs";
import { translatePagesVision } from "./lib/docPlannerVision.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";
import { polishRu } from "./lib/ruPolish.mjs";
import { redrawAll } from "./lib/redrawFigure.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) { console.error("MIMO_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "mimo-v2.5";

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-docs-pandoc.mjs <pdf...>"); process.exit(1); }

const outDir = process.env.OUT_DIR || "./outputs";
const mdDir = path.join(outDir, "markdown");
const pageRenderRoot = path.join(outDir, "pages");
await mkdir(outDir, { recursive: true });
await mkdir(mdDir, { recursive: true });
await mkdir(pageRenderRoot, { recursive: true });

function pdfPageCount(pdfPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("pdfinfo", [pdfPath]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("error", reject);
    p.on("close", () => {
      const m = out.match(/^Pages:\s*(\d+)/m);
      if (!m) reject(new Error("pdfinfo: no Pages line")); else resolve(Number(m[1]));
    });
  });
}

function renderPage(pdfPath, pageNum, outPath, dpi = 170) {
  return new Promise((resolve, reject) => {
    const prefix = outPath.replace(/\.png$/, "");
    const p = spawn("pdftoppm", [
      "-png", "-r", String(dpi),
      "-f", String(pageNum), "-l", String(pageNum),
      "-singlefile",
      pdfPath, prefix,
    ]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(outPath) : reject(new Error(`pdftoppm exit ${code}: ${err}`)));
  });
}

function runPandoc(mdPath, docxPath, resourcePath) {
  return new Promise((resolve, reject) => {
    const args = [
      mdPath,
      "-f", "markdown+tex_math_dollars+tex_math_single_backslash+pipe_tables+raw_attribute",
      "--to", "docx",
      "--standalone",
      "--resource-path=" + resourcePath,
      "-o", docxPath,
    ];
    const p = spawn("pandoc", args);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`pandoc exit ${code}: ${err}`)));
  });
}

// Replace {{FIGURE_N}} tokens with markdown image refs.  Order:
// 1. real embedded raster figures for this page (in extraction order),
// 2. then the page-render fallback for any unmatched indices.
function substituteFigures(md, pageIdx, embeddedFigs, pageRenderPath) {
  const refs = [];
  for (const f of embeddedFigs) refs.push({ path: f.path, kind: "embedded" });
  if (pageRenderPath) refs.push({ path: pageRenderPath, kind: "page" });

  const used = new Set();
  let hadTokens = false;
  const out = md.replace(/\{\{FIGURE_(\d+)\}\}/g, (_match, n) => {
    hadTokens = true;
    const i = Math.min(refs.length - 1, Math.max(0, Number(n) - 1));
    const ref = refs[i];
    if (!ref || used.has(ref.path)) return "";
    used.add(ref.path);
    const caption = ref.kind === "embedded"
      ? `Рис. ${n} (стр. ${pageIdx})`
      : `Стр. ${pageIdx} (оригинал)`;
    return `\n\n![${caption}](${ref.path})\n\n`;
  });

  if (!hadTokens && embeddedFigs.length > 0) {
    let tail = "";
    let n = 1;
    for (const f of embeddedFigs) {
      if (used.has(f.path)) continue;
      used.add(f.path);
      tail += `\n\n![Рис. ${n} (стр. ${pageIdx})](${f.path})\n\n`;
      n++;
    }
    return out + tail;
  }
  return out;
}

const report = [];
for (const pdfPath of inputs) {
  const t0 = Date.now();
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} ===`);
  try {
    // 1. Embedded raster figures (poppler).
    const figDir = path.join(outDir, "figures", base);
    const embedded = await extractRasterImages(pdfPath, figDir);
    const totalEmbedded = Object.values(embedded).reduce((a, b) => a + b.length, 0);
    if (totalEmbedded) console.log(`  extracted ${totalEmbedded} embedded raster figures`);

    let figsByPage = embedded;
    if (process.env.REDRAW && totalEmbedded > 0) {
      const redrawDir = path.join(outDir, "figures-redrawn", base);
      console.log(`  redrawing ${totalEmbedded} figures via vision…`);
      figsByPage = await redrawAll({
        apiKey, imagesByPage: embedded, workDir: redrawDir,
        onProgress: (d, t) => process.stderr.write(`\r  redrawing ${d}/${t}…`),
      });
      process.stderr.write("\n");
    }

    // 2. Render every page to a PNG (always — vision needs this).
    const pageCount = await pdfPageCount(pdfPath);
    console.log(`  pages=${pageCount}`);
    const pageDir = path.join(pageRenderRoot, base);
    await mkdir(pageDir, { recursive: true });
    const pageImages = [];
    for (let i = 1; i <= pageCount; i++) {
      const png = path.join(pageDir, `page-${String(i).padStart(3, "0")}.png`);
      await renderPage(pdfPath, i, png);
      pageImages.push({ pageImagePath: png });
    }

    // 3. Vision translation per page.
    let done = 0;
    const concurrency = Number(process.env.VISION_CONCURRENCY || 2);
    const sections = await translatePagesVision(pageImages, {
      apiKey, model: MODEL,
      concurrency,
      onProgress: () => {
        done++;
        process.stdout.write(`\r  translated ${done}/${pageImages.length}…`);
      },
    });
    console.log();

    // 4. Substitute figure tokens & concat.
    let md = `# ${base}\n\n`;
    for (let i = 0; i < sections.length; i++) {
      const pageIdx = i + 1;
      const sec = sections[i] || "";
      const subbed = substituteFigures(sec.trim(), pageIdx, figsByPage[pageIdx] || [], pageImages[i].pageImagePath);
      md += subbed + "\n\n";
      if (pageIdx < sections.length) {
        md += '\n\n```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```\n\n';
      }
    }
    md = polishRu(sanitizeLatexMath(md));

    const mdPath = path.join(mdDir, `${base}_ru.md`);
    await writeFile(mdPath, md, "utf8");
    const docxPath = path.join(outDir, `${base}_ru.docx`);
    await runPandoc(mdPath, docxPath, figDir);
    const docxBuf = await readFile(docxPath);
    const ms = Date.now() - t0;
    console.log(`  ✓ ${docxPath}  (${(ms / 1000).toFixed(1)}s, ${docxBuf.length} bytes)`);
    report.push({ file: base, status: "ok", pages: pageCount, ms });
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    report.push({ file: base, status: "error", err: e.message });
  }
}

console.log("\n--- summary ---");
for (const r of report) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.file}`);
