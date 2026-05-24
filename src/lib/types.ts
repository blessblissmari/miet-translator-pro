export type TargetLang = "ru" | "en";

export interface ExtractedImage {
  dataUrl: string;
  /** Approximate Y position on the page in PDF coords (top of image, top=0). */
  y: number;
  /** PDF-space width/height for sizing hints. */
  w: number;
  h: number;
}

export interface ExtractedPage {
  index: number;          // 0-based
  text: string;           // raw text from the PDF page
  imageDataUrl: string;   // PNG data URL of the rendered full page (fallback)
  width: number;
  height: number;
  /** Embedded raster images extracted from the page, top-to-bottom order. */
  images?: ExtractedImage[];
  /** Lines of text with bounding boxes for layout-preserving downstream use. */
  lines?: Array<{ text: string; x: number; y: number; w: number; h: number; fontSize: number }>;
}

export interface ExtractedDoc {
  pages: ExtractedPage[];
  meta: { title?: string; author?: string };
}

export interface SlidePlan {
  title: string;
  bullets: string[];
  // If LLM detects a chart with simple data, populate this
  chart?: { type: "bar" | "line" | "pie"; categories: string[]; series: { name: string; values: number[] }[] };
  // Always carry a rasterized version of the original slide page so graphics survive
  imageDataUrl?: string;
  // Layout hint chosen by the planner
  layout:
    | "title-text"
    | "title-text-image-right"
    | "title-text-image-left"
    | "title-image"
    | "title-chart-text"
    | "title-chart"
    | "section-title";
}

export type DocBlock =
  | { type: "h1" | "h2" | "h3" | "para"; text: string }
  | { type: "formula"; latex: string; display?: boolean }
  | { type: "figure"; imageDataUrl: string; caption?: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][]; header?: boolean };

export interface DocPlan {
  title?: string;
  blocks: DocBlock[];
}

export interface OpenRouterModel {
  id: string;
  label: string;
  vision: boolean;
  context: number;
}
