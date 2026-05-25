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

/**
 * Try to redraw a single raster figure as a clean matplotlib plot.
 * Returns the path to the new PNG on success, or null on failure (caller
 * should keep the original).
 */
export async function redrawFigure({ apiKey, model, sourcePath, workDir, retries = 1 }) {
  await mkdir(workDir, { recursive: true });
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const scriptPath = path.join(workDir, `${base}.py`);
  const outPath = path.join(workDir, `${base}_redrawn.png`);

  let dataUrl;
  try { dataUrl = await dataUrlFromFile(sourcePath); } catch { return null; }

  let previousCode = null;
  let previousErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let code;
    try {
      const messages = [
        { role: "system", content: REDRAW_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Воссоздай этот рисунок одним matplotlib-скриптом." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ];
      if (attempt > 0 && previousCode && previousErr) {
        messages.push({ role: "assistant", content: previousCode });
        messages.push({
          role: "user",
          content: `Скрипт упал с ошибкой:\n${previousErr.slice(0, 800)}\n\nИсправь и перешли ВЕСЬ скрипт заново. Не забудь определить ВСЕ переменные численно.`,
        });
      }
      const reply = await chat({ apiKey, model, maxTokens: 4096, temperature: 0.1, messages });
      code = stripFences(reply.trim());
    } catch {
      return null;
    }

    if (!code || !/savefig\(/.test(code)) return null;

    const wrapper = `import os\nOUT_PATH = ${JSON.stringify(outPath)}\nimport sys\ntry:\n${code.split("\n").map(l => "    " + l).join("\n")}\nexcept Exception as e:\n    sys.stderr.write(f"REDRAW_FAIL: {e}\\n")\n    sys.exit(2)\n`;
    await writeFile(scriptPath, wrapper, "utf8");

    const res = await runPython(scriptPath, workDir);
    if (res.code === 0) {
      try {
        const st = await stat(outPath);
        if (st.size >= 1000) return outPath;
      } catch {}
    }
    previousCode = code;
    previousErr = res.err || "(unknown)";
  }
  return null;
}

/**
 * Map { pageNum: [{path, ...}] } -> same shape with paths replaced by redrawn
 * versions where redrawing succeeded. Original files left untouched.
 */
export async function redrawAll({ apiKey, model, imagesByPage, workDir, concurrency = 3, onProgress }) {
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
      const redrawn = await redrawFigure({ apiKey, model, sourcePath: e.item.path, workDir });
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
