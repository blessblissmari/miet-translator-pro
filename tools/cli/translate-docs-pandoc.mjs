// Higher-quality DOCX pipeline:
//   PDF → text/page → translate page → MARKDOWN with $..$ / $$..$$ →
//   concat → pandoc → DOCX with native OMML math.
//
// This matches the уренцев reference quality (real Office equations).
//
// Usage: node translate-docs-pandoc.mjs <pdf...>
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractPdf } from "./lib/extractPdf.mjs";
import { chat, mapWithConcurrency, stripCodeFences } from "./lib/openrouter.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./lib/glossary.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";

const apiKey = process.env.OPENROUTER_API_KEY_ONE;
if (!apiKey) { console.error("OPENROUTER_API_KEY_ONE not set"); process.exit(1); }
const MODEL = process.env.MODEL || "openai/gpt-oss-120b:free";

const TARGET_LANG = "Russian";

const DOC_PROMPT = (lang) =>
  `You are a senior technical translator producing Russian university coursework
(МИЭТ — Цифровая обработка сигналов, Mitra textbook style).

TASK: Translate one academic PDF page (raw extracted text below) into ${lang} Markdown.

STRICT RULES:
1. Output ONLY clean Markdown — no preamble, no \`\`\` fences, no notes.
2. Headings: use # / ## / ### for Chapter / Section / Subsection.
3. Examples: render as "**Пример E3.1.**" (bold, period), "**Ответ.**" likewise.
4. Math MUST use LaTeX delimiters:
   - inline: $...$
   - display: $$...$$  on its OWN line, surrounded by blank lines.
   - DO NOT use \\[ ... \\] or \\( ... \\) — only $ / $$.
5. Inside math, use LaTeX commands: \\alpha \\beta \\omega \\varphi \\mu
   \\sum_{n=0}^{N-1} \\frac{a}{b} e^{j\\omega} x[n] H(z) \\cdot \\sin \\cos \\log
   \\cdot \\to \\Rightarrow \\leq \\geq \\neq \\infty.
6. Multi-line equations: use $$\\begin{aligned} ... \\end{aligned}$$ or
   simply consecutive display equations.
7. Lists: bullet lines start with "- " ; numbered lists "1." "2." etc.
8. Tables: GitHub-flavored Markdown |...|...|.
9. DROP these unconditionally: running headers/footers, page numbers like
   "- 1 -" or "Chapter 3 - 14", copyright lines ("Copyright © 2010, S. K. Mitra").
10. Keep variable names verbatim: x[n], H(z), e^{jω}, X(e^{jω}). Don't translate identifiers.
11. Translate prose into formal Russian academic style. Examples:
    "Find" → «Найдите»; "Show that" → «Покажите, что»; "Determine" → «Определите»;
    "Solution" → «Решение»; "Hence" → «Следовательно»; "Therefore" → «Отсюда»;
    "Note that" → «Заметим, что»; "Let" → «Пусть».
` + dspGlossaryPrompt(60);

function normalizeMathDelims(s) {
  return s
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, b) => `\n\n$$${b.trim()}$$\n\n`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, b) => `$${b.trim()}$`);
}

async function translatePage(page) {
  const text = page.text.length > 8000 ? page.text.slice(0, 8000) + "\n…[truncated]" : page.text;
  const messages = [
    { role: "system", content: DOC_PROMPT(TARGET_LANG) },
    { role: "user", content: `Page ${page.index + 1} raw text:\n---\n${text}\n---\nTranslate to Russian Markdown.` },
  ];
  const raw = await chat({ apiKey, model: MODEL, messages, maxTokens: 8000, temperature: 0.15 });
  const cleaned = applyGlossaryPost(normalizeMathDelims(stripCodeFences(raw)));
  return cleaned;
}

function runPandoc(mdPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      mdPath,
      "-o", outPath,
      "--from", "markdown+tex_math_dollars+tex_math_double_backslash+pipe_tables",
      "--to", "docx",
      "--standalone",
    ];
    const p = spawn("pandoc", args);
    let stderr = "";
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`pandoc exit ${code}: ${stderr}`)));
  });
}

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-docs-pandoc.mjs <pdf...>"); process.exit(1); }

const outDir = process.env.OUT_DIR || "./outputs";
const mdDir  = (process.env.OUT_DIR || "./outputs") + "/markdown";
await mkdir(outDir, { recursive: true });
await mkdir(mdDir, { recursive: true });

const report = [];
for (const pdfPath of inputs) {
  const t0 = Date.now();
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} ===`);
  try {
    const pages = await extractPdf(pdfPath);
    console.log(`  pages=${pages.length}`);
    let done = 0;
    const sections = await mapWithConcurrency(pages, 4, async (p) => {
      try {
        const md = await translatePage(p);
        done++;
        process.stdout.write(`\r  translated ${done}/${pages.length}…`);
        return md;
      } catch (e) {
        done++;
        process.stdout.write(`\r  translated ${done}/${pages.length} (err: ${e.message.slice(0,50)})…`);
        return `\n\n> *[Ошибка перевода стр. ${p.index + 1}: ${e.message}]*\n\n`;
      }
    });
    console.log();
    // Concatenate with explicit page separators
    let md = `# ${base}\n\n`;
    sections.forEach((s, i) => {
      md += s.trim() + "\n\n";
    });
    md = sanitizeLatexMath(md);
    const mdPath = path.join(mdDir, `${base}_ru.md`);
    await writeFile(mdPath, md, "utf8");
    const docxPath = path.join(outDir, `${base}_ru.docx`);
    await runPandoc(mdPath, docxPath);
    const stat = await readFile(docxPath);
    const ms = Date.now() - t0;
    console.log(`  ✓ ${docxPath}  (${(ms / 1000).toFixed(1)}s, ${stat.length} bytes)`);
    report.push({ file: base, status: "ok", pages: pages.length, ms });
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    report.push({ file: base, status: "error", err: e.message });
  }
}

console.log("\n--- summary ---");
for (const r of report) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.file}`);
