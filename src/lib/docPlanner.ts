/**
 * Document planning — translates extracted pages into DocPlan for DOCX building.
 */
import { chat } from "./mimo";
import { normalizeMath } from "./mathNormalize";
import { downsampleDataUrl } from "./imageOps";
import { mapWithConcurrency } from "./concurrency";
import {
  harvestPairs,
  glossaryPrompt,
  mergeGlossary,
  dspGlossaryPrompt,
  applyGlossaryPost,
  type Glossary,
} from "./glossary";
import { polishRu } from "./ruPolish";
import {
  stripCodeFences,
  parseMarkdownToBlocks,
  normalizeMathDelims,
  wrapOrphanLatex,
  sanitizeHtml,
  TARGET_LANG,
  type PlannerOpts,
} from "./plannerShared";
import type { DocPlan, DocBlock, ExtractedDoc } from "./types";
import { detectFigures, cropFigures } from "./figureDetect";

/* ─── Prompts ──────────────────────────────────── */

// kept for reference; vision-OCR prompt is now used for all pages
// @ts-expect-error unused after switching to always-image strategy
const DOC_TRANSLATE_PROMPT = (lang: string) =>
  `You are a senior technical translator specializing in academic and engineering literature for Russian universities.

Task: translate the academic page below into ${lang} ("русский"), with the tone and terminology used in formal Russian university coursework (МИЭТ-style).

STYLE rules:
- Use formal, academic ${lang}. Prefer established Russian technical terminology over literal/calque translations. Examples:
  - "transistor" → «транзистор»
  - "small-signal model" → «модель для малого сигнала»
  - "cut-off frequency" → «частота среза»
  - "homework" → «домашнее задание»
  - "Question N" → «Задача N»
  - "Solution" → «Решение»
  - "Part (a)" → «Часть (а)» or «Пункт (а)»
  - "Show that" → «Покажите, что»
  - "Find" → «Найдите»
- Do NOT translate code, identifiers, variable names, units, or proper names (Ohm, Faraday, MOSFET, etc.).
- **Use ONLY Cyrillic letters and standard Latin/digits inside Russian prose. NEVER emit Chinese, Japanese, or Korean characters (no 记忆, 系统, 输入, 输出, etc.). If you don't know the Russian term, use the English original — never a CJK character.** Common offenders: memoryless → «без памяти» (NOT «без 记忆ной»); memory → «память»; system → «система»; input → «вход»; output → «выход»; impulse response → «импульсная характе
- Preserve abbreviations: BJT, MOSFET, DC, AC, SI, etc.
- Translate the meaning, not word-by-word. Output must read as if originally written by a Russian engineering professor.

STRUCTURE rules:
- Output ONLY the translated Markdown. No commentary. No code fences. No "Here is the translation".
- **NEVER output HTML.** No <sub>, <sup>, <i>, <b>, <br>, <table>, <math>, <span>, <p>, <div> — Word does not render HTML inside paragraphs and they appear as literal text. Use ONLY plain Markdown and LaTeX math.
- Preserve EVERY mathematical formula. Use LaTeX inside $...$ for inline math and $$...$$ on its own line for displayed equations. NEVER omit a formula. If the page is heavy with formulas, EVERY formula must appear in the output.
- **EVERY math expression must be wrapped in $...$ or $$...$$**. This includes simple ones like:
    WRONG: \`y[n] = x[n+1] - 2x[n] + x[n-1]\`
    RIGHT: \`$y[n] = x[n+1] - 2x[n] + x[n-1]$\`
    WRONG: \`H{x[n]} = \\delta[n-2]\`
    RIGHT: \`$H\\{x[n]\\} = \\delta[n-2]$\`
    WRONG: \`x_1\`, \`V_T\`, \`f_c\`
    RIGHT: \`$x_1$\`, \`$V_T$\`, \`$f_c$\`
  Even bare variables inside Russian prose must be wrapped: «при $x = 0$» not «при x = 0».
- Use Markdown structure:
  - "# Title" for top-level title (only if the page is a cover/title page).
  - "## Heading" / "### Subheading" for section/sub-section headings.
  - "- item" for unordered lists, "1. item" for ordered lists.
  - Plain paragraphs for prose.
- Preserve numbering of problems and sub-questions exactly.
- If the page mentions a figure that you cannot reproduce in text, mention it AT MOST ONCE with a short marker "(см. рис.)". Do NOT repeat the same marker multiple times in a row.
- For tables: render as Markdown tables with | separators. The downstream pipeline will rebuild them as native DOCX tables. NEVER use HTML <table>.
- Use ONLY the dollar-sign math delimiters: $...$ for inline and $$...$$ for display equations. Do NOT use \\( \\) or \\[ \\]. Multi-line environments like \\begin{cases} ... \\end{cases} MUST be wrapped in $$ ... $$.
- Do NOT prepend the document with a generic heading like "# Документ" or "# Domácí úkol". Only emit a heading if the page itself shows one.
`;

