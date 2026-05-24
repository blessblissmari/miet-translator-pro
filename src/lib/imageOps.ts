/**
 * Image utilities for downsampling and re-encoding before sending to vision LLMs.
 *
 * Why: PDF pages are rendered at scale 2.5–3× for OCR fidelity, producing PNG
 * data URLs of 2–6 MB each. Sending these unmodified to OpenRouter:
 *   - blows up the request payload (often the body limit is ~10 MB)
 *   - explodes the input-token count for vision models (Gemma counts pixels)
 *   - slows the round-trip to 30–60 s per page
 *
 * Empirically, vision models read printed/handwritten text reliably as long as
 * the longer side is ≥ ~1200 px and characters are ≥ ~14 px tall. We cap at
 * 1600 px and re-encode to JPEG q=0.85 — that yields ~150–400 KB per page with
 * no measurable loss in OCR/translation quality.
 */

export interface DownsampleOptions {
  /** Maximum dimension (width or height) in pixels. Default 1600. */
  maxDim?: number;
  /** JPEG quality 0–1. Default 0.85. */
  quality?: number;
  /** Force JPEG output even for PNG inputs (recommended for size). Default true. */
  forceJpeg?: boolean;
}

/**
 * Downsample a data URL to ≤ maxDim on its longer side and re-encode as JPEG.
 * Returns the original URL unchanged if it's already small enough.
 *
 * Robust to:
 *   - already-small images (returns as-is)
 *   - SVG / unsupported formats (returns as-is on decode error)
 *   - very-tall pages (preserves aspect ratio)
 *   - already-JPEG sources (still re-encodes only if we resized)
 */
export async function downsampleDataUrl(
  dataUrl: string,
  opts: DownsampleOptions = {},
): Promise<string> {
  const maxDim = opts.maxDim ?? 1600;
  const quality = opts.quality ?? 0.85;
  const forceJpeg = opts.forceJpeg ?? true;

  if (!dataUrl.startsWith("data:image/")) return dataUrl;

  // Cheap pre-check via base64 length — if it's small, skip the round-trip.
  const approxBytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
  if (approxBytes < 200_000 && !forceJpeg) return dataUrl;

  let img: HTMLImageElement;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return dataUrl;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return dataUrl;

  const longest = Math.max(w, h);
  const ratio = longest > maxDim ? maxDim / longest : 1;

  // If we don't need to resize AND the source is already a small JPEG, keep it.
  if (ratio === 1 && approxBytes < 400_000 && /^data:image\/jpe?g/.test(dataUrl)) {
    return dataUrl;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  // Use white background so transparent PNGs don't become black after JPEG encode.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const out = canvas.toDataURL("image/jpeg", quality);
  // If for some reason the output is bigger than the input (very small images
  // can be more efficient as PNG), keep the original.
  return out.length < dataUrl.length ? out : dataUrl;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/** Decode a data URL to a Uint8Array. Safe for large images (no atob megabuffer). */
export async function dataUrlToUint8(dataUrl: string): Promise<Uint8Array> {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** Detect image MIME type from a data URL ("image/png", "image/jpeg", ...). */
export function dataUrlMime(dataUrl: string): string {
  const m = dataUrl.match(/^data:([^;,]+)/);
  return m ? m[1] : "application/octet-stream";
}
