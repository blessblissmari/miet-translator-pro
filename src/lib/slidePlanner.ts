/**
 * Slide planning — translates extracted pages into SlidePlan objects for PPTX building.
 */
import { chat, parseJsonLoose } from "./mimo";
import { normalizeMath } from "./mathNormalize";
import { downsampleDataUrl } from "./imageOps";
import { mapWithConcurrency } from "./concurrency";
import { dspGlossaryPrompt, applyGlossaryPost } from "./glossary";
import { latexToUnicode } from "./mathUnicode";
import { polishRu } from "./ruPolish";
import { stripCodeFences, TARGET_LANG, type PlannerOpts } from "./plannerShared";
import type { SlidePlan, ExtractedDoc } from "./types";

const SLIDE_LAYOUTS = [
  "section-title",
  "title-text",
  "title-text-image-right",
  "title-text-image-left",
  "title-image",
] as const;

const SLIDE_PROMPT = (lang: string, validLayouts: string) =>
  `You convert one academic English slide into a localized slide for a MIET (Russian university) template.

Target language: ${lang}.

Output ONLY valid JSON (no commentary, no markdown fences) matching:
{ "title": string, "bullets": string[], "layout": one of [${validLayouts}], "isSectionTitle": boolean }

Rules:
- Translate slide content into ${lang}. Keep math formulas, code, identifiers, proper names verbatim.
- Inside bullets, keep math in LaTeX delimiters: $...$ (inline) and $$...$$ (display).
- Pick "section-title" only for pure chapter/section heading slides.
- Pick "title-image" if the slide is dominated by a figure with little text.
- Pick "title-text-image-right" if substantial text alongside a meaningful figure.
- Otherwise "title-text".
- Bullets concise (<= 12 items, <= 220 chars each). Preserve original order.
- Title is a short ${lang} phrase, NOT a sentence.
- IMPORTANT: Remove copyright notices ("Copyright © …", "© S. K. Mitra", etc.), slide numbers,
  and any page markers from the output. Do NOT include them in bullets or title.
- Use Unicode symbols (ω, π, Ω, σ, ∞, ≤, ≥, →, ·) for short inline math when natural; reserve LaTeX
  for non-trivial expressions.` + dspGlossaryPrompt();

export async function planSlides(
  extracted: ExtractedDoc,
  opts: PlannerOpts,
): Promise<SlidePlan[]> {
  let done = 0;
  const total = extracted.pages.length;
  const results = await mapWithConcurrency(
    extracted.pages,
    Math.max(1, opts.concurrency ?? 3),
    async (page, i) => {
      const plan = await planSlideRobust(page, opts);
      done++;
      opts.onProgress?.(done, total);
      opts.onLog?.(`Слайд ${i + 1}/${total} переведён`);
      return plan;
    },
    { signal: opts.signal },
  );

  const plans: SlidePlan[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok) {
      plans.push(r.value);
    } else {
      errors.push(`Слайд ${i + 1}: ${r.error.message}`);
      plans.push({
        title: `Слайд ${i + 1}`,
        bullets: [`⚠ Не удалось перевести: ${r.error.message}`],
        layout: "title-text",
      });
    }
  }
  if (errors.length === plans.length) {
    throw new Error(`Перевод не удался ни на одном слайде: ${errors[0]}`);
  }
  return plans;
}

