import { chat, stripCodeFences, mapWithConcurrency } from "./mimo.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./glossary.mjs";

const TARGET_LANG = "Russian";

// Normalize stray LaTeX delimiters to $/$$.
function normalizeMathDelims(text) {
  // Display \[ ... \]  →  $$ ... $$
  text = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  // Inline   \( ... \)  →  $ ... $
  text = text.replace(/\\\(\s*([^\n]*?)\s*\\\)/g, (_m, body) => `$${body.trim()}$`);
  // \begin{equation} ... \end{equation} → $$ ... $$
  text = text.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`);
  // \begin{align*?} ... \end{align*?} → $$ \begin{aligned} ... \end{aligned} $$
  text = text.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_m, body) =>
    `\n$$\n\\begin{aligned}\n${body.trim()}\n\\end{aligned}\n$$\n`,
  );
  return text;
}

const DOC_TRANSLATE_PROMPT = (lang) =>
  `You are a senior technical translator specializing in academic and engineering literature for Russian universities (МИЭТ — Цифровая обработка сигналов, Mitra textbook style).

Task: translate the academic page below into ${lang} ("русский"), with formal Russian university coursework tone.

STYLE rules:
- Use formal, academic ${lang}.
- "Homework" → «Домашнее задание»; "Problem N" / "Question N" → «Задача N»; "Solution" → «Решение»; "Part (a)" → «Часть (а)»; "Show that" → «Покажите, что»; "Find" → «Найдите»; "Example E3.1" → «Пример Е3.1» (keep numbering).
- Do NOT translate code, identifiers, variable names, units, or proper names (Mitra, Butterworth, MOSFET, etc.).
- Preserve abbreviations and acronyms verbatim or per glossary.

STRUCTURE rules:
- Output ONLY translated Markdown. No commentary. No code fences. No "Here is the translation".
- Preserve EVERY mathematical formula. Inline math: $...$ — display math: $$...$$ on its own line. NEVER drop a formula.
- Use Markdown structure: "# Title" only if a true page title is present; "## Heading" / "### Subheading"; "- item" / "1. item" for lists.
- Preserve example/problem numbering ("E3.1", "(a)", "(б)").
- Tables → Markdown tables.
- Skip running headers/footers/copyright/page numbers entirely.
- Math delimiters MUST be $...$ or $$...$$ — never \\( \\) or \\[ \\]. Multi-line environments (cases/align) MUST be inside $$ ... $$.
` + dspGlossaryPrompt();

export async function translateDocPages(pages, opts) {
  const { apiKey, model, signal, onProgress, concurrency = 3 } = opts;
  let done = 0;
  return mapWithConcurrency(pages, concurrency, async (page, i) => {
    const out = await chat({
      apiKey,
      model,
      maxTokens: 4096,
      temperature: 0.2,
      signal,
      messages: [
        { role: "system", content: DOC_TRANSLATE_PROMPT(TARGET_LANG) },
        {
          role: "user",
          content: `Translate the following page (page ${i + 1}) to ${TARGET_LANG}. Output Markdown per the rules.\n\n${page.text.slice(0, 12000)}`,
        },
      ],
    });
    done++;
    onProgress?.(done, pages.length);
    return applyGlossaryPost(normalizeMathDelims(stripCodeFences(out)));
  });
}

// Parse Markdown (with $…$ inline math) to a sequence of DocBlocks.
export function parseMarkdownToBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let listItems = [];
  let listOrdered = false;
  let listActive = false;
  let inDisplay = false;
  let displayBuf = [];
  let paraBuf = [];

  const flushList = () => {
    if (listActive && listItems.length) blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
    listActive = false;
  };
  const flushPara = () => {
    const t = paraBuf.join(" ").replace(/\s+/g, " ").trim();
    if (t) blocks.push({ type: "para", text: t });
    paraBuf.length = 0;
  };

  for (let line of lines) {
    if (inDisplay) {
      if (/\$\$/.test(line)) {
        const idx = line.indexOf("$$");
        displayBuf.push(line.slice(0, idx));
        blocks.push({ type: "formula", latex: displayBuf.join("\n").trim(), display: true });
        displayBuf = [];
        inDisplay = false;
        const rest = line.slice(idx + 2).trim();
        if (rest) paraBuf.push(rest);
        continue;
      }
      displayBuf.push(line);
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      flushPara();
      flushList();
      // Display starts; if ends on same line:
      const m = line.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
      if (m) {
        blocks.push({ type: "formula", latex: m[1].trim(), display: true });
      } else {
        inDisplay = true;
        displayBuf = [line.replace(/^\s*\$\$/, "")];
      }
      continue;
    }
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h1) { flushPara(); flushList(); blocks.push({ type: "h1", text: h1[1].trim() }); continue; }
    if (h2) { flushPara(); flushList(); blocks.push({ type: "h2", text: h2[1].trim() }); continue; }
    if (h3) { flushPara(); flushList(); blocks.push({ type: "h3", text: h3[1].trim() }); continue; }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ol) {
      if (!listActive || !listOrdered) { flushPara(); flushList(); listActive = true; listOrdered = true; }
      listItems.push(ol[2].trim()); continue;
    }
    if (ul) {
      if (!listActive || listOrdered) { flushPara(); flushList(); listActive = true; listOrdered = false; }
      listItems.push(ul[1].trim()); continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    if (listActive) {
      listItems[listItems.length - 1] += " " + line.trim();
    } else {
      paraBuf.push(line);
    }
  }
  if (inDisplay) blocks.push({ type: "formula", latex: displayBuf.join("\n").trim(), display: true });
  // final flush
  const t = paraBuf.join(" ").replace(/\s+/g, " ").trim();
  if (t) blocks.push({ type: "para", text: t });
  if (listActive && listItems.length) blocks.push({ type: "list", ordered: listOrdered, items: listItems });
  return blocks;
}
