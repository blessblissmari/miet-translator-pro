/**
 * Document planning — translates extracted pages into DocPlan for DOCX building.
 */
import { chat } from "./openrouter";
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
  TARGET_LANG,
  type PlannerOpts,
} from "./plannerShared";
import type { DocPlan, DocBlock, ExtractedDoc } from "./types";

/* ─── Prompts ──────────────────────────────────── */

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
- Preserve abbreviations: BJT, MOSFET, DC, AC, SI, etc.
- Translate the meaning, not word-by-word. Output must read as if originally written by a Russian engineering professor.

STRUCTURE rules:
- Output ONLY the translated Markdown. No commentary. No code fences. No "Here is the translation".
- Preserve EVERY mathematical formula. Use LaTeX inside $...$ for inline math and $$...$$ on its own line for displayed equations. NEVER omit a formula. If the page is heavy with formulas, EVERY formula must appear in the output.
- Use Markdown structure:
  - "# Title" for top-level title (only if the page is a cover/title page).
  - "## Heading" / "### Subheading" for section/sub-section headings.
  - "- item" for unordered lists, "1. item" for ordered lists.
  - Plain paragraphs for prose.
- Preserve numbering of problems and sub-questions exactly.
- If the page mentions a figure that you cannot reproduce in text, mention it AT MOST ONCE with a short marker "(см. рис.)". Do NOT repeat the same marker multiple times in a row.
- For tables: render as Markdown tables with | separators. The downstream pipeline will rebuild them as native DOCX tables.
- Use ONLY the dollar-sign math delimiters: $...$ for inline and $$...$$ for display equations. Do NOT use \\( \\) or \\[ \\]. Multi-line environments like \\begin{cases} ... \\end{cases} MUST be wrapped in $$ ... $$.
- Do NOT prepend the document with a generic heading like "# Документ" or "# Domácí úkol". Only emit a heading if the page itself shows one.
`;

const VISION_OCR_PROMPT = (lang: string) =>
  `You are a senior technical translator and OCR expert for academic notes, including HANDWRITTEN material.

Task: look at the attached image of a page (it may be handwritten lecture notes, a scanned printed page, or a photo of someone's notebook). Carefully read the contents — including handwriting, formulas, sketches, and any printed text. Then translate everything into ${lang} ("русский") in academic МИЭТ-style.

CRITICAL rules:
- Output ONLY translated Markdown. No commentary. No code fences.
- Read the page exhaustively. Do NOT skip handwritten margin notes, sub-questions, or formulas.
- For mathematical content, use LaTeX in $...$ (inline) and $$...$$ (display). Reproduce subscripts, superscripts, fractions, integrals, sums faithfully. Multi-line environments (cases, align, matrix) MUST be wrapped in $$ ... $$. Never use \\( \\) or \\[ \\].
- Use Markdown structure: # for top heading, ##/### for sections, "- item" for bullets, "1." for ordered lists.
- For diagrams/sketches you cannot transcribe, leave AT MOST ONE short marker "(см. рис.)" — never repeat it.
- If you cannot read part of the page (smudged, cut off), write "[нечитаемо]" inline — do NOT invent content.
- Use formal Russian academic terminology (Задача, Решение, Часть, Найдите, Покажите, что …).
- Do NOT translate identifiers, units, code, or proper names (BJT, MOSFET, V_T, …).
`;

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
  const isHandwritten = page.text.replace(/\s+/g, "").length < 30;
  const VISION_FALLBACK = "nvidia/nemotron-nano-12b-v2-vl:free";
  const modelOverride = isHandwritten && !opts.visionCapable ? VISION_FALLBACK : undefined;

  const sysPrompt =
    (isHandwritten
      ? VISION_OCR_PROMPT(TARGET_LANG)
      : DOC_TRANSLATE_PROMPT(TARGET_LANG)) +
    dspGlossaryPrompt() +
    (glossary && glossary.size ? glossaryPrompt(glossary) : "");

  const visionUrl =
    isHandwritten || (opts.visionCapable && page.imageDataUrl)
      ? await downsampleDataUrl(page.imageDataUrl, {
          maxDim: isHandwritten ? 1800 : 1400,
        })
      : "";

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = isHandwritten
    ? [
        {
          type: "text",
          text: `Page ${page.index + 1}. The page may contain handwriting, sketches, or scanned printed text. Carefully transcribe everything you can see, then translate to ${TARGET_LANG} as Markdown per the rules.`,
        },
        { type: "image_url", image_url: { url: visionUrl } },
      ]
    : [
        {
          type: "text",
          text: `Translate the following page (page ${page.index + 1}) into ${TARGET_LANG}. Use Markdown as instructed.\n\n${page.text.slice(0, 12000)}`,
        },
        ...(opts.visionCapable && visionUrl
          ? [
              {
                type: "image_url" as const,
                image_url: { url: visionUrl },
              },
            ]
          : []),
      ];

  if (isHandwritten)
    opts.onLog?.(
      `Стр. ${page.index + 1}: режим vision-OCR (рукопись/скан)`,
    );

  const out = await chat({
    apiKey: opts.apiKey,
    model: modelOverride || opts.model,
    temperature: 0.2,
    maxTokens: 4096,
    signal: opts.signal,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userContent },
    ],
  });
  const blocks = parseMarkdownToBlocks(wrapOrphanLatex(normalizeMath(normalizeMathDelims(stripCodeFences(out)))));
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

    const pageW = page.width || 1;
    const pageH = page.height || 1;
    const realFigs = (page.images || []).filter((im) => {
      const coverage = (im.w * im.h) / (pageW * pageH);
      return coverage > 0 && coverage < 0.7;
    });
    for (let k = 0; k < realFigs.length; k++) {
      allBlocks.push({
        type: "figure",
        imageDataUrl: realFigs[k].dataUrl,
        caption:
          realFigs.length === 1
            ? `Рис. ${i + 1}`
            : `Рис. ${i + 1}.${k + 1}`,
      });
    }
  }

  if (errors.length === extracted.pages.length) {
    throw new Error(
      `Перевод не удался ни на одной странице: ${errors[0]}`,
    );
  }

  return { title, blocks: allBlocks };
}
