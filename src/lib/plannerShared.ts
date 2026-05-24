/**
 * Shared constants, types, and utilities used by both the slide and doc planners.
 */
import type { DocBlock } from "./types";

export const TARGET_LANG = "Russian";

export interface PlannerOpts {
  apiKey: string;
  model: string;
  visionCapable: boolean;
  onLog?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** How many pages to translate in parallel. Default 3. Free OpenRouter models
   *  rate-limit aggressively, so don't push this above 4. */
  concurrency?: number;
}

/** Strip ```...``` fences if a model returns them despite instructions. */
export function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

/** Convert Markdown (with $...$ / $$...$$ math) into DocBlock[]. */
export function parseMarkdownToBlocks(md: string): DocBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let listActive = false;
  let inDisplayMath = false;
  let displayBuffer: string[] = [];
  const paraBuffer: string[] = [];

  const flushList = () => {
    if (listActive && listItems.length)
      blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
    listActive = false;
  };
  const flushPara = () => {
    const text = paraBuffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "para", text });
    paraBuffer.length = 0;
  };
  const flushAll = () => {
    flushList();
    flushPara();
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, "");

    // Markdown table detection
    if (
      !inDisplayMath &&
      /\|/.test(line) &&
      line.trim().startsWith("|") &&
      line.trim().endsWith("|")
    ) {
      const next = (lines[li + 1] || "").trim();
      if (/^\|?\s*:?-{2,}.*\|/.test(next)) {
        const rows: string[][] = [];
        const headerCells = line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        rows.push(headerCells);
        li += 1; // skip separator
        while (li + 1 < lines.length) {
          const nl = lines[li + 1].trim();
          if (!nl.startsWith("|") || !nl.endsWith("|")) break;
          li++;
          const cells = lines[li]
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim());
          rows.push(cells);
        }
        flushAll();
        blocks.push({ type: "table", rows, header: true });
        continue;
      }
    }

    if (inDisplayMath) {
      const close = line.match(/^(.*)\$\$\s*$/);
      if (close) {
        if (close[1]) displayBuffer.push(close[1]);
        const latex = displayBuffer.join("\n").trim();
        if (latex) blocks.push({ type: "formula", latex, display: true });
        displayBuffer = [];
        inDisplayMath = false;
      } else {
        displayBuffer.push(line);
      }
      continue;
    }

    const trimmed = line.trim();

    // single-line $$...$$
    const oneLine = trimmed.match(/^\$\$([\s\S]+?)\$\$$/);
    if (oneLine) {
      flushAll();
      blocks.push({ type: "formula", latex: oneLine[1].trim(), display: true });
      continue;
    }

    // open display math
    if (/^\$\$/.test(trimmed)) {
      flushAll();
      inDisplayMath = true;
      const rest = trimmed.replace(/^\$\$/, "");
      if (rest) displayBuffer.push(rest);
      continue;
    }

    if (trimmed === "") {
      flushAll();
      continue;
    }

    let m;
    if ((m = trimmed.match(/^#\s+(.+)/))) {
      flushAll();
      blocks.push({ type: "h1", text: m[1].trim() });
      continue;
    }
    if ((m = trimmed.match(/^##\s+(.+)/))) {
      flushAll();
      blocks.push({ type: "h2", text: m[1].trim() });
      continue;
    }
    if ((m = trimmed.match(/^###\s+(.+)/))) {
      flushAll();
      blocks.push({ type: "h3", text: m[1].trim() });
      continue;
    }
    if ((m = trimmed.match(/^[-*•]\s+(.+)/))) {
      flushPara();
      if (listActive && listOrdered) flushList();
      listActive = true;
      listOrdered = false;
      listItems.push(m[1].trim());
      continue;
    }
    if ((m = trimmed.match(/^\d+[.)]\s+(.+)/))) {
      flushPara();
      if (listActive && !listOrdered) flushList();
      listActive = true;
      listOrdered = true;
      listItems.push(m[1].trim());
      continue;
    }
    flushList();
    paraBuffer.push(trimmed);
  }
  flushAll();
  return blocks;
}
