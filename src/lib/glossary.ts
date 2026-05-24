/**
 * Cross-page terminology consistency.
 *
 * Problem: when each page is translated independently, the same English term
 * may map to different Russian translations across pages — "small-signal model"
 * becomes both «модель малого сигнала» and «малосигнальная модель» in the same
 * document. Readers find this jarring.
 *
 * Solution: after the first batch of pages is translated, harvest a small
 * EN→RU mapping by aligning frequent technical terms in the source with their
 * translation, and inject it into subsequent pages' system prompts as a
 * "do-not-deviate-from" glossary.
 *
 * The harvester is intentionally conservative: it only proposes terms that
 *   - appear at least twice across the source pages already seen
 *   - are 1–3 word phrases of letters/digits/dashes
 *   - get a stable Russian counterpart on every translated page that mentions
 *     them (otherwise we don't know which variant is the "right" one)
 *
 * This keeps the glossary small (~20 entries) and high-signal.
 */

export type Glossary = Map<string, string>;

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "is", "are", "was", "were", "this", "that", "these", "those", "with",
  "from", "as", "be", "we", "you", "they", "if", "then", "so", "but",
  "can", "may", "will", "would", "should", "could", "have", "has", "had",
  "it", "its", "our", "their", "his", "her",
]);

const TERM_RE = /\b([A-Z][A-Za-z0-9-]{2,}(?:\s+[A-Z]?[A-Za-z0-9-]{2,}){0,2})\b/g;

/** Extract candidate technical terms (Title-Case multi-word phrases). */
export function harvestSourceTerms(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM_RE.exec(source))) {
    const phrase = m[1].trim();
    if (phrase.length < 4) continue;
    if (STOPWORDS.has(phrase.toLowerCase())) continue;
    if (/^\d+$/.test(phrase)) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return counts;
}

/** Render the glossary as a short prompt snippet, capped to N entries. */
export function glossaryPrompt(g: Glossary, max = 25): string {
  if (g.size === 0) return "";
  const items = Array.from(g.entries()).slice(0, max);
  const lines = items.map(([en, ru]) => `  - ${en} → ${ru}`).join("\n");
  return `\nKeep terminology consistent with the document-wide glossary already established:\n${lines}\n(Use these EXACT Russian translations whenever the English term appears.)`;
}

/** Merge new (EN, RU) pairs into existing glossary. First-seen wins. */
export function mergeGlossary(g: Glossary, pairs: Iterable<[string, string]>): void {
  for (const [en, ru] of pairs) {
    if (!g.has(en)) g.set(en, ru);
  }
}

/**
 * Heuristic: if `sourceText` contains an EN term and `translation` contains
 * the same English token verbatim ALSO in Russian context (e.g. acronyms
 * like MOSFET, BJT) — capture the surrounding Russian phrase as the gloss.
 *
 * For now, we only auto-capture acronyms (≥2 capital letters) since matching
 * arbitrary EN phrases to RU translations without alignment models is unreliable.
 */
export function harvestPairs(sourceText: string, translation: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const acronyms = new Set<string>();
  const acrRe = /\b([A-Z]{2,}[A-Z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = acrRe.exec(sourceText))) acronyms.add(m[1]);
  for (const acr of acronyms) {
    // If the acronym appears in the translation, the translator preserved it
    // verbatim — this is itself useful: lock it in so later pages can't
    // accidentally translate the acronym.
    if (translation.includes(acr)) out.push([acr, acr]);
  }
  return out;
}

/**
 * Static DSP / academic-engineering glossary.
 *
 * Used in TWO ways:
 *   1. Injected into every translation prompt as authoritative term mapping.
 *   2. Post-pass: regex-replace any remaining English term in the translated
 *      Russian text. Acts as a safety net when the LLM forgot to translate
 *      a specific term or used a non-standard Russian variant.
 *
 * Curated for МИЭТ ЦОС coursework (Mitra style: discrete-time signal
 * processing, digital filter design, sampling, z-transform, FFT, etc.).
 */
