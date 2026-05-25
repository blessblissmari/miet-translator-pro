// Page-level "detect-and-redraw" for slides whose figures are vector graphics
// that pdfimages cannot extract (matplotlib plots embedded as PDF vectors).
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { chat } from "./openrouter.mjs";

const PROMPT = `Ты — научный иллюстратор для университетского курса ЦОС.

ВХОД: полный скриншот одного слайда из учебной презентации (английский).

ЗАДАЧА:
1. Определи, есть ли на слайде НЕТРИВИАЛЬНЫЙ научный рисунок — график, диаграмма
   нулей-полюсов, импульсный/частотный отклик, спектр, схема фильтра.
2. Текст, маркированные списки, отдельные формулы или уравнения НЕ считаются
   рисунком.
3. Если рисунка НЕТ — выведи строго одно слово: NONE
4. Если рисунок ЕСТЬ — выведи только Python-код (matplotlib + numpy), который
   ПЕРЕРИСОВЫВАЕТ ТОЛЬКО этот рисунок (без заголовка слайда, без буллетов,
   без формул, без копирайта).

Правила для кода (если рисунок есть):
- "import matplotlib"; matplotlib.use("Agg"); import matplotlib.pyplot as plt; import numpy as np
- ВСЕ переменные определены явно (T = 1.0, N = 16, A = 1.0 — числа)
- Стиль: чёрные линии и стрелки, белый фон, шрифт >= 14pt
- В конце: plt.savefig(OUT_PATH, dpi=200, bbox_inches="tight"); plt.close("all")
- НЕ определяй OUT_PATH сам — обёртка задаст переменную
- Подписи осей и легенда переведены на русский если на слайде они есть
- Воспроизведи числовые отметки максимально близко к оригиналу
- Без markdown-обёрток, без \`\`\`, без объяснений — только код
- Если код НЕ помещается — сохрани суть рисунка, можно упростить детали`;

function stripFences(s) {
  return s
    .replace(/^\s*```(?:python|py)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function wrapForSandbox(code, outPath) {
  return [
    "import os, sys",
    `OUT_PATH = ${JSON.stringify(outPath)}`,
    "try:",
    ...code.split("\n").map(l => "    " + l),
    "except Exception as e:",
    "    sys.stderr.write(f'REDRAW_FAIL: {e}\\n')",
    "    sys.exit(2)",
  ].join("\n");
}

function runPython(scriptPath) {
  return new Promise((resolve) => {
    const p = spawn("python3", [scriptPath]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("close", code => resolve({ ok: code === 0, err }));
  });
}

function runPdftoppm(pdfPath, pageNum, outPng) {
  return new Promise((resolve, reject) => {
    const p = spawn("pdftoppm", ["-r", "150", "-f", String(pageNum), "-l", String(pageNum),
      "-singlefile", "-png", pdfPath, outPng.replace(/\.png$/, "")]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("close", c => c === 0 ? resolve() : reject(new Error("pdftoppm failed: " + err)));
  });
}

const MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
];

export async function pageRedraw({ apiKey, pdfPath, pageNum, workDir, models = MODELS }) {
  await mkdir(workDir, { recursive: true });
  const base = `slide-${String(pageNum).padStart(3, "0")}`;
  const outPath = path.join(workDir, `${base}_redrawn.png`);
  const sentinelPath = path.join(workDir, `${base}_none.txt`);
  const pagePng = path.join(workDir, `${base}_page.png`);

  // Cache hits
  try { await stat(outPath); return outPath; } catch {}
  try { await stat(sentinelPath); return null; } catch {}

  await runPdftoppm(pdfPath, pageNum, pagePng);
  const imgBytes = await readFile(pagePng);
  const b64 = imgBytes.toString("base64");

  for (const model of models) {
    try {
      const reply = await chat({
        apiKey, model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        }],
        maxTokens: 4000,
        temperature: 0,
        retries: 2,
      });
      const txt = (reply || "").trim();
      if (/^NONE\b/i.test(txt) || txt.length < 30) {
        await writeFile(sentinelPath, "no figure");
        return null;
      }
      const code = stripFences(txt);
      if (!/savefig\(/.test(code)) continue;
      const scriptPath = path.join(workDir, `${base}.py`);
      await writeFile(scriptPath, wrapForSandbox(code, outPath));
      const { ok, err } = await runPython(scriptPath);
      if (ok) {
        try { await stat(outPath); return outPath; } catch {}
      } else {
        process.stderr.write(`  pageRedraw ${pageNum} ${model}: ${err.split("\n")[0]}\n`);
      }
    } catch (e) {
      process.stderr.write(`  pageRedraw ${pageNum} ${model} threw: ${(e.message || "").slice(0, 80)}\n`);
    }
  }
  return null;
}

export async function pageRedrawAll({ apiKey, pdfPath, pages, workDir, onProgress }) {
  await mkdir(workDir, { recursive: true });
  const results = {};
  for (let i = 0; i < pages.length; i++) {
    const pn = pages[i];
    onProgress?.(i, pages.length, pn);
    const r = await pageRedraw({ apiKey, pdfPath, pageNum: pn, workDir });
    if (r) results[pn] = r;
  }
  return results;
}
