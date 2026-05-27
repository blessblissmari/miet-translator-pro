// Vision-based per-page translation with multi-pass refinement.
//
// Pass 1: translate the page image → Russian Markdown with {{FIGURE_N}} tokens.
// Pass 2 (verify): show the model the source page + its own translation and
//         ask "what is missing?". If the gap report is non-empty, retranslate
//         once with that gap list as explicit guidance.
//
// All math uses LaTeX delimiters $...$ / $$...$$ so pandoc can convert them
// into native Office equations (OMML).

import { readFile } from "node:fs/promises";
import { chat, stripCodeFences, mapWithConcurrency } from "./mimo.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./glossary.mjs";

function normalizeMathDelims(text) {
  text = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  text = text.replace(/\\\(\s*([^\n]*?)\s*\\\)/g, (_m, body) => `$${body.trim()}$`);
  text = text.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g,
    (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  text = text.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g,
    (_m, body) => `\n$$\n\\begin{aligned}\n${body.trim()}\n\\end{aligned}\n$$\n`);
  return text;
}

const VISION_PROMPT = `You are a senior technical translator for МИЭТ (Moscow Institute of Electronic Technology), Russian, formal academic style — DSP / digital signal processing (Mitra textbook).

You will receive ONE rendered PDF page as an image.

YOUR JOB: translate every visible piece of text on the page into formal Russian, output as Markdown.

OUTPUT RULES — read carefully:
- Output ONLY translated Markdown. No commentary, no fences, no "Here is...".
- Translate ALL visible text (titles, problems, paragraphs, captions, axis labels, table cells, sub-figure labels).
- Math:
   • Inline math → $...$  (single dollars)
   • Display math → $$...$$ on its own line
   • Reconstruct EVERY formula you SEE. If a formula is partially obscured, write your best reading.
   • NEVER use \\( \\) or \\[ \\]. Use $ / $$.
   • Use \\frac, \\sum, \\int, \\sqrt, ^{...}, _{...}, \\omega, \\pi, \\alpha, \\delta, \\infty.
- Figures, graphs, plots, diagrams, schematics:
   • For EACH figure you see, in proper reading position, output a placeholder on its own line:
       {{FIGURE_N}}
     N is 1, 2, 3 ... numbering figures in reading order WITHIN THIS PAGE (reset on each page).
   • Then a short Russian caption on the next line: "Рис. — амплитудная характеристика H(jω)".
   • If a figure shows multiple sub-plots (a), (b), (c) — count them as ONE figure with caption listing parts.
- Headings: "#", "##", "###" for true titles / sections only.
- Lists: "- item" or "1. item".
- Tables: Markdown pipe tables.
- Skip page numbers, copyright (e.g. "Copyright © 2010 S. K. Mitra"), running headers/footers.
- Style: "Homework" → «Домашнее задание»; "Problem N" → «Задача N»; "Solution" → «Решение»; "Part (a)" → «Часть (а)»; "Show that" → «Покажите, что»; "Find" → «Найдите»; "Determine" → «Определите»; "Consider" → «Рассмотрим»; "Hence" → «Следовательно»; "Therefore" → «Поэтому».
- Keep proper names, identifiers, units, code untranslated (Mitra, Butterworth, MOSFET, MHz, N, ω, etc.).
- Latin sub-part letters → Cyrillic: (a)→(а), (b)→(б), (c)→(в), (d)→(г), (e)→(д).
` + dspGlossaryPrompt();

const VERIFY_PROMPT = `Вы — корректор перевода. Сравните русский Markdown-перевод со скриншотом исходной страницы (английский).

Найдите конкретные пропуски и ошибки:
- Пропущенные формулы (укажи их).
- Пропущенные подписи к рисункам.
- Пропущенные предложения, заголовки, элементы списка, ячейки таблиц.
- Грубые ошибки перевода терминов.

ОТВЕТ — строго JSON, без markdown-обёрток:
{
  "ok": true | false,
  "gaps": ["короткая фраза 1", "короткая фраза 2", ...]
}

ok=true — если перевод покрывает страницу полностью.
ok=false — если есть пропуски (тогда заполни gaps списком того, что нужно добавить).
Максимум 8 пунктов в gaps. Только русский язык в gaps.`;

/**
 * Pass 1: translate page → Russian Markdown.
 */
async function visionTranslate({ apiKey, model, dataUrl, pageNum, signal, guidance = "" }) {
  const userText = guidance
    ? `Translate page ${pageNum}. Output only Markdown.

The previous attempt missed the following items — make sure they appear in the new translation:
${guidance}`
    : `Translate page ${pageNum}. Output only Markdown.`;
  const out = await chat({
    apiKey, model, maxTokens: 6500, temperature: 0.15, signal,
    messages: [
      { role: "system", content: VISION_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return applyGlossaryPost(normalizeMathDelims(stripCodeFences(out)));
}

/**
 * Pass 2: ask the model to compare source vs translation and report gaps.
 * Returns { ok, gaps[] }.
 */
async function visionVerify({ apiKey, model, dataUrl, md, signal }) {
  try {
    const out = await chat({
      apiKey, model, maxTokens: 800, temperature: 0.1, signal, responseJson: true,
      messages: [
        { role: "system", content: VERIFY_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Markdown-перевод страницы:

${md.slice(0, 8000)}` },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    const t = stripCodeFences(out).trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, gaps: [] };
    const j = JSON.parse(m[0]);
    return { ok: !!j.ok, gaps: Array.isArray(j.gaps) ? j.gaps.filter(Boolean).slice(0, 10) : [] };
  } catch {
    return { ok: true, gaps: [] };
  }
}

/**
 * Translate one page with verify+retry.
 */
export async function translatePageVision({ apiKey, model, pageImagePath, pageNum, signal, verify = true }) {
  const buf = await readFile(pageImagePath);
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  let md = await visionTranslate({ apiKey, model, dataUrl, pageNum, signal });
  if (!verify) return md;
  const review = await visionVerify({ apiKey, model, dataUrl, md, signal });
  if (review.ok || review.gaps.length === 0) return md;
  const md2 = await visionTranslate({
    apiKey, model, dataUrl, pageNum, signal,
    guidance: review.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n"),
  });
  return md2 || md;
}

export async function translatePagesVision(pages, opts) {
  const { apiKey, model, signal, onProgress, concurrency = 2, verify = true } = opts;
  let done = 0;
  return mapWithConcurrency(pages, concurrency, async (p, i) => {
    const md = await translatePageVision({
      apiKey, model, signal, verify,
      pageImagePath: p.pageImagePath,
      pageNum: i + 1,
    });
    done++;
    onProgress?.(done, pages.length);
    return md;
  });
}
