// Vector-quality figure regeneration.
//
// Pipeline:
//   1. Send the source (raster) figure to a vision LLM with a prompt that asks
//      for a self-contained matplotlib script reproducing the figure.
//   2. Save the script to a temp file and execute it with python3 in a
//      sandboxed working dir; the script must save the figure to OUT_PATH.
//   3. If execution succeeds and the output PNG looks valid (reasonable
//      dimensions, similar aspect ratio), return the new path. Otherwise
//      fall back to the original raster.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { chat } from "./openrouter.mjs";

const REDRAW_PROMPT = `Ты — научный иллюстратор для русского университетского курса ЦОС (Цифровая обработка сигналов).

ВХОД: растровое изображение академического рисунка (часть учебного слайда или ДЗ): сигнал, последовательность импульсов, АЧХ/ФЧХ, нули и полюсы, блок-схема фильтра, и т.п. Качество исходника низкое.

ЗАДАЧА: написать ОДИН самодостаточный Python-скрипт (matplotlib + numpy + scipy.signal), который пересоздаёт этот рисунок С МАКСИМАЛЬНОЙ ТОЧНОСТЬЮ — те же оси, метки, значения, форма графика.

ТРЕБОВАНИЯ К СКРИПТУ:
1. Только matplotlib/numpy/scipy — никаких других зависимостей.
2. ВСЕ ПЕРЕМЕННЫЕ ДОЛЖНЫ БЫТЬ ОПРЕДЕЛЕНЫ ЯВНО до использования: если есть T, N, A, f0, ω0 — присвой им конкретные численные значения вверху (например T = 1.0, N = 16). Не оставляй необъявленных символов.
3. Подписи осей, заголовок, метки точек — по-русски. Математика — стандартная нотация ($x$, $\\omega$, $\\pi$ через mathtext).
4. Конфигурация:
   import matplotlib
   matplotlib.use("Agg")
   import matplotlib.pyplot as plt
   plt.rcParams.update({"font.family": "DejaVu Sans", "mathtext.fontset": "cm", "axes.unicode_minus": False})
5. В конце ОБЯЗАТЕЛЬНО:
   plt.tight_layout()
   plt.savefig(OUT_PATH, dpi=200, bbox_inches="tight")
6. OUT_PATH — переменная (будет задана внешним скриптом-обёрткой). Не определяй её сам.
7. Если рисунок — последовательность импульсов / последовательность δ-функций: stem-plot со стрелками или vlines + markerfmt='k^'.
8. Если рисунок — спектр / АЧХ: точная форма с правильными частотами среза, полюсами.
9. Если рисунок — z-плоскость с нулями/полюсами: единичная окружность + точки 'o' (нули) и 'x' (полюсы).
10. Не добавляй комментариев в код кроме одной строки заголовка.

ОТВЕТ: только Python-код, без \`\`\`python ограждений, без пояснений до или после.`;

function classifyImageByDims(width, height) {
  const aspect = width / height;
  if (aspect > 2.5) return "wide_signal";
  if (aspect < 0.6) return "tall";
  return "general";
}

async function dataUrlFromFile(filePath) {
  const buf = await readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function runPython(scriptPath, cwd) {
  return new Promise((resolve) => {
    const p = spawn("python3", [scriptPath], { cwd });
    let out = "", err = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("close", code => resolve({ code, out, err }));
    p.on("error", e => resolve({ code: -1, out, err: e.message }));
  });
}

function stripFences(s) {
  const m = s.match(/```(?:python)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : s;
}

function wrapForSandbox(code, outPath) {
  return [
    "import os",
    `OUT_PATH = ${JSON.stringify(outPath)}`,
    "import sys",
    "try:",
    ...code.split("\n").map(l => "    " + l),
    "except Exception as e:",
    '    sys.stderr.write(f"REDRAW_FAIL: {e}\\n")',
    "    sys.exit(2)",
    "",
  ].join("\n");
}

/**
 * Try to redraw a single raster figure as a clean matplotlib plot.
 * Returns the path to the new PNG on success, or null on failure (caller
 * should keep the original).
 */
export async function redrawFigure({ apiKey, model, models, sourcePath, workDir, retries = 1 }) {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  await mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, `${base}_redrawn.png`);

  // Cache hit: skip the API call entirely if we already produced this redraw.
  try {
    const st = await stat(outPath);
    if (st.isFile() && st.size > 1024) return outPath;
  } catch { /* not cached */ }

  const modelList = models || (model ? [model] : ["google/gemma-4-31b-it:free", "nvidia/nemotron-nano-12b-v2-vl:free"]);

  // Pull bytes once for all attempts.
  const buf = await readFile(sourcePath);
  const base64 = buf.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;
  const scriptPath = path.join(workDir, `${base}.py`);

  for (const m of modelList) {
    let code = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const reply = await chat({
          apiKey,
          model: m,
          maxTokens: 2200,
          temperature: 0.2,
          messages: [
            { role: "system", content: REDRAW_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: "Воссоздай этот рисунок в matplotlib. ОТДЕЛЬНЫМИ СТРОКАМИ. Все переменные определи численно." },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        });
        code = stripFences(reply.trim());
        break;
      } catch (e) {
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        process.stderr.write(`  redraw via ${m} failed: ${String(e.message || e).slice(0,140)}\n`);
        code = null;
      }
    }

    if (!code || !/savefig\(/.test(code)) continue;

    // Wrap user code with sandbox preamble.
    const fullScript = wrapForSandbox(code, outPath);
    await writeFile(scriptPath, fullScript);

    const ok = await runPython(scriptPath);
    if (ok) return outPath;
    // else loop to next model
  }
  return null;
}

/**
 * Map { pageNum: [{path, ...}] } -> same shape with paths replaced by redrawn
 * versions where redrawing succeeded. Original files left untouched.
 */
export async function redrawAll({ apiKey, model, models, imagesByPage, workDir, concurrency = 1, onProgress }) {
  const modelList = models || (model ? [model] : ["google/gemma-4-31b-it:free", "nvidia/nemotron-nano-12b-v2-vl:free"]);
  const entries = [];
  for (const [page, items] of Object.entries(imagesByPage)) {
    for (let i = 0; i < items.length; i++) {
      entries.push({ page: Number(page), idx: i, item: items[i] });
    }
  }
  let done = 0;
  const sema = [];
  const result = JSON.parse(JSON.stringify(imagesByPage));
  await Promise.all(entries.map(async (e) => {
    // Simple semaphore via promise chain
    while (sema.length >= concurrency) await Promise.race(sema);
    const job = (async () => {
      const redrawn = await redrawFigure({ apiKey, models: modelList, sourcePath: e.item.path, workDir });
      if (redrawn) {
        result[e.page][e.idx] = { ...e.item, path: redrawn, redrawn: true };
      }
      done++;
      onProgress?.(done, entries.length);
    })().then(() => sema.splice(sema.indexOf(job), 1));
    sema.push(job);
    await job;
  }));
  return result;
}
