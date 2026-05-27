/**
 * Figure / diagram / chart bounding-box detection via MiMo vision.
 *
 * We ask the model to return strict JSON listing every visual element on the
 * page (figure, diagram, chart, plot, schematic, photo, table-as-image) with
 * normalized 0..1 coordinates. We then crop those rectangles from the page
 * raster so the translated DOCX contains the actual figures (not the whole
 * page).
 */
import { chat } from "./mimo";
import { cropDataUrl, downsampleDataUrl } from "./imageOps";

export interface FigureBBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind?: string;
  caption?: string;
}

const DETECT_PROMPT = `You are a layout analyzer for a Russian academic translation pipeline.

Given the page image, return ONLY a strict JSON array of every visual element that is NOT body text:
- figures, diagrams, schematics, circuits
- charts, plots, graphs
- photographs, screenshots
- equation snippets that ARE rendered as a graphic (rare — usually leave equations as text)
- tables that are rendered as a picture (e.g. scan of a printed table)

Do NOT include: page headers/footers, page numbers, paragraphs of body text, isolated formulas typeset as text.

Coordinates are normalized 0..1 with origin at the top-left of the page.
Each element MUST have a tight bounding box around ONLY the figure itself, NOT the surrounding text or the caption.
Caption text (e.g. "Figure 3: ...") goes in the "caption" field if it is adjacent to the figure.

Output format (JSON only, no markdown fences, no commentary):
[{"x":0.12,"y":0.34,"w":0.5,"h":0.22,"kind":"figure","caption":"Fig. 3 — signal flow"}]

If the page contains no figures, return [].`;

export async function detectFigures(
  pageImageDataUrl: string,
  opts: {
    apiKey: string;
    model: string;
    signal?: AbortSignal;
  },
): Promise<FigureBBox[]> {
  const compact = await downsampleDataUrl(pageImageDataUrl, { maxDim: 1400, quality: 0.85 });
  const raw = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0,
    maxTokens: 1024,
    signal: opts.signal,
    messages: [
      { role: "system", content: DETECT_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: compact } },
          { type: "text", text: "Return JSON array of figure bounding boxes for this page." },
        ],
      },
    ],
  });
  return parseBBoxes(raw);
}

function parseBBoxes(s: string): FigureBBox[] {
  if (!s) return [];
  // Strip code fences if model added them
  const cleaned = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find first JSON array
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: FigureBBox[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const x = num(o.x), y = num(o.y), w = num(o.w), h = num(o.h);
    if (x == null || y == null || w == null || h == null) continue;
    // Sanity bounds
    if (x < -0.05 || y < -0.05 || x > 1.05 || y > 1.05) continue;
    if (w <= 0.02 || h <= 0.02) continue; // ignore micro
    if (w >= 0.98 && h >= 0.98) continue; // ignore full-page (likely the page itself)
    out.push({
      x: clamp01(x), y: clamp01(y),
      w: clamp01(w), h: clamp01(h),
      kind: typeof o.kind === "string" ? o.kind : undefined,
      caption: typeof o.caption === "string" ? o.caption : undefined,
    });
  }
  // De-duplicate overlapping bboxes — keep the larger one.
  return dedup(out);
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function dedup(boxes: FigureBBox[]): FigureBBox[] {
  const sorted = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept: FigureBBox[] = [];
  for (const b of sorted) {
    if (kept.some((k) => iou(k, b) > 0.5)) continue;
    kept.push(b);
  }
  // Sort by Y for natural reading order
  return kept.sort((a, b) => a.y - b.y);
}
function iou(a: FigureBBox, b: FigureBBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Crop every detected bbox into its own data URL. */
export async function cropFigures(
  pageImageDataUrl: string,
  bboxes: FigureBBox[],
): Promise<Array<{ dataUrl: string; bbox: FigureBBox }>> {
  const out: Array<{ dataUrl: string; bbox: FigureBBox }> = [];
  for (const bb of bboxes) {
    try {
      const url = await cropDataUrl(pageImageDataUrl, bb, { padding: 0.012, maxDim: 1400, quality: 0.88 });
      out.push({ dataUrl: url, bbox: bb });
    } catch { /* skip a bad crop */ }
  }
  return out;
}