const VISION_OCR_PROMPT = (lang: string) =>
  `You are a senior technical translator and OCR expert for academic notes, including HANDWRITTEN material.

Task: look at the attached image of a page (it may be handwritten lecture notes, a scanned printed page, or a photo of someone's notebook). Carefully read the contents — including handwriting, formulas, sketches, and any printed text. Then translate everything into ${lang} ("русский") in academic МИЭТ-style.

CRITICAL rules:
- Output ONLY translated Markdown. No commentary. No code fences.
- **NEVER output HTML.** No <sub>, <sup>, <i>, <b>, <br>, <table>, <math>, <span>, <p>, <div> tags. Use ONLY plain Markdown and LaTeX math.
- Read the page exhaustively. Do NOT skip handwritten margin notes, sub-questions, or formulas.
- For mathematical content, use LaTeX in $...$ (inline) and $$...$$ (display). Reproduce subscripts, superscripts, fractions, integrals, sums faithfully. Multi-line environments (cases, align, matrix) MUST be wrapped in $$ ... $$. Never use \\( \\) or \\[ \\].
- **EVERY math expression must be wrapped in $...$ — even single variables like $x_1$, $V_T$, $y[n]$. Whole equations must be one math span, not fragments:
    WRONG: \`y[n] = \\mathcal{H}\\{x[n]\\}\`
    RIGHT: \`$y[n] = \\mathcal{H}\\{x[n]\\}$\`
- Use Markdown structure: # for top heading, ##/### for sections, "- item" for bullets, "1." for ordered lists.
- For diagrams/sketches you cannot transcribe, leave AT MOST ONE short marker "(см. рис.)" — never repeat it.
- If you cannot read part of the page (smudged, cut off), write "[нечитаемо]" inline — do NOT invent content.
- Use formal Russian academic terminology (Задача, Решение, Часть, Найдите, Покажите, что …).
- Do NOT translate identifiers, units, code, or proper names (BJT, MOSFET, V_T, …).
`;

const VERIFY_PROMPT = `Ты — рецензент перевода. Получишь изображение исходной страницы и черновой Russian Markdown.
Проверь:
1. Все ли формулы со страницы попали в Markdown?
2. Все ли подвопросы/пункты (а)(б)(в)(г)(д)(е) присутствуют?
3. Нет ли пропущенных абзацев?

ВЕРНИ строго JSON: {"ok":boolean,"gaps":["короткое описание пропуска", ...]}.
ok=true когда покрытие полное.`;

const MATH_AUDIT_PROMPT = `Ты — строгий проверяющий математических формул.
Получишь изображение страницы и черновой Markdown.
Найди ВСЕ математические выражения на странице, которые в Markdown НЕ обёрнуты в $...$ или $$...$$
(например: y[n] = ..., x_1[n], H{x[n]}, \\delta[n-2], \\mathcal{H}, max(...), и подобные).

ВЕРНИ строго JSON: {"ok":boolean,"unwrapped":["цитата неправильного фрагмента", ...]}.
ok=true когда все формулы правильно обёрнуты.`;

