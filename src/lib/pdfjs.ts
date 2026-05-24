/**
 * Single, lazy entrypoint for pdfjs-dist.
 *
 * Why: every dynamic import of `pdfjs-dist` from app code creates a chunk-bundling
 * opportunity for Vite. If the same module is also statically imported anywhere
 * else, Vite warns "INEFFECTIVE_DYNAMIC_IMPORT" and pulls the whole library into
 * the main bundle (~2 MB). Centralizing all pdfjs access through this module
 * keeps the pdfjs library in its own lazy-loaded chunk — pages that never need
 * to render PDFs (e.g. only PPTX/DOCX uploads) won't pay the cost.
 *
 * The first call lazily imports pdfjs and configures the worker; subsequent
 * calls reuse the same promise.
 */
import type * as PdfJs from "pdfjs-dist";

let cached: Promise<typeof PdfJs> | null = null;

export function getPdfjs(): Promise<typeof PdfJs> {
  if (!cached) {
    cached = (async () => {
      const [pdfjs, workerUrlMod] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrlMod.default;
      return pdfjs;
    })();
  }
  return cached;
}
