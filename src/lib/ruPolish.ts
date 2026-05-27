// Post-translation cleanup for Russian academic output.
//
// 1. Latin subpart letters (a)/(b)/(c) -> Cyrillic (а)/(б)/(в).
// 2. Catch English phrases that the model left untranslated.
// 3. Enforce DSP glossary preferences where the model picked synonyms.
// 4. Drop publisher boilerplate (Mitra copyright lines, page-N footers).
//
// Math-safe: anything inside $...$ or $$...$$ is preserved verbatim.

const SUBPART_LATIN: Record<string, string> = {
  a: "а", b: "б", c: "в", d: "г", e: "д", f: "е", g: "ж",
  h: "з", i: "и", j: "к", k: "л", l: "м", m: "н",
  // Capital — rarely used but supported.
  A: "А", B: "Б", C: "В", D: "Г", E: "Д", F: "Е", G: "Ж",
  H: "З", I: "И", J: "К", K: "Л", L: "М", M: "Н",
};

// English phrases that academic translators commonly leave behind.
const EN_PHRASES: [RegExp, string][] = [
  [/\bBased on\b/g, "На основании"],
  [/\bThe system is\b/g, "Система является"],
  [/\bThe system\b/g, "Система"],
  [/\bIt is used for\b/g, "Используется для"],
  [/\bIt is used to\b/g, "Используется чтобы"],
  [/\bHence\b/g, "Следовательно"],
  [/\bTherefore\b/g, "Следовательно"],
  [/\bThus\b/g, "Таким образом"],
  [/\bHowever\b/g, "Однако"],
  [/\bIn other words\b/g, "Иными словами"],
  [/\bFor example\b/g, "Например"],
  [/\bNote that\b/g, "Отметим что"],
  [/\bShow that\b/gi, "Показать что"],
  [/\bGiven that\b/g, "Дано что"],
  [/\bAssume that\b/g, "Предположим что"],
  [/\bLet\b/g, "Пусть"],
  [/\bsuch that\b/g, "такой что"],
  [/\bwith respect to\b/gi, "относительно"],
  [/\blinear\b/gi, "линейная"],
  [/\btime-invariant\b/gi, "стационарная"],
  [/\bcausal\b/gi, "причинная"],
  [/\bmemoryless\b/gi, "без памяти"],
  [/\bstable\b/gi, "устойчивая"],
  [/\bsignal\b/gi, "сигнал"],
  [/\bsystem\b/gi, "система"],
  [/\bproof\b/gi, "доказательство"],
  [/\bsolution\b/gi, "решение"],
  [/\banswer\b/gi, "ответ"],
];

// Glossary preferences — model sometimes picks a synonym we don't want.
const GLOSSARY_PREFER: ([RegExp, string] | [RegExp, (m: string, ...args: string[]) => string])[] = [
  // "каузальн*" -> "причинн*" (Cyrillic-aware boundary).
  [/(?<![а-яёa-zA-Z])каузальн([а-яё]{1,3})(?![а-яёa-zA-Z])/gi, (_m, ending) => `причинн${ending}`],
  [/(?<![а-яёa-zA-Z])низкочастотн[а-яё]+\s+фильтр[а-яё]*/gi, "фильтр нижних частот"],
  [/(?<![а-яёa-zA-Z])высокочастотн[а-яё]+\s+фильтр[а-яё]*/gi, "фильтр верхних частот"],
  [/\bимпульс[нi]ая\s+характеристика/gi, "импульсная характеристика"],
  // Stray English articles left over from partial translation.
  [/\bthe\s+(?=[А-Яа-я])/g, ""],
  [/\bis\s+(?=[А-Яа-я])/g, "— "],
  [/\ba\s+(?=[А-Яа-я])/g, ""],
];

// Boilerplate lines to drop entirely.
const BOILERPLATE: RegExp[] = [
  /^Copyright\s*©.*$/im,
  /^©\s*\d{4}.*Mitra.*$/im,
  /^S\.\s*K\.\s*Mitra$/im,
  /^Стр\.?\s*\d+$/im,
  /^Page\s*\d+$/im,
];

/** Replace inside non-math segments only. */
function processOutsideMath(text: string, fn: (chunk: string) => string): string {
  // Split by $...$ / $$...$$, leave math as-is.
  const re = /(\$\$[\s\S]*?\$\$|\$[^\n$]+?\$)/g;
  const parts: { kind: "text" | "math"; value: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push({ kind: "math", value: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ kind: "text", value: text.slice(last) });
  return parts.map((p) => (p.kind === "math" ? p.value : fn(p.value))).join("");
}

function fixSubparts(s: string): string {
  // Match enumeration markers like " (a) ", "(a):", "(a)."  — but NOT (n+1), (e^{jω}) etc.
  // Heuristic: single ASCII letter between parens, surrounded by space/start/punct.
  return s.replace(/(^|[\s>«—–\-])\(([a-mA-M])\)(?=[\s.,:;)»\n]|$)/g, (_m: string, pre: string, letter: string): string => {
    const ru = SUBPART_LATIN[letter];
    return ru ? `${pre}(${ru})` : _m;
  });
}

function fixEnglishPhrases(s: string): string {
  for (const [re, rep] of EN_PHRASES) s = s.replace(re, rep);
  return s;
}

function fixGlossary(s: string): string {
  for (const [re, rep] of GLOSSARY_PREFER) {
    if (typeof rep === "function") s = s.replace(re, rep);
    else s = s.replace(re, rep);
  }
  return s;
}

function dropBoilerplate(s: string): string {
  return s.split("\n").filter((line: string) => !BOILERPLATE.some(re => re.test(line.trim()))).join("\n");
}

/** Strip Chinese / Japanese / Korean characters that MiMo (Xiaomi) occasionally
 *  leaks into Russian prose (e.g. `без 记忆ной` ← `memory`). Map a few common
 *  technical morphemes to Russian roots; for anything we don't recognise, drop
 *  the CJK run entirely so
 */
function scrubCJK(s: string): string {
  if (!s) return s;
  const CJK_RUN = /[\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]+/g;
  const MAP: Record<string, string> = {
    "记忆": "памят",
    "系统": "систем",
    "输入": "вход",
    "输出": "выход",
    "信号": "сигнал",
    "线性": "линейн",
    "因果": "причинн",
    "稳定": "устойчив",
    "响应": "отклик",
    "频率": "частота",
    "函数": "функция",
    "时间": "время",
    "滤波": "фильтр",
  };
  return s.replace(CJK_RUN, (run) => MAP[run] ?? "");
}

/** Main entrypoint — apply all polish passes. */
export function polishRu(md: string): string {
  let out = scrubCJK(md);
  out = dropBoilerplate(out);
  out = processOutsideMath(out, (chunk: string): string => {
    chunk = fixSubparts(chunk);
    chunk = fixEnglishPhrases(chunk);
    chunk = fixGlossary(chunk);
    return chunk;
  });
  return out;
}
