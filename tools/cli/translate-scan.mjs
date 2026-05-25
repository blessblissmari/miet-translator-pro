// OCR + translate path for image-only / scanned PDFs.
// Renders each page to PNG via pdftoppm, then sends to a vision model.
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { chat, mapWithConcurrency, stripCodeFences } from "./lib/mimo.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./lib/glossary.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) { console.error("MIMO_API_KEY not set"); process.exit(1); }
const MODEL = process.env.MODEL || "mimo-v2.5-pro";

const PROMPT = `Ты — академический переводчик и OCR-ассистент для российского университета (МИЭТ — Цифровая обработка сигналов).

ВХОД: фотография/скан страницы англоязычной домашней работы или решения по ЦОС (Mitra textbook style). Текст может быть рукописным или печатным.

ЗАДАЧА: распознать ВЕСЬ текст и формулы и перевести страницу на формальный академический русский, выдав чистый Markdown.

ПРАВИЛА:
1. Output ONLY Markdown. No preamble.
2. Math: $...$ inline, $$...$$ display. Никаких \\[..\\] или \\(..\\).
3. Заголовки задач: «**Задача N.**», ответы: «**Решение.**» / «**Ответ.**».
4. Сохраняй имена переменных: x[n], H(z), X(e^{jω}).
5. Колонтитулы / номера страниц / даты / имена («Homework 2 – Fall 2018») — выпускай как нормальный текст ОДИН раз сверху.
6. Если страница рукописная — постарайся максимально точно расшифровать; если что-то неразборчиво — пометь «**[неразборчиво]**».
7. Чисто формальный академический стиль, без диалога.

` + dspGlossaryPrompt(60);

function normalizeMathDelims(s) {
  return s
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, b) => `\n\n$$${b.trim()}$$\n\n`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, b) => `$${b.trim()}$`);
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${stderr}`)));
  });
}

async function renderPages(pdfPath, outDir) {
  // pdftoppm renders 1.pdf → outDir/page-01.png, etc.
  await mkdir(outDir, { recursive: true });
  await runCmd("pdftoppm", ["-r", "150", "-png", pdfPath, path.join(outDir, "page")]);
  const fs = await import("node:fs/promises");
  const files = (await fs.readdir(outDir)).filter(f => f.endsWith(".png")).sort();
  return files.map((f, i) => ({ index: i, path: path.join(outDir, f) }));
}

async function translatePage(pageImagePath, pageIndex) {
  const buf = await readFile(pageImagePath);
  const b64 = buf.toString("base64");
  const dataUrl = `data:image/png;base64,${b64}`;
  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: [
      { type: "text", text: `Это страница ${pageIndex + 1}. Распознай и переведи всё содержимое в академический русский Markdown.` },
      { type: "image_url", image_url: { url: dataUrl } },
    ]},
  ];
  const raw = await chat({ apiKey, model: MODEL, messages, maxTokens: 6000, temperature: 0.1 });
  return applyGlossaryPost(normalizeMathDelims(stripCodeFences(raw)));
}

function runPandoc(mdPath, outPath) {
  return runCmd("pandoc", [mdPath, "-o", outPath, "--from", "markdown+tex_math_dollars", "--to", "docx", "--standalone"]);
}

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node translate-scan.mjs <pdf...>"); process.exit(1); }

const outDir = process.env.OUT_DIR || "./outputs";
const mdDir  = (process.env.OUT_DIR || "./outputs") + "/markdown";
await mkdir(outDir, { recursive: true });
await mkdir(mdDir, { recursive: true });

for (const pdfPath of inputs) {
  const t0 = Date.now();
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} (scan/OCR via ${MODEL}) ===`);
  const tmpDir = `/tmp/scan_${base}`;
  await rm(tmpDir, { recursive: true, force: true });
  const pages = await renderPages(pdfPath, tmpDir);
  console.log(`  rendered ${pages.length} page images`);
  let done = 0;
  const sections = await mapWithConcurrency(pages, 2, async (p) => {
    try {
      const md = await translatePage(p.path, p.index);
      done++;
      process.stdout.write(`\r  translated ${done}/${pages.length}…`);
      return md;
    } catch (e) {
      done++;
      process.stdout.write(`\r  translated ${done}/${pages.length} (err: ${e.message.slice(0,60)})…`);
      return `\n\n> *[Ошибка OCR стр. ${p.index + 1}: ${e.message}]*\n\n`;
    }
  });
  console.log();
  let md = `# ${base}\n\n`;
  sections.forEach(s => { md += s.trim() + "\n\n"; });
  md = sanitizeLatexMath(md);
  const mdPath = path.join(mdDir, `${base}_ru.md`);
  await writeFile(mdPath, md);
  const docxPath = path.join(outDir, `${base}_ru.docx`);
  await runPandoc(mdPath, docxPath);
  const ms = Date.now() - t0;
  console.log(`  ✓ ${docxPath}  (${(ms/1000).toFixed(1)}s)`);
}
