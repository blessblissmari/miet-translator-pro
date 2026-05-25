import { chat, mapWithConcurrency } from "./openrouter.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./glossary.mjs";
import { latexToUnicode } from "./mathUnicode.mjs";
import { readFile } from "node:fs/promises";

const SLIDE_PROMPT = (lang) =>
  `You are translating an English academic slide (from Mitra DSP textbook) into ${lang} for a Russian university course (МИЭТ — Цифровая обработка сигналов).

Style:
- Formal academic Russian, university coursework tone.
- "Chapter N" → «Глава N»; "Section" → «Раздел»; "Example" → «Пример»; "Problem" → «Задача»; "Theorem" → «Теорема»; "Proof" → «Доказательство»; "Definition" → «Определение»; "Note" → «Замечание»; "Remark" → «Замечание»; "Corollary" → «Следствие»; "Lemma" → «Лемма»; "Property" → «Свойство»; "Proposition" → «Утверждение».
- DO NOT translate variable names, equations, x[n], H(z), e^{jω}, etc.
- Math: keep inline math compact, use Unicode for simple symbols (ω, π, α, β, Σ) when natural; use $...$ only for true LaTeX fragments.
- Strip running headers/footers/page numbers like "Copyright © 2010, S. K. Mitra", "Chapter 3 - 14".
- Each bullet ≤ 100 chars, max 7 bullets per slide.

OUTPUT (strict JSON only, no preamble, no fences):
{
  "title": "<краткий русский заголовок слайда, ≤ 80 символов>",
  "bullets": ["…", "…"]
}

If the slide is a section/chapter title slide (single big title only), emit:
{ "title": "<заголовок>", "bullets": [] }

` + dspGlossaryPrompt(60);

const PAGE_PROMPT = (text, lang) => {
  const clipped = text.length > 6000 ? text.slice(0, 6000) + "\n…[truncated]" : text;
  return `Page (slide) raw text:\n---\n${clipped}\n---\nTranslate to ${lang} and return strict JSON {title, bullets}.`;
};

function parseJsonLoose(s) {
  if (!s) return null;
  // Strip code fences
  let t = s.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  // First {...} block
  const m = t.match(/\{[\s\S]*\}/);
  const candidate = m ? m[0] : t;
  try { return JSON.parse(candidate); } catch {}
  // Try fixing trailing commas
  try { return JSON.parse(candidate.replace(/,(\s*[}\]])/g, "$1")); } catch {}
  return null;
}

export async function translateSlides({ apiKey, model, pages, concurrency = 4, onProgress, images = {} }) {
  let done = 0;
  const results = await mapWithConcurrency(pages, concurrency, async (page) => {
    const messages = [
      { role: "system", content: SLIDE_PROMPT("Russian") },
      { role: "user", content: PAGE_PROMPT(page.text, "Russian") },
    ];
    let plan;
    try {
      const raw = await chat({ apiKey, model, messages, maxTokens: 1200, temperature: 0.2 });
      const parsed = parseJsonLoose(raw);
      if (parsed && typeof parsed.title === "string") {
        const title = latexToUnicode(applyGlossaryPost(parsed.title.trim())).slice(0, 120);
        const bullets = Array.isArray(parsed.bullets)
          ? parsed.bullets.map(b => latexToUnicode(applyGlossaryPost(String(b).trim()))).filter(Boolean).slice(0, 8)
          : [];
        const layout = bullets.length === 0 ? "section-title" : "title-text";
        plan = { title, bullets, layout };
      } else {
        const lines = (raw || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
        const title = latexToUnicode(applyGlossaryPost(lines[0] || `Слайд ${page.index + 1}`)).slice(0, 120);
        const bullets = lines.slice(1, 8).map(l => latexToUnicode(applyGlossaryPost(l)));
        plan = { title, bullets, layout: bullets.length === 0 ? "section-title" : "title-text" };
      }
    } catch (e) {
      plan = { title: `Слайд ${page.index + 1}`, bullets: [`[Ошибка перевода: ${e.message}]`], layout: "title-text" };
    }

    // Attach embedded figure (if any) for this page (1-indexed).
    const figs = images[page.index + 1];
    if (figs && figs.length) {
      try {
        const buf = await readFile(figs[0].path);
        plan.imageDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
        plan.layout = plan.bullets.length ? "title-text-image-right" : "title-image";
      } catch {}
    }

    done++;
    onProgress?.(done, pages.length);
    return plan;
  });
  return results;
}