async function verifyPage(
  page: { imageDataUrl: string; index: number },
  draft: string,
  opts: PlannerOpts,
  prompt: string,
  fieldKey: "gaps" | "unwrapped",
): Promise<{ ok: boolean; issues: string[] }> {
  try {
    const visionUrl = await downsampleDataUrl(page.imageDataUrl, { maxDim: 1400 });
    const out = await chat({
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0,
      maxTokens: 1500,
      signal: opts.signal,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            { type: "text", text: `Стр. ${page.index + 1}. Черновой Markdown:\n\n${draft.slice(0, 8000)}` },
            { type: "image_url", image_url: { url: visionUrl } },
          ],
        },
      ],
    });
    const cleaned = stripCodeFences(out);
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, issues: [] };
    const parsed = JSON.parse(m[0]);
    const issues = Array.isArray(parsed[fieldKey]) ? parsed[fieldKey].slice(0, 10) : [];
    return { ok: parsed.ok !== false && issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ─── Per-page translation ─────────────────────── */

async function translateDocPage(
  page: {
    text: string;
    imageDataUrl: string;
    index: number;
    images?: { dataUrl: string; y: number; w: number; h: number }[];
  },
  opts: PlannerOpts,
  glossary?: Glossary,
): Promise<DocBlock[]> {
  // Strategy: page IMAGE is always the primary OCR input.
  // pdfjs-extracted text is passed as a supplementary hint (may help on
  // dense printed pages, ignored when the image disagrees).

  const sysPrompt =
    VISION_OCR_PROMPT(TARGET_LANG) +
    dspGlossaryPrompt() +
    (glossary && glossary.size ? glossaryPrompt(glossary) : "");

  const visionUrl = page.imageDataUrl
    ? await downsampleDataUrl(page.imageDataUrl, { maxDim: 1800 })
    : "";

  const hint = page.text.replace(/\s+/g, " ").trim().slice(0, 8000);
  const hasHint = hint.length > 20;

  const intro = `Page ${page.index + 1}. Read the attached image as your PRIMARY source — this is the authoritative version of the page (printed, handwritten, mixed, or scanned). Transcribe everything you see and translate to ${TARGET_LANG} as Markdown per the rules.`;

  const hintBlock = hasHint
    ? `\n\n---\nMachine-extracted text hint (from pdfjs, may have OCR errors, missing handwriting/figures, or wrong reading order — use ONLY as a tie-breaker, trust the image when they disagree):\n\n${hint}`
    : "";

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [
    { type: "text", text: intro + hintBlock },
    ...(visionUrl
      ? [{ type: "image_url" as const, image_url: { url: visionUrl } }]
      : []),
  ];

  opts.onLog?.(
    `Стр. ${page.index + 1}: vision-OCR${hasHint ? " + pdfjs hint" : ""}${visionUrl ? "" : " (нет изображения)"}`,
  );

  const out = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.2,
    maxTokens: 4096,
    signal: opts.signal,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userContent },
    ],
  });
  let raw = out;
  // ─── Pass 2: coverage verify ──────────────────────────────────────────
  // ─── Pass 3: math audit ──────────────────────────────────────────────
  if (page.imageDataUrl) {
    for (const pass of [
      { prompt: VERIFY_PROMPT, field: "gaps" as const, label: "verify" },
      { prompt: MATH_AUDIT_PROMPT, field: "unwrapped" as const, label: "math-audit" },
    ]) {
      try {
        const check = await verifyPage({ imageDataUrl: page.imageDataUrl, index: page.index }, raw, opts, pass.prompt, pass.field);
        if (!check.ok && check.issues.length) {
          opts.onLog?.(`Стр. ${page.index + 1}: ${pass.label} нашёл ${check.issues.length} проблем — повторный перевод…`);
          const fixOut = await chat({
            apiKey: opts.apiKey,
            model: opts.model,
            temperature: 0.1,
            maxTokens: 4096,
            signal: opts.signal,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userContent },
              { role: "assistant", content: raw },
              {
                role: "user",
                content: `Исправь следующие проблемы и верни ПОЛНУЮ обновлённую версию страницы как Markdown (без комментариев):\n${check.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
              },
            ],
          });
          raw = fixOut;
        }
      } catch { /* ignore verify errors */ }
    }
  }
  const blocks = parseMarkdownToBlocks(wrapOrphanLatex(normalizeMath(normalizeMathDelims(sanitizeHtml(stripCodeFences(raw))))));
  // Post-pass: substitute any remaining English DSP terms.
  return blocks.map((b) => {
    if (b.type === "para" || b.type === "h1" || b.type === "h2" || b.type === "h3") {
      return { ...b, text: polishRu(applyGlossaryPost(b.text)) };
    }
    if (b.type === "list") {
      return { ...b, items: b.items.map((it) => polishRu(applyGlossaryPost(it))) };
    }
    return b;
  });
}

/* ─── Full document planning ───────────────────── */

export async function planDoc(
  extracted: ExtractedDoc,
  opts: PlannerOpts,
): Promise<DocPlan> {
  const allBlocks: DocBlock[] = [];
  let title: string | undefined;
  const errors: string[] = [];
  const glossary: Glossary = new Map();

  let done = 0;
  const total = extracted.pages.length;
  const pagePairs: Array<Array<[string, string]>> = new Array(total).fill([]);

  const results = await mapWithConcurrency(
    extracted.pages,
    Math.max(1, opts.concurrency ?? 3),
    async (page, i) => {
      const blocks = await translateDocPage(page, opts, glossary);
      done++;
      opts.onProgress?.(done, total);
      opts.onLog?.(`Стр. ${i + 1}/${total} переведена`);
      const tt = blocks
        .map((b) =>
          b.type === "para" || b.type === "h1" || b.type === "h2" || b.type === "h3"
            ? b.text
            : b.type === "list"
              ? b.items.join(" ")
              : "",
        )
        .join("\n");
      pagePairs[i] = harvestPairs(page.text, tt);
      return blocks;
    },
    {
      signal: opts.signal,
      onBatchSettled: (start, end) => {
        for (let i = start; i <= end; i++) mergeGlossary(glossary, pagePairs[i]);
        if (glossary.size > 0)
          opts.onLog?.(`Глоссарий: ${glossary.size} терминов`);
      },
    },
  );

  for (let i = 0; i < extracted.pages.length; i++) {
    const page = extracted.pages[i];
    const r = results[i];
    if (r.ok) {
      const blocks = r.value;
      if (!title && blocks.length > 0 && blocks[0].type === "h1") {
        const h1 = blocks.shift() as DocBlock;
        if (h1.type === "h1") title = h1.text;
      }
      if (blocks.length === 0) {
        if (page.text.trim())
          allBlocks.push({ type: "para", text: page.text.trim() });
      } else {
        allBlocks.push(...blocks);
      }
    } else {
      const msg = r.error.message;
      errors.push(`Страница ${i + 1}: ${msg}`);
      opts.onLog?.(`Ошибка на странице ${i + 1}: ${msg.slice(0, 120)}`);
      allBlocks.push({
        type: "para",
        text: `⚠ Страница ${i + 1}: не удалось перевести (${msg}). Исходный текст ниже.`,
      });
      if (page.text.trim())
        allBlocks.push({ type: "para", text: page.text.trim() });
    }

    // Figure extraction: ask vision model for bboxes, crop them.
    let figures: Array<{ dataUrl: string; caption?: string }> = [];
    if (page.imageDataUrl) {
      try {
        const bboxes = await detectFigures(page.imageDataUrl, {
          apiKey: opts.apiKey,
          model: opts.model,
          signal: opts.signal,
        });
        if (bboxes.length > 0) {
          const cropped = await cropFigures(page.imageDataUrl, bboxes);
          figures = cropped.map((c) => ({
            dataUrl: c.dataUrl,
            caption: c.bbox.caption,
          }));
          opts.onLog?.(`Стр. ${i + 1}: vision нашёл ${figures.length} рисунк(ов)`);
        }
      } catch (e) {
        opts.onLog?.(`Стр. ${i + 1}: детекция рисунков пропущена (${String(e).slice(0, 60)})`);
      }
    }

    // Fallback to pdfjs-embedded rasters ONLY if vision returned nothing.
    if (figures.length === 0 && page.images && page.images.length) {
      const pageW = page.width || 1;
      const pageH = page.height || 1;
      const realFigs = page.images.filter((im) => {
        const coverage = (im.w * im.h) / (pageW * pageH);
        return coverage > 0.005 && coverage < 0.85;
      });
      figures = realFigs.map((f) => ({ dataUrl: f.dataUrl }));
      if (figures.length)
        opts.onLog?.(`Стр. ${i + 1}: использую ${figures.length} pdfjs-картин(ок)`);
    }

    for (let k = 0; k < figures.length; k++) {
      const f = figures[k];
      allBlocks.push({
        type: "figure",
        imageDataUrl: f.dataUrl,
        caption:
          f.caption
          || (figures.length === 1
            ? `Рис. ${i + 1}`
            : `Рис. ${i + 1}.${k + 1}`),
      });
    }
    // NO whole-page fallback. If the model finds no figures and pdfjs has none,
    // the page is treated as text-only.
  }

  if (errors.length === extracted.pages.length) {
    throw new Error(
      `Перевод не удался ни на одной странице: ${errors[0]}`,
    );
  }

  return { title, blocks: allBlocks };
}
