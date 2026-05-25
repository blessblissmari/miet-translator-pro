// Post-translation cleanup for Russian academic output.
//
// 1. Latin subpart letters (a)/(b)/(c) -> Cyrillic (а)/(б)/(в).
// 2. Catch English phrases that the model left untranslated.
// 3. Enforce DSP glossary preferences where the model picked synonyms.
// 4. Drop publisher boilerplate (Mitra copyright lines, page-N footers).
//
// Math-safe: anything inside $...$ or $$...$$ is preserved verbatim.

const SUBPART_LATIN = {
  a: "а", b: "б", c: "в", d: "г", e: "д", f: "е", g: "ж",
  h: "з", i: "и", j: "к", k: "л", l: "м", m: "н",
  // Capital — rarely used but supported.
  A: "А", B: "Б", C: "В", D: "Г", E: "Д", F: "Е", G: "Ж",
  H: "З", I: "И", J: "К", K: "Л", L: "М", M: "Н",
};

// English phrases that academic translators commonly leave behind.
const EN_PHRASES = [
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
const GLOSSARY_PREFER = [
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
const BOILERPLATE = [
  /^Copyright\s*©.*$/im,
  /^©\s*\d{4}.*Mitra.*$/im,
  /^S\.\s*K\.\s*Mitra$/im,
  /^Стр\.?\s*\d+$/im,
  /^Page\s*\d+$/im,
];

/** Replace inside non-math segments only. */
function processOutsideMath(text, fn) {
  // Split by $...$ / $$...$$, leave math as-is.
  const re = /(\$\$[\s\S]*?\$\$|\$[^\n$]+?\$)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push({ kind: "math", value: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ kind: "text", value: text.slice(last) });
  return parts.map(p => p.kind === "math" ? p.value : fn(p.value)).join("");
}

function fixSubparts(s) {
  // Match enumeration markers like " (a) ", "(a):", "(a)."  — but NOT (n+1), (e^{jω}) etc.
  // Heuristic: single ASCII letter between parens, surrounded by space/start/punct.
  return s.replace(/(^|[\s>«—–\-])\(([a-mA-M])\)(?=[\s.,:;)»\n]|$)/g, (m, pre, letter) => {
    const ru = SUBPART_LATIN[letter];
    return ru ? `${pre}(${ru})` : m;
  });
}

function fixEnglishPhrases(s) {
  for (const [re, rep] of EN_PHRASES) s = s.replace(re, rep);
  return s;
}

function fixGlossary(s) {
  for (const [re, rep] of GLOSSARY_PREFER) {
    if (typeof rep === "function") s = s.replace(re, rep);
    else s = s.replace(re, rep);
  }
  return s;
}

function dropBoilerplate(s) {
  return s.split("\n").filter(line => !BOILERPLATE.some(re => re.test(line.trim()))).join("\n");
}

/** Main entrypoint — apply all polish passes. */
export function polishRu(md) {
  let out = dropBoilerplate(md);
  out = processOutsideMath(out, (chunk) => {
    chunk = fixSubparts(chunk);
    chunk = fixEnglishPhrases(chunk);
    chunk = fixGlossary(chunk);
    return chunk;
  });
  return out;
}
