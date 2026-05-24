/**
 * MinerU cloud API client.
 *
 * MinerU (https://mineru.net) is a high-quality PDF/DOCX/PPTX → Markdown
 * parser by OpenDataLab. We use it as an *alternative* to the built-in
 * pdf.js extractor — strictly better at:
 *   • scanned PDFs (real OCR pipeline)
 *   • complex math (LaTeX output)
 *   • multi-column papers (proper reading order)
 *   • figure extraction with captions
 *
 * The cloud API is async (submit → poll → fetch). It accepts either a
 * remote URL or a multipart file upload.
 *
 * @see https://mineru.net/apiManage/docs
 */
import JSZip from "jszip";
import type { ExtractedDoc, ExtractedPage } from "./types";
import { chunkMarkdown } from "./markdownChunk";

const API_BASE = "https://mineru.net/api/v4";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 200; // ~10 minutes max wait

export interface MineruOptions {
  /** JWT token from https://mineru.net (Authorization: Bearer <token>) */
  token: string;
  /** "pipeline" (fast) | "vlm" (best for layout/math) | "auto" */
  modelVersion?: "pipeline" | "vlm" | "auto";
  /** OCR language hint; "auto" picks per page */
  lang?: string;
  /** Whether to return embedded images (as part of zip result) */
  enableFormula?: boolean;
  enableTable?: boolean;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

interface SubmitTaskResp {
  code: number;
  msg?: string;
  data?: { task_id: string };
}

interface PollTaskResp {
  code: number;
  msg?: string;
  data?: {
    state: "pending" | "running" | "done" | "failed" | "waiting" | "converting" | "extracting";
    err_msg?: string;
    full_zip_url?: string;
    full_md_link?: string;
    extract_progress?: { extracted_pages?: number; total_pages?: number };
  };
}

interface BatchUploadResp {
  code: number;
  msg?: string;
  data?: {
    batch_id: string;
    file_urls: string[]; // signed PUT URLs
  };
}

interface BatchResultResp {
  code: number;
  data?: {
    extract_result: Array<{
      file_name: string;
      state: string;
      err_msg?: string;
      full_zip_url?: string;
    }>;
  };
}

/**
 * Submit a remote URL for parsing and return the task_id.
 * Use this when you already have a publicly reachable URL.
 */
export async function submitUrlTask(
  url: string,
  opts: MineruOptions,
): Promise<string> {
  const body = {
    url,
    model_version: opts.modelVersion ?? "vlm",
    is_ocr: true,
    enable_formula: opts.enableFormula ?? true,
    enable_table: opts.enableTable ?? true,
    language: opts.lang ?? "auto",
  };
  const r = await fetch(`${API_BASE}/extract/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    throw new Error(`MinerU submit failed: HTTP ${r.status} ${await r.text()}`);
  }
  const json = (await r.json()) as SubmitTaskResp;
  if (json.code !== 0 || !json.data?.task_id) {
    throw new Error(`MinerU submit error: ${json.msg ?? "unknown"} (code ${json.code})`);
  }
  return json.data.task_id;
}

/**
 * Poll a task until it reaches a terminal state (`done` or `failed`).
 * Returns the final result data on success; throws on failure or timeout.
 */
export async function pollTask(
  taskId: string,
  opts: MineruOptions,
): Promise<NonNullable<PollTaskResp["data"]>> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await fetch(`${API_BASE}/extract/task/${taskId}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(`MinerU poll failed: HTTP ${r.status}`);
    const json = (await r.json()) as PollTaskResp;
    if (json.code !== 0 || !json.data) {
      throw new Error(`MinerU poll error: ${json.msg ?? "unknown"} (code ${json.code})`);
    }
    const { state, err_msg, extract_progress } = json.data;
    if (state === "done") return json.data;
    if (state === "failed") throw new Error(`MinerU task failed: ${err_msg ?? "unknown"}`);
    if (extract_progress && opts.onProgress) {
      const { extracted_pages, total_pages } = extract_progress;
      opts.onProgress(
        `MinerU: ${state} (${extracted_pages ?? 0}/${total_pages ?? "?"} pages)`,
      );
    } else if (opts.onProgress) {
      opts.onProgress(`MinerU: ${state}…`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("MinerU poll timed out after 10 minutes");
}

/**
 * Upload a local file to MinerU via the batch upload flow and return task IDs.
 * (MinerU's URL-based endpoint only works for remote URLs — file uploads must
 * go through a 2-step signed upload.)
 */
export async function submitFileTask(
  file: Blob,
  filename: string,
  opts: MineruOptions,
): Promise<string> {
  // Step 1 — request a signed upload URL
  const reqBody = {
    enable_formula: opts.enableFormula ?? true,
    enable_table: opts.enableTable ?? true,
    language: opts.lang ?? "auto",
    model_version: opts.modelVersion ?? "vlm",
    files: [{ name: filename, is_ocr: true }],
  };
  const reqRes = await fetch(`${API_BASE}/file-urls/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(reqBody),
    signal: opts.signal,
  });
  if (!reqRes.ok) {
    throw new Error(`MinerU upload-url failed: HTTP ${reqRes.status} ${await reqRes.text()}`);
  }
  const reqJson = (await reqRes.json()) as BatchUploadResp;
  if (reqJson.code !== 0 || !reqJson.data?.file_urls?.[0]) {
    throw new Error(`MinerU upload-url error: ${reqJson.msg ?? "unknown"}`);
  }
  const { batch_id, file_urls } = reqJson.data;
  // Step 2 — PUT the file to the signed URL
  const putRes = await fetch(file_urls[0], {
    method: "PUT",
    body: file,
    signal: opts.signal,
  });
  if (!putRes.ok) {
    throw new Error(`MinerU PUT failed: HTTP ${putRes.status}`);
  }
  return batch_id;
}

/**
 * Poll batch results (returned by `submitFileTask`) and return the first
 * result's data once complete.
 */
export async function pollBatch(
  batchId: string,
  opts: MineruOptions,
): Promise<{ full_zip_url: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await fetch(`${API_BASE}/extract-results/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(`MinerU batch poll failed: HTTP ${r.status}`);
    const json = (await r.json()) as BatchResultResp;
    const item = json.data?.extract_result?.[0];
    if (item) {
      if (item.state === "done" && item.full_zip_url) {
        return { full_zip_url: item.full_zip_url };
      }
      if (item.state === "failed") {
        throw new Error(`MinerU batch failed: ${item.err_msg ?? "unknown"}`);
      }
      if (opts.onProgress) opts.onProgress(`MinerU: ${item.state}…`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("MinerU batch poll timed out");
}

/**
 * Fetch a MinerU result zip and convert it into an `ExtractedDoc`.
 * Zip contents (per MinerU spec):
 *   full.md          — full document markdown
 *   layout.json      — page layout / blocks
 *   images/*.{png,jpg} — extracted figures
 */
export async function fetchResultZip(
  zipUrl: string,
  opts: MineruOptions,
): Promise<ExtractedDoc> {
  const r = await fetch(zipUrl, { signal: opts.signal });
  if (!r.ok) throw new Error(`MinerU zip fetch failed: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  return mineruZipToExtractedDoc(buf);
}

/**
 * Public: convert a MinerU result zip (as ArrayBuffer) into our internal
 * `ExtractedDoc`. Splits the markdown into chunks (one chunk per page) so
 * the existing planner can ingest it page-by-page.
 *
 * Exported for testing.
 */
export async function mineruZipToExtractedDoc(buf: ArrayBuffer): Promise<ExtractedDoc> {
  const zip = await JSZip.loadAsync(buf);

  // Locate the full markdown file (name varies: full.md, *.md at root).
  let md = "";
  const mdFile =
    zip.file("full.md") ??
    zip.file(/.*\.md$/i)?.[0];
  if (mdFile) md = await mdFile.async("string");
  md = md.trim();

  // Build extracted pages by chunking the markdown into ~3500-char blocks.
  // This preserves the planner's existing behavior of one "page" per chunk.
  const chunks = chunkMarkdown(md, 3500);
  const pages: ExtractedPage[] = [];

  if (chunks.length === 0) {
    pages.push({
      index: 0,
      text: md || "(пусто)",
      imageDataUrl: await placeholderImage(md || "MinerU: empty result", 1024, 1400),
      width: 1024,
      height: 1400,
    });
  } else {
    for (let i = 0; i < chunks.length; i++) {
      pages.push({
        index: i,
        text: chunks[i],
        imageDataUrl: await placeholderImage(chunks[i], 1024, 1400),
        width: 1024,
        height: 1400,
      });
    }
  }

  return { pages, meta: { title: extractTitle(md) } };
}

function extractTitle(md: string): string | undefined {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Render a small placeholder preview for MinerU-extracted pages (the planner
 * uses `imageDataUrl` as a fallback rendering target). We can't get original
 * page images cheaply, so we synthesize a text preview.
 */
async function placeholderImage(text: string, w: number, h: number): Promise<string> {
  // In node/test environments there's no `document`. Return a tiny inline
  // SVG data URL as a stand-in.
  if (typeof document === "undefined") {
    return `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='#fff'/></svg>`,
    )}`;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#111";
  ctx.font = "18px sans-serif";
  // Naive word wrap
  const maxWidth = w - 80;
  const words = text.split(/\s+/);
  let line = "";
  let y = 60;
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, 40, y);
      y += 26;
      if (y > h - 30) break;
      line = word;
    } else {
      line = test;
    }
  }
  if (line && y < h - 30) ctx.fillText(line, 40, y);
  return canvas.toDataURL("image/png");
}

/**
 * High-level: parse a local file (Blob) end-to-end using MinerU cloud API.
 * Submits → polls → fetches → returns `ExtractedDoc`.
 */
export async function extractWithMineru(
  blob: Blob,
  filename: string,
  opts: MineruOptions,
): Promise<ExtractedDoc> {
  opts.onProgress?.("MinerU: uploading…");
  const batchId = await submitFileTask(blob, filename, opts);
  opts.onProgress?.("MinerU: queued, polling…");
  const { full_zip_url } = await pollBatch(batchId, opts);
  opts.onProgress?.("MinerU: fetching result…");
  return fetchResultZip(full_zip_url, opts);
}

/* ─── Local bridge (server/main.py) ──────────────────────────────────────── */

export interface MineruLocalOptions {
  /** Endpoint of the local bridge, e.g. "http://localhost:8765" */
  endpoint: string;
  /** MinerU backend override ("pipeline" | "vlm-transformers") */
  backend?: "pipeline" | "vlm-transformers";
  /** OCR language hint */
  lang?: string;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

interface LocalParseResponse {
  markdown: string;
  title?: string;
  images: Array<{ name: string; dataUrl: string }>;
  stats?: { pages?: number; elapsed_ms?: number; backend?: string };
}

/**
 * Convert the local bridge's JSON response into an `ExtractedDoc`. Mirrors
 * the cloud-zip path (`mineruZipToExtractedDoc`) so downstream planners
 * behave identically regardless of backend.
 *
 * Exported for testing.
 */
export function localResponseToExtractedDoc(resp: LocalParseResponse): ExtractedDoc {
  const md = (resp.markdown ?? "").trim();
  const chunks = chunkMarkdown(md, 3500);
  const pages: ExtractedPage[] = chunks.length
    ? chunks.map((text, i) => ({
        index: i,
        text,
        // Use first available image as a coarse preview if present, else SVG placeholder
        imageDataUrl:
          (i === 0 && resp.images[0]?.dataUrl) ||
          `data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1400'><rect width='100%' height='100%' fill='#fff'/></svg>`,
          )}`,
        width: 1024,
        height: 1400,
      }))
    : [
        {
          index: 0,
          text: md || "(пусто)",
          imageDataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1400'><rect width='100%' height='100%' fill='#fff'/></svg>`,
          )}`,
          width: 1024,
          height: 1400,
        },
      ];
  return { pages, meta: { title: resp.title || extractTitleFromMd(md) } };
}

function extractTitleFromMd(md: string): string | undefined {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}

/**
 * Health-check the local bridge. Returns `null` on failure (network/CORS/etc.)
 * so the UI can surface a friendly error.
 */
export async function checkLocalBridge(
  endpoint: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; mineru_version?: string; backend?: string } | null> {
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/health`, { signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * High-level: parse a file via the local MinerU bridge.
 */
export async function extractWithMineruLocal(
  blob: Blob,
  filename: string,
  opts: MineruLocalOptions,
): Promise<ExtractedDoc> {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  opts.onProgress?.("MinerU (local): uploading…");
  const fd = new FormData();
  fd.append("file", blob, filename);
  const url = new URL(`${endpoint}/parse`);
  if (opts.backend) url.searchParams.set("backend", opts.backend);
  if (opts.lang) url.searchParams.set("lang", opts.lang);
  const r = await fetch(url.toString(), {
    method: "POST",
    body: fd,
    signal: opts.signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`MinerU local parse failed: HTTP ${r.status} ${errText}`);
  }
  opts.onProgress?.("MinerU (local): parsing complete, building doc…");
  const json = (await r.json()) as LocalParseResponse;
  return localResponseToExtractedDoc(json);
}
