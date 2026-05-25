// Hi-fi scan / handwriting pipeline using mineru.net cloud OCR.
//
//   PDF -> MinerU (OCR + structure) -> Markdown (English)
//      -> chunk by page -> translate via OpenRouter to Russian
//      -> sanitize math -> pandoc -> DOCX with native OMML
//
// Usage:  MINERU_TOKEN=... node translate-mineru.mjs <pdf...>
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { mineruExtractMarkdown } from "./lib/mineru.mjs";
import { chat, mapWithConcurrency } from "./lib/openrouter.mjs";
import { dspGlossaryPrompt, applyGlossaryPost } from "./lib/glossary.mjs";
import { sanitizeLatexMath } from "./lib/mathSanitize.mjs";
import { polishRu } from "./lib/ruPolish.mjs";

const apiKey = process.env.OPENROUTER_API_KEY_ONE;
const mineruToken = process.env.MINERU_TOKEN;
if (!apiKey || !mineruToken) {
  console.error("Need OPENROUTER_API_KEY_ONE and MINERU_TOKEN");
  process.exit(1);
}
const TARGET = "Russian";
const MODEL = process.env.MODEL || "openai/gpt-oss-120b:free";
const PROMPT = `Ты — академический переводчик для российского университета (МИЭТ — ЦОС).

ВХОД: фрагмент английского Markdown-перевода из MinerU (OCR/парсер PDF). Может содержать $..$ inline-math и $$..$$ display-math, заголовки, списки, таблицы.

ЗАДАНИЕ: ПЕРЕВЕДИ В РУССКИЙ АКАДЕМИЧЕСКИЙ СТИЛЬ.

ОБЯЗАТЕЛЬНО:
1. ВЕСЬ английский текст → русский. Никаких "Problem", "Solution", "Answer", "Based on", "Let", "Note". Только "Задача", "Решение", "Ответ", "Исходя из", "Пусть", "Замечание".
2. Подзадачи (a)(b)(c)... → (а)(б)(в)(г)(д)(е)(ж)(з)(и)(к).
3. Формулы $..$ и $$..$$ — НЕ переводи, оставь LaTeX как есть.
4. Имена переменных (x, n, N, T, ω, α) — латиница как в формулах.
5. Markdown структура (#, -, |) сохраняется.
6. НЕ добавляй комментарии, НЕ оборачивай в \`\`\`.

${dspGlossaryPrompt()}

ВЕРНИ ТОЛЬКО ПЕРЕВЕДЁННЫЙ MARKDOWN, без обёрток.`;

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

function cleanMineruMarkdown(md) {
  // <details><summary>text_image</summary>...</details> -> *[Эскиз]*\n...
  md = md.replace(/<details>\s*<summary>\s*text_image\s*<\/summary>([\s\S]*?)<\/details>/g,
    (_m, body) => `\n*[Эскиз]*\n${body.trim()}\n`);
  // <details><summary>line</summary>...</details> -> body (table)
  md = md.replace(/<details>\s*<summary>\s*line\s*<\/summary>([\s\S]*?)<\/details>/g,
    (_m, body) => "\n" + body.trim() + "\n");
  // Any remaining <details>/<summary>
  md = md.replace(/<\/?details>/g, "").replace(/<summary>[^<]*<\/summary>/g, "");
  return md;
}

function chunkByH(md) {
  // Chunk by top-level page markers MinerU inserts, OR by major headings.
  // Fall back to chunks of ~4000 chars on plain text.
  const parts = md.split(/\n(?=#{1,2}\s)/);
  if (parts.length > 1) return parts;
  // Char-based chunking
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

const outDir = process.env.OUT_DIR || process.env.OUT_DIR || "./outputs";
await mkdir(outDir, { recursive: true });

const report = [];
for (const pdfPath of process.argv.slice(2)) {
  const base = path.basename(pdfPath, ".pdf");
  console.log(`\n=== ${base} (MinerU OCR + translate) ===`);
  const t0 = Date.now();
  try {
    const workDir = path.join(outDir, "mineru", base);
    const { markdown: rawMd, dir } = await mineruExtractMarkdown({
      token: mineruToken, pdfPath, workDir, modelVersion: "vlm",
    });
    const markdown = cleanMineruMarkdown(rawMd);
    console.log(`  got ${rawMd.length} chars (cleaned to ${markdown.length}) of English markdown`);

    // Save raw + cleaned English markdown for inspection
    await writeFile(path.join(workDir, "english.md"), rawMd);
    await writeFile(path.join(workDir, "english_clean.md"), markdown);

    const chunks = chunkByH(markdown);
    console.log(`  translating ${chunks.length} chunk(s)…`);
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

    const outPath = path.join(outDir, `${base}_ru.docx`);
    await runPandoc(mdPath, outPath, dir);
    const stat = await import("node:fs/promises").then(m => m.stat(outPath));
    const ms = Date.now() - t0;
    console.log(`  ✓ ${outPath} (${(ms/1000).toFixed(1)}s, ${stat.size} bytes)`);
    report.push({ file: base, status: "ok", ms });
  } catch (e) {
    console.error(`  ✗ ${base}: ${e.message}`);
    report.push({ file: base, status: "err", err: e.message });
  }
}

console.log("\n--- summary ---");
for (const r of report) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.file} ${r.err || ""}`);
