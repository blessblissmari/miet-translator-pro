// Re-translate an existing MinerU english.md without re-fetching from MinerU.
//   Usage: node retranslate.mjs <workdir>
//   Where workdir contains english.md.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chat, mapWithConcurrency } from "./lib/mimo.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./lib/glossary.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";
import { polishRu } from "./lib/ruPolish.mjs";

const apiKey = process.env.MIMO_API_KEY;
if (!apiKey) { console.error("Need MIMO_API_KEY"); process.exit(1); }
const MODEL = process.env.MODEL || "mimo-v2.5-pro";

const PROMPT = `Ты — академический переводчик для российского университета (МИЭТ — ЦОС).

ВХОД: фрагмент английского Markdown (из MinerU OCR). Содержит $..$ и $$..$$ math, заголовки, списки, таблицы, *[Эскиз]* блоки с описанием рисунков.

ЗАДАНИЕ: переведи в русский академический стиль.

ОБЯЗАТЕЛЬНО:
1. ВЕСЬ английский текст → русский. "Problem"/"Solution"/"Answer"/"Based on"/"Let"/"Note" → "Задача"/"Решение"/"Ответ"/"Исходя из"/"Пусть"/"Замечание".
2. Подзадачи (a)(b)(c)(d)... → (а)(б)(в)(г)(д)(е)(ж).
3. Формулы $..$, $$..$$ — НЕ переводи, оставь как есть (можно убрать лишние пробелы между символами вроде "u [ n ]" → "u[n]").
4. Имена переменных латиницей.
5. Markdown структура (#, -, |) сохраняется. ![](...) — оставь как есть.
6. *[Эскиз]* блоки переведи: содержимое (описание рисунка) на русском.

${dspGlossaryPrompt()}

ВЕРНИ ТОЛЬКО ПЕРЕВЕДЁННЫЙ MARKDOWN, без \`\`\`, без объяснений.`;

function cleanMineruMarkdown(md) {
  md = md.replace(/<details>\s*<summary>\s*text_image\s*<\/summary>([\s\S]*?)<\/details>/g,
    (_m, body) => `\n*[Эскиз]*\n${body.trim()}\n`);
  md = md.replace(/<details>\s*<summary>\s*line\s*<\/summary>([\s\S]*?)<\/details>/g,
    (_m, body) => "\n" + body.trim() + "\n");
  md = md.replace(/<\/?details>/g, "").replace(/<summary>[^<]*<\/summary>/g, "");
  return md;
}

function chunkByH(md) {
  const parts = md.split(/\n(?=#{1,2}\s)/);
  if (parts.length > 1) return parts;
  const out = [];
  for (let i = 0; i < md.length; i += 4000) out.push(md.slice(i, i + 4500));
  return out;
}

async function translateChunk(chunk) {
  const out = await chat({
    apiKey, model: MODEL, maxTokens: 12000,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: chunk },
    ],
  });
  return applyGlossaryPost(out.trim().replace(/^```[a-z]*\n?|\n?```$/g, ""));
}

function runPandoc(mdPath, outPath, resourcePath) {
  return new Promise((resolve, reject) => {
    const args = [
      mdPath, "-o", outPath,
      "--from", "markdown+tex_math_dollars+tex_math_double_backslash+pipe_tables",
      "--to", "docx", "--standalone", "--toc", "--toc-depth=2",
    ];
    if (resourcePath) args.push("--resource-path", resourcePath);
    const p = spawn("pandoc", args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (c) => c === 0 ? resolve() : reject(new Error("pandoc failed: " + c)));
    p.on("error", reject);
  });
}

const workDir = process.argv[2];
if (!workDir) { console.error("Usage: node retranslate.mjs <workdir>"); process.exit(1); }
const englishPath = path.join(workDir, "english.md");
const dir = path.join(workDir, "extracted");
const rawMd = await readFile(englishPath, "utf8");
const cleaned = cleanMineruMarkdown(rawMd);
await writeFile(path.join(workDir, "english_clean.md"), cleaned);
console.log(`cleaned ${rawMd.length} -> ${cleaned.length} chars`);

const chunks = chunkByH(cleaned);
console.log(`translating ${chunks.length} chunks...`);
let done = 0;
const translated = await mapWithConcurrency(chunks, 3, async (c) => {
  const r = await translateChunk(c);
  done++;
  process.stderr.write(`\r  translated ${done}/${chunks.length}…`);
  return r;
});
process.stderr.write("\n");

const md = polishRu(sanitizeLatexMath(translated.join("\n\n")));
const mdPath = path.join(workDir, "russian.md");
await writeFile(mdPath, md);

const base = path.basename(workDir);
const outDir = process.env.OUT_DIR || "/home/.z/workspaces/con_lVFiPbfyeSo3NaBa/outputs";
const outPath = path.join(outDir, `${base}_ru.docx`);
await runPandoc(mdPath, outPath, dir);
console.log(`✓ ${outPath}`);
