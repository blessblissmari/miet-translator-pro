// Vision-based per-page translation.
//
// We render each PDF page to a high-DPI PNG and send it to a MiMo vision
// model. The model "reads" the page (formulas, graphs, captions) and
// returns Russian Markdown with $..$/$$..$$ math and {{FIGURE_N}} tokens
// where it sees figures. The caller substitutes these tokens with
// actual figure-image paths.

import { readFile } from "node:fs/promises";
import { chat, stripCodeFences, mapWithConcurrency } from "./mimo.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./glossary.mjs";

function normalizeMathDelims(text) {
  text = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  text = text.replace(/\\\(\s*([^\n]*?)\s*\\\)/g, (_m, body) => `$${body.trim()}$`);
  text = text.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  text = text.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_m, body) =>
    `\n$$\n\\begin{aligned}\n${body.trim()}\n\\end{aligned}\n$$\n`);
  return text;
}

const VISION_PROMPT = `You are a senior technical translator for МИЭТ (Moscow Institute of Electronic Technology), Russian, formal academic style — DSP / digital signal processing (Mitra textbook).

You will receive ONE rendered PDF page as an image.

YOUR JOB: translate every visible piece of text on the page into formal Russian, output as Markdown.

OUTPUT RULES — read carefully:
- Output ONLY translated Markdown. No commentary, no fences, no "Here is...".
- Translate ALL visible text (titles, problems, paragraphs, captions, axis labels, table cells).
- Math:
   • Inline math → $...$  (single dollars)
   • Display math → $$...$$ on its own line
   • Reconstruct formulas you SEE — do NOT skip any. If a formula is partially obscured, write your best reading.
   • NEVER use \\( \\) or \\[ \\]. Use $ / $$.
- Figures, graphs, plots, diagrams, charts:
   • For EACH figure you see, in its proper position in reading order, output a placeholder on its own line:
       {{FIGURE_N}}
     where N is 1, 2, 3 ... numbering figures in reading order WITHIN THIS PAGE (reset on each page).
   • Then on the next line write the Russian caption / description, e.g. "Рис. — амплитудная характеристика H(jω)".
   • Do NOT try to redraw the figure in ASCII or describe pixel-by-pixel.
- Headings: use "#", "##", "###" for true page titles / sections only.
- Lists: "- item" or "1. item".
- Tables: Markdown tables.
- Skip page numbers, copyright lines, running headers/footers.
- Style: "Homework" → «Домашнее задание»; "Problem N" → «Задача N»; "Solution" → «Решение»; "Part (a)" → «Часть (а)»; "Show that" → «Покажите, что»; "Find" → «Найдите».
- Keep proper names, identifiers, units, code untranslated (Mitra, Butterworth, MOSFET, MHz, N, ω, etc.).
` + dspGlossaryPrompt();

/**
 * Translate one page image to Russian markdown using MiMo vision.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model — vision-capable MiMo model (mimo-v2.5 / mimo-v2-omni)
 * @param {string} opts.pageImagePath — path to PNG
 * @param {number} opts.pageNum — 1-based page index (for prompt context)
 * @param {AbortSignal} [opts.signal]
 */
export async function translatePageVision({ apiKey, model, pageImagePath, pageNum, signal }) {
  const buf = await readFile(pageImagePath);
  const b64 = buf.toString("base64");
  const dataUrl = `data:image/png;base64,${b64}`;

  const out = await chat({
    apiKey,
    model,
    maxTokens: 6000,
    temperature: 0.15,
    signal,
    messages: [
      { role: "system", content: VISION_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Translate page ${pageNum}. Output only the translated Markdown.` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return applyGlossaryPost(normalizeMathDelims(stripCodeFences(out)));
}

/**
 * Translate every page in parallel (capped concurrency).
 *
 * @param {Array<{pageImagePath: string}>} pages
 */
export async function translatePagesVision(pages, opts) {
  const { apiKey, model, signal, onProgress, concurrency = 2 } = opts;
  let done = 0;
  return mapWithConcurrency(pages, concurrency, async (p, i) => {
    const md = await translatePageVision({
      apiKey, model, signal,
      pageImagePath: p.pageImagePath,
      pageNum: i + 1,
    });
    done++;
    onProgress?.(done, pages.length);
    return md;
  });
}
