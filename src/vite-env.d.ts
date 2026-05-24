/// <reference types="vite/client" />

declare module "*.pptx?url" {
  const src: string;
  export default src;
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const src: string;
  export default src;
}

declare module "temml" {
  interface TemmlOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    strict?: boolean;
    [k: string]: unknown;
  }
  const _default: {
    renderToString(latex: string, options?: TemmlOptions): string;
  };
  export default _default;
}

declare module "libarchive.js" {
  export class Archive {
    static init(opts: { workerUrl?: string }): void;
    static open(file: File | Blob): Promise<{
      extractFiles(): Promise<Record<string, unknown>>;
    }>;
  }
}

declare module "mammoth/mammoth.browser.js" {
  export function extractRawText(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  export function convertToHtml(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  export function convertToMarkdown(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  const _default: {
    extractRawText: typeof extractRawText;
    convertToHtml: typeof convertToHtml;
    convertToMarkdown: typeof convertToMarkdown;
  };
  export default _default;
}