export const DSP_GLOSSARY: Record<string, string> = {
  // Transforms
  "discrete-time Fourier transform": "дискретно-временное преобразование Фурье",
  "DTFT": "ДВПФ",
  "inverse DTFT": "обратное ДВПФ",
  "discrete Fourier transform": "дискретное преобразование Фурье",
  "DFT": "ДПФ",
  "inverse DFT": "обратное ДПФ",
  "IDFT": "ОДПФ",
  "fast Fourier transform": "быстрое преобразование Фурье",
  "FFT": "БПФ",
  "z-transform": "z-преобразование",
  "inverse z-transform": "обратное z-преобразование",
  "Laplace transform": "преобразование Лапласа",
  "bilinear transformation": "билинейное преобразование",
  "impulse invariance": "инвариантность импульсной характеристики",

  // Filter types
  "FIR": "КИХ",
  "IIR": "БИХ",
  "FIR filter": "КИХ-фильтр",
  "IIR filter": "БИХ-фильтр",
  "lowpass filter": "фильтр нижних частот",
  "highpass filter": "фильтр верхних частот",
  "bandpass filter": "полосовой фильтр",
  "bandstop filter": "режекторный фильтр",
  "notch filter": "режекторный фильтр",
  "allpass filter": "всепропускающий фильтр",
  "comb filter": "гребенчатый фильтр",
  "elliptic filter": "эллиптический фильтр",
  "Butterworth filter": "фильтр Баттерворта",
  "Chebyshev filter": "фильтр Чебышева",
  "Butterworth": "Баттерворт",
  "Chebyshev": "Чебышев",
  "linear-phase": "линейная фаза",

  // Filter specs
  "passband": "полоса пропускания",
  "stopband": "полоса задерживания",
  "transition band": "переходная полоса",
  "passband ripple": "пульсации в полосе пропускания",
  "stopband attenuation": "затухание в полосе задерживания",
  "cutoff frequency": "частота среза",
  "ripple": "пульсации",
  "attenuation": "затухание",
  "magnitude response": "амплитудно-частотная характеристика",
  "phase response": "фазо-частотная характеристика",
  "frequency response": "частотная характеристика",
  "amplitude response": "амплитудная характеристика",
  "group delay": "групповая задержка",
  "AmplitudeResponse": "АЧХ",
  "PhaseResponse": "ФЧХ",

  // Signals / systems
  "discrete-time": "дискретно-временной",
  "continuous-time": "непрерывного времени",
  "linear time-invariant": "линейный стационарный",
  "LTI": "ЛСИ",
  "LTI system": "ЛСИ-система",
  "causal sequence": "причинная последовательность",
  "causal system": "причинная система",
  "stable system": "устойчивая система",
  "impulse response": "импульсная характеристика",
  "unit sample response": "отклик на единичный импульс",
  "step response": "переходная характеристика",
  "transfer function": "передаточная функция",
  "difference equation": "разностное уравнение",
  "convolution": "свёртка",
  "linear convolution": "линейная свёртка",
  "circular convolution": "циклическая свёртка",
  "cross-correlation": "взаимная корреляция",
  "autocorrelation": "автокорреляция",

  // Sampling / quantisation
  "sampling": "дискретизация",
  "sampling rate": "частота дискретизации",
  "sampling frequency": "частота дискретизации",
  "sampling period": "период дискретизации",
  "Nyquist": "Найквист",
  "Nyquist frequency": "частота Найквиста",
  "Nyquist rate": "частота Найквиста",
  "Nyquist criterion": "критерий Найквиста",
  "aliasing": "наложение спектров",
  "anti-aliasing": "антиалайсинговый",
  "oversampling": "передискретизация",
  "downsampling": "понижение частоты дискретизации",
  "upsampling": "повышение частоты дискретизации",
  "decimation": "децимация",
  "interpolation": "интерполяция",
  "quantization": "квантование",
  "quantization error": "ошибка квантования",
  "quantization noise": "шум квантования",

  // Misc
  "pole": "полюс",
  "zero": "нуль",
  "pole-zero plot": "карта полюсов и нулей",
  "region of convergence": "область сходимости",
  "ROC": "ОС",
  "magnitude": "модуль",
  "phase": "фаза",
  "spectrum": "спектр",
  "power spectrum": "спектр мощности",
  "window function": "оконная функция",
  "Hamming window": "окно Хэмминга",
  "Hanning window": "окно Хэннинга",
  "Blackman window": "окно Блэкмана",
  "Kaiser window": "окно Кайзера",
  "rectangular window": "прямоугольное окно",
  "signal-to-noise ratio": "отношение сигнал/шум",
  "SNR": "ОСШ",
  "noise": "шум",
  "white noise": "белый шум",

  // Homework boilerplate
  "Homework": "Домашнее задание",
  "Problem": "Задача",
  "Solution": "Решение",
  "Example": "Пример",
  "Show that": "Покажите, что",
  "Find": "Найдите",
  "Determine": "Определите",
  "Compute": "Вычислите",
  "Prove": "Докажите",
  "Consider": "Рассмотрим",
  "Assume": "Предположим",
  "Note that": "Заметим, что",
  "Hint": "Указание",
  "Copyright": "",
};

/** Render the static DSP glossary as a system-prompt fragment. */
export function dspGlossaryPrompt(max = 60): string {
  const entries = Object.entries(DSP_GLOSSARY).filter(([, ru]) => ru.length > 0);
  const lines = entries.slice(0, max).map(([en, ru]) => `  - ${en} → ${ru}`);
  return [
    "",
    "TERMINOLOGY (use these EXACT Russian equivalents — they are the МИЭТ academic standard):",
    ...lines,
  ].join("\n");
}

/**
 * Post-process pass: substitute leftover English terms by their Russian
 * equivalent. Case-insensitive but only matches whole-word occurrences.
 * Skips substitutions inside math delimiters ($…$ and $$…$$) and inside
 * fenced code blocks, so LaTeX identifiers stay intact.
 */
export function applyGlossaryPost(text: string): string {
  if (!text) return text;
  // Split off protected segments (math, code) so we don't replace inside them.
  const protectedRe = /(\$\$[\s\S]*?\$\$|\$[^\n$]*?\$|`[^`\n]*`|```[\s\S]*?```)/g;
  const parts = text.split(protectedRe);
  // Build entries sorted by length desc to prefer multi-word matches first.
  const entries = Object.entries(DSP_GLOSSARY)
    .filter(([, ru]) => ru.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (let i = 0; i < parts.length; i++) {
    // Odd-indexed parts are protected (since the regex has a group).
    if (i % 2 === 1) continue;
    let chunk = parts[i];
    for (const [en, ru] of entries) {
      // Escape regex specials in English term.
      const pat = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${pat}\\b`, "gi");
      chunk = chunk.replace(re, ru);
    }
    parts[i] = chunk;
  }
  return parts.join("");
}
