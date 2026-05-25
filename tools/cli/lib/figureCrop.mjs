// Figure detection + crop for slides whose plots are vector graphics
// (pdfimages misses them).
//
// Strategy: ask a vision LLM for a normalized bounding box of the plot
// region on the page. If found, crop that region from a high-DPI page
// render using ImageMagick.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chat } from "./mimo.mjs";

const PROMPT = `Ты — ассистент по разметке слайдов.
ВХОД: скриншот слайда учебной презентации (английский, тема ЦОС).

ЗАДАЧА: определить ЕСТЬ ЛИ на слайде нетривиальный научный рисунок —
магнитудная характеристика, фазовая, импульсный отклик, диаграмма
нулей-полюсов, спектр, схема фильтра, временной ряд.
Текст, маркеры, формулы, заголовок, копирайт — НЕ рисунок.

ОТВЕТ: только JSON, без markdown:
- если рисунка нет:  {"figure": false}
- если рисунок есть: {"figure": true, "x": <0..1>, "y": <0..1>, "w": <0..1>, "h": <0..1>}
  где (x,y) — левый верхний угол bbox, (w,h) — ширина и высота,
  все четыре числа — доли от размера всего слайда (0..1).
  Дай чуть запаса (5–10%) по краям bbox.`;

function runPdftoppm(pdfPath, pageNum, outPng, dpi = 150) {
  return new Promise((resolve, reject) => {
    const p = spawn("pdftoppm", ["-r", String(dpi), "-f", String(pageNum), "-l", String(pageNum),
      "-singlefile", "-png", pdfPath, outPng.replace(/\.png$/, "")]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("close", c => c === 0 ? resolve() : reject(new Error("pdftoppm: " + err)));
  });
}

function imSize(pngPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("identify", ["-format", "%w %h", pngPath]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("close", c => {
      if (c !== 0) return reject(new Error("identify failed"));
      const [w, h] = out.trim().split(/\s+/).map(Number);
      resolve({ w, h });
    });
  });
}

function cropPng(srcPng, dstPng, x, y, w, h) {
  return new Promise((resolve, reject) => {
    const geom = `${w}x${h}+${x}+${y}`;
    const p = spawn("convert", [srcPng, "-crop", geom, "+repage", dstPng]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("close", c => c === 0 ? resolve() : reject(new Error("convert: " + err)));
  });
}

function parseJsonLoose(t) {
  t = t.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const MODELS = [
  "mimo-v2.5",
  "mimo-v2.5",
  "mimo-v2-omni",
];

export async function cropFigureFromPage({ apiKey, pdfPath, pageNum, workDir, models = MODELS, dpi = 200 }) {
  await mkdir(workDir, { recursive: true });
  const base = `slide-${String(pageNum).padStart(3, "0")}`;
  const outPath = path.join(workDir, `${base}_fig.png`);
  const sentinelPath = path.join(workDir, `${base}_nofig.txt`);
  const pagePng = path.join(workDir, `${base}_page.png`);

  try { await stat(outPath); return outPath; } catch {}
  try { await stat(sentinelPath); return null; } catch {}

  await runPdftoppm(pdfPath, pageNum, pagePng, dpi);
  const { w: pageW, h: pageH } = await imSize(pagePng);
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
        maxTokens: 200,
        temperature: 0,
        retries: 2,
      });
      const j = parseJsonLoose(reply);
      if (!j) continue;
      if (j.figure === false) {
        await writeFile(sentinelPath, "no figure");
        return null;
      }
      if (j.figure === true && [j.x, j.y, j.w, j.h].every(v => typeof v === "number" && v >= 0 && v <= 1)) {
        // Clamp + minimum size
        const x = Math.max(0, Math.min(1, j.x));
        const y = Math.max(0, Math.min(1, j.y));
        const w = Math.max(0.1, Math.min(1 - x, j.w));
        const h = Math.max(0.1, Math.min(1 - y, j.h));
        await cropPng(pagePng, outPath,
          Math.round(x * pageW), Math.round(y * pageH),
          Math.round(w * pageW), Math.round(h * pageH));
        try { await stat(outPath); return outPath; } catch {}
      }
    } catch (e) {
      process.stderr.write(`  cropFigure ${pageNum} ${model}: ${(e.message || "").slice(0, 80)}\n`);
    }
  }
  return null;
}

export async function cropFiguresForPages({ apiKey, pdfPath, pages, workDir, onProgress }) {
  const results = {};
  for (let i = 0; i < pages.length; i++) {
    const pn = pages[i];
    onProgress?.(i, pages.length, pn);
    const r = await cropFigureFromPage({ apiKey, pdfPath, pageNum: pn, workDir });
    if (r) results[pn] = r;
  }
  return results;
}