async function planSlideRobust(
  page: {
    text: string;
    imageDataUrl: string;
    index: number;
    images?: { dataUrl: string; y: number; w: number; h: number }[];
  },
  opts: PlannerOpts,
): Promise<SlidePlan> {
  const realImages = (page.images || []).filter(
    (im) => im.w * im.h > 80 * 80,
  );
  const bestImg =
    realImages.length > 0
      ? realImages.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0].dataUrl
      : null;

  const isHandwritten = page.text.replace(/\s+/g, "").length < 30;
  const VISION_FALLBACK = "nvidia/nemotron-nano-12b-v2-vl:free";
  const modelOverride = isHandwritten && !opts.visionCapable ? VISION_FALLBACK : undefined;
  if (isHandwritten) {
    opts.onLog?.(`Слайд ${page.index + 1}: режим vision-OCR`);
    const visionUrl = await downsampleDataUrl(page.imageDataUrl, {
      maxDim: 1800,
    });
    const out = await chat({
      apiKey: opts.apiKey,
      model: modelOverride || opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      signal: opts.signal,
      messages: [
        {
          role: "system",
          content: `Read the attached slide image (may be handwritten or scanned), then output a short ${TARGET_LANG} title on the first line, then up to 8 bullet lines starting with "- ". Keep math in $...$ or $$...$$. Output only Markdown.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Slide ${page.index + 1} — read & translate.`,
            },
            { type: "image_url", image_url: { url: visionUrl } },
          ],
        },
      ],
    });
    return parseSlideFromPlain(normalizeMath(stripCodeFences(out)), bestImg);
  }

  // Primary: structured JSON
  try {
    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [
      {
        type: "text",
        text: `Slide raw text:\n\n${page.text.slice(0, 6000)}\n\nThis slide has ${realImages.length} embedded figure(s).`,
      },
    ];
    if (opts.visionCapable) {
      const visionUrl = await downsampleDataUrl(page.imageDataUrl, {
        maxDim: 1400,
      });
      userContent.push({ type: "image_url", image_url: { url: visionUrl } });
    }
    const out = await chat({
      apiKey: opts.apiKey,
      model: modelOverride || opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      responseJson: true,
      signal: opts.signal,
      messages: [
        {
          role: "system",
          content: SLIDE_PROMPT(
            TARGET_LANG,
            SLIDE_LAYOUTS.map((l) => `"${l}"`).join(", "),
          ),
        },
        { role: "user", content: userContent },
      ],
    });
    const parsed = parseJsonLoose<{
      title?: string;
      bullets?: string[];
      layout?: string;
      isSectionTitle?: boolean;
    }>(out);
    let layout = (
      parsed.layout &&
      (SLIDE_LAYOUTS as readonly string[]).includes(parsed.layout)
        ? parsed.layout
        : "title-text"
    ) as SlidePlan["layout"];
    if (parsed.isSectionTitle) layout = "section-title";
    // Coerce layout to match available assets
    if (
      !bestImg &&
      (layout === "title-text-image-right" ||
        layout === "title-text-image-left" ||
        layout === "title-image")
    ) {
      layout = "title-text";
    }
    if (bestImg && layout === "title-text") {
      layout = "title-text-image-right";
    }
    return {
      title: polishRu(latexToUnicode(applyGlossaryPost(normalizeMath((parsed.title || "").trim())))),
      bullets: (parsed.bullets || [])
        .slice(0, 12).map((b: string) => polishRu(latexToUnicode(applyGlossaryPost(b)))),
      layout,
      imageDataUrl:
        layout === "section-title" ? undefined : (bestImg ?? undefined),
    };
  } catch (e1) {
    opts.onLog?.(
      `Слайд ${page.index + 1}: JSON упал, делаю plain-перевод (${(e1 as Error).message.slice(0, 80)})`,
    );
    const plain = await chat({
      apiKey: opts.apiKey,
      model: modelOverride || opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      signal: opts.signal,
      messages: [
        {
          role: "system",
          content: `Translate the slide content into ${TARGET_LANG}. Output a short ${TARGET_LANG} title on the first line, then up to 8 bullet lines starting with "- ". Keep math in $...$ or $$...$$. No commentary.`,
        },
        { role: "user", content: page.text.slice(0, 6000) },
      ],
    });
    return parseSlideFromPlain(normalizeMath(stripCodeFences(plain)), bestImg);
  }
}

function parseSlideFromPlain(
  md: string,
  imageDataUrl: string | null,
): SlidePlan {
  const lines = md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let title = lines.shift() || "";
  title = title.replace(/^#+\s*/, "");
  const bullets: string[] = [];
  for (const ln of lines) {
    const m = ln.match(/^[-*•]\s+(.*)$/);
    if (m) bullets.push(m[1].trim());
    else if (bullets.length === 0) {
      bullets.push(ln);
    } else {
      bullets[bullets.length - 1] += " " + ln;
    }
  }
  const layout: SlidePlan["layout"] = imageDataUrl
    ? "title-text-image-right"
    : "title-text";
  return {
    title: polishRu(latexToUnicode(applyGlossaryPost(title))),
    bullets: bullets.slice(0, 12).map((b) => polishRu(latexToUnicode(applyGlossaryPost(b)))),
    layout,
    imageDataUrl: imageDataUrl ?? undefined,
  };
}
