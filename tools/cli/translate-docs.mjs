// Translate one or more PDFs into DOCX (Russian, ГОСТ academic style).
//
// Usage: node translate-docs.mjs <pdf...>
//
// Env: MIMO_API_KEY
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { extractPdf, aspectKind } from "./lib/extractPdf.mjs";
import { translateDocPages, parseMarkdownToBlocks } from "./lib/docPlanner.mjs";
import { buildDocxFromBlocks } from "./lib/buildDocx.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) {
  console.error("MIMO_API_KEY not set");
  process.exit(1);
}
const MODEL = process.env.MODEL || "mimo-v2.5-pro";

const outDir = process.env.OUT_DIR || "./outputs";
await mkdir(outDir, { recursive: true });

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-docs.mjs <pdf...>"); process.exit(1); }

for (const inp of inputs) {
  const name = path.basename(inp).replace(/\.[^.]+$/, "");
  const t0 = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    const pages = await extractPdf(inp);
    const kind = aspectKind(pages);
    console.log(`  pages=${pages.length} aspectKind=${kind}`);
    if (kind === "presentation") {
      console.log(`  ⚠ Looks like a presentation. Use translate-slides.mjs for ${inp}`);
      continue;
    }
    const markdowns = await translateDocPages(pages, {
      apiKey,
      model: MODEL,
      concurrency: 3,
      onProgress: (d, t) => process.stdout.write(`\r  translated ${d}/${t}…`),
    });
    process.stdout.write("\n");

    const allBlocks = [];
    let title;
    let figNum = 0;
    for (let i = 0; i < markdowns.length; i++) {
      const blocks = parseMarkdownToBlocks(markdowns[i]);
      if (i === 0 && !title && blocks.length && blocks[0].type === "h1") {
        title = blocks.shift().text;
      }
      allBlocks.push(...blocks);
      const pageImgs = pages[i].images || [];
      for (let k = 0; k < pageImgs.length; k++) {
        const img = pageImgs[k];
        figNum++;
        const caption = img.isPageRender
          ? `Стр. ${i + 1}`
          : (pageImgs.length === 1 ? `Рис. ${figNum}` : `Рис. ${figNum}`);
        allBlocks.push({
          type: "figure",
          imageBuffer: img.buffer,
          ext: img.ext,
          w: img.w,
          h: img.h,
          caption,
        });
      }
      if (i < markdowns.length - 1) {
        // page separator
        allBlocks.push({ type: "para", text: "" });
      }
    }
    const buf = await buildDocxFromBlocks({ title: title || name, blocks: allBlocks });
    const outpath = path.join(outDir, `${name}_ru.docx`);
    await writeFile(outpath, buf);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ ${outpath} (${dt}s, ${buf.length} bytes)`);
  } catch (e) {
    console.error(`  ✗ failed:`, e.message);
  }
}
