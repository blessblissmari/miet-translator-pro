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

/**
 * Normalize stray LaTeX math delimiters into the dollar-sign form that the
 * downstream Markdown→DocBlock parser understands. Some models emit
 * \( ... \) and \[ ... \] regardless of system-prompt instructions; without
 * this step those fragments would be rendered as literal text including the
 * backslashes in the final document.
 *
 * Conversions:
 *   \[ ... \]   →  $$ ... $$  (display math, own paragraph)
 *   \( ... \)   →  $ ... $    (inline math)
 *
 * The replacements run on the whole string. False positives in unrelated text
 * are essentially impossible because `\[` / `\(` rarely appear outside math
 * in academic content; if they ever do, they pass through DocBlock rendering
 * fine as plain text containing dollar signs.
 */
export function normalizeMathDelims(text: string): string {
  return text
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) => `\n\n$$${body.trim()}$$\n\n`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body) => `$${body.trim()}$`);
}

/**
 * Convert / strip HTML that the model sometimes leaks into the Markdown
 * output. Word does not render raw HTML inside a paragraph, so anything we
 * leave intact ends up as literal `<sub>1</sub>` text in the DOCX.
 *
 * Strategy:
 *   1. Drop dangerous / useless blocks entirely (`<style>`, `<script>`,
 *      `<!--…-->`, `<meta>` …).
 *   2. Convert common formatting tags to their Markdown / LaTeX equivalents
 *      so that the downstream pipeline still renders them properly.
 *   3. As a last resort, strip the tag but keep its inner text.
 *
 * Math-aware: when a tag sits *inside* a $...$ / $$...$$ block we map it to
 * LaTeX (e.g. `<sub>i</sub>` → `_{i}`); outside math we use Markdown
 * (`<sub>` → `~text~`-like which we just drop because Word/Markdown has no
 * native subscript — falling back to `_text_` is misleading inside prose).
 *
 * Conservative: only touches the tag list we know about. Unknown tags get
 * dropped (tag stripped, body kept) so we never leave raw `<foo>` in output.
 */
export function sanitizeHtml(input: string): string {
  if (!input) return input;
  let s = input;

  // Block-level removals (drop tag + body).
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|meta|link|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<\/?(html|body|head|meta|link|title)\b[^>]*>/gi, "");

  // Common HTML entities → plain text.
  const ENTITY: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    times: "×", divide: "÷", deg: "°", plusmn: "±", micro: "µ",
    minus: "−", sdot: "·", middot: "·", hellip: "…", mdash: "—", ndash: "–",
    larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", infin: "∞",
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
    eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "µ",
    nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
    phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
    Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡",
  };
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY[name] ?? m);
  s = s.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)));

  // Inline tag → markdown/LaTeX. We do two passes: one for inside $...$
  // segments (use LaTeX) and one for outside (use Markdown). To keep this
  // simple we operate on each parts-split chunk separately.
  const parts = s.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g);
  for (let i = 0; i < parts.length; i++) {
    const isMath = i % 2 === 1;
    let seg = parts[i];
    if (isMath) {
      // Inside math: convert HTML to LaTeX equivalents.
      seg = seg.replace(/<sub>\s*([^<]+?)\s*<\/sub>/gi, (_m, body) => `_{${body}}`);
      seg = seg.replace(/<sup>\s*([^<]+?)\s*<\/sup>/gi, (_m, body) => `^{${body}}`);
      seg = seg.replace(/<i>\s*([^<]+?)\s*<\/i>/gi, (_m, body) => body);
      seg = seg.replace(/<em>\s*([^<]+?)\s*<\/em>/gi, (_m, body) => body);
      seg = seg.replace(/<b>\s*([^<]+?)\s*<\/b>/gi, (_m, body) => `\\mathbf{${body}}`);
      seg = seg.replace(/<strong>\s*([^<]+?)\s*<\/strong>/gi, (_m, body) => `\\mathbf{${body}}`);
      seg = seg.replace(/<br\s*\/?>/gi, " \\\\ ");
      // Strip anything else: tag dropped, body kept.
      seg = seg.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    } else {
      // Outside math: subscript/superscript HTML around a bare math token →
      // wrap a $...$ around it (e.g. "V<sub>T</sub>" → "$V_{T}$").
      seg = seg.replace(
        /([A-Za-zα-ωΑ-Ω])<sub>\s*([^<\s][^<]*?)\s*<\/sub>/gi,
        (_m, base, sub) => `$${base}_{${sub}}$`,
      );
      seg = seg.replace(
        /([A-Za-zα-ωΑ-Ω])<sup>\s*([^<\s][^<]*?)\s*<\/sup>/gi,
        (_m, base, sup) => `$${base}^{${sup}}$`,
      );
      // Plain prose subscripts/superscripts with no leading variable —
      // drop the tag, keep the text.
      seg = seg.replace(/<sub>\s*([^<]+?)\s*<\/sub>/gi, (_m, body) => body);
      seg = seg.replace(/<sup>\s*([^<]+?)\s*<\/sup>/gi, (_m, body) => body);
      // Formatting → Markdown.
      seg = seg.replace(/<i>\s*([^<]+?)\s*<\/i>/gi, (_m, body) => `*${body}*`);
      seg = seg.replace(/<em>\s*([^<]+?)\s*<\/em>/gi, (_m, body) => `*${body}*`);
      seg = seg.replace(/<b>\s*([^<]+?)\s*<\/b>/gi, (_m, body) => `**${body}**`);
      seg = seg.replace(/<strong>\s*([^<]+?)\s*<\/strong>/gi, (_m, body) => `**${body}**`);
      seg = seg.replace(/<u>\s*([^<]+?)\s*<\/u>/gi, (_m, body) => body);
      seg = seg.replace(/<code>\s*([^<]+?)\s*<\/code>/gi, (_m, body) => `\`${body}\``);
      seg = seg.replace(/<br\s*\/?>/gi, "\n");
      seg = seg.replace(/<\/?p\b[^>]*>/gi, "\n\n");
      seg = seg.replace(/<\/?div\b[^>]*>/gi, "\n");
      seg = seg.replace(/<li\b[^>]*>\s*/gi, "- ");
      seg = seg.replace(/<\/li>/gi, "\n");
      seg = seg.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
      // Strip MathML wrappers (we don't render them — body text usually is
      // a poor LaTeX-like fallback we'd rather drop than show as garbage).
      seg = seg.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, "");
      // Drop anything else: tag stripped, body kept.
      seg = seg.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    }
    parts[i] = seg;
  }

  let out = parts.join("");
  // Collapse triple+ newlines that the strip created.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

export function wrapOrphanLatex(text: string): string {
  // Conservative wrapper: only touches segments OUTSIDE existing $...$ blocks.
  // Three passes, applied in order:
  //   C) Whole math-shaped lines (contain `=`, no Cyrillic) → wrap entire line
  //      in $...$ so the model output like `y[n] = \mathcal{H}\{x[n]\}` becomes
  //      one math span instead of fragments.
  //   A) Sequences that begin with a backslash command and stay LaTeX-shaped
  //      (e.g. \mathcal{H}\{x[n]\}, \delta[n-2], \frac{...}{...}).
  //   B) Standalone identifier-with-bracket-subscript like x[n], y_1[n+1].
  //
  // After every pass we re-split so previously-wrapped math is not mutated
  // again by the next pass.

  const splitMath = (s: string) => s.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g);

  // ── Pass C: whole math-shaped lines ────────────────────────────────────
  const cParts = splitMath(text);
  for (let i = 0; i < cParts.length; i += 2) {
    cParts[i] = cParts[i]
      .split(/(\n)/)
      .map((line) => {
        if (line === "\n" || !line.trim()) return line;
        if (/\$/.test(line)) return line;
        // Skip lines with Cyrillic — those are prose.
        if (/[\u0400-\u04FF]/.test(line)) return line;
        const t = line.trim();
        // Skip Markdown structure markers.
        if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|!\[)/.test(t)) return line;
        if (/https?:\/\//.test(t)) return line;
        const hasEq = /=/.test(t);
        const hasLatex = /\\[A-Za-z]+/.test(t);
        const hasBracket = /[A-Za-z][_^]?\{?[A-Za-z0-9+-]*\}?\[[A-Za-z0-9_+-]+\]/.test(t);
        const hasSubSup = /[A-Za-z][_^][A-Za-z0-9{]/.test(t);
        if (!hasEq && !hasLatex && !hasBracket && !hasSubSup) return line;
        // Must be "math-shaped": only ASCII math chars.
        const mathChar = /[A-Za-z0-9+\-*/=<>(){}[\]_^|\\,.;:!? \t]/;
        let mathCount = 0;
        let totalNonSpace = 0;
        for (const ch of t) {
          if (/\s/.test(ch)) continue;
          totalNonSpace++;
          if (mathChar.test(ch)) mathCount++;
        }
        if (totalNonSpace < 4) return line;
        if (mathCount / totalNonSpace < 0.9) return line;
        const lead = line.match(/^\s*/)?.[0] ?? "";
        const trail = line.match(/\s*$/)?.[0] ?? "";
        return `${lead}$${t}$${trail}`;
      })
      .join("");
  }
  let working = cParts.join("");

  // ── Pass A: backslash commands ─────────────────────────────────────────
  const aParts = splitMath(working);
  for (let i = 0; i < aParts.length; i += 2) {
    aParts[i] = aParts[i].replace(
      /\\[A-Za-z]+(?:\{[^{}\n]{0,60}\}|\\\{[^{}\n]{0,60}\\\})*(?:[_^]\{?[A-Za-z0-9+-]{1,8}\}?)?(?:\[[A-Za-z0-9_+-]{1,12}\])?/g,
      (m) => `$${m}$`,
    );
  }
  working = aParts.join("");

  // ── Pass B: standalone x[n] / y_1[n+1] ─────────────────────────────────
  const bParts = splitMath(working);
  for (let i = 0; i < bParts.length; i += 2) {
    bParts[i] = bParts[i].replace(
      /(^|[\s(,;:\u00BB\u2014-])([A-Za-z])(_\{?[A-Za-z0-9+-]{1,3}\}?)?\[([A-Za-z0-9_+-]{1,6})\](?=$|[\s).,;:!?\u00AB\-=])/g,
      (_m, pre, letter, sub, idx) => `${pre}$${letter}${sub || ""}[${idx}]$`,
    );
  }
  working = bParts.join("");

  // Merge adjacent math spans separated by nothing or a single space:
  // `$a$$b$` → `$a b$`, `$a$ $b$` → `$a b$`. Inline math only — never
  // touches `$$...$$` display blocks.
  working = working.replace(/\$([^$\n]+)\$\s*\$([^$\n]+)\$/g, (_m, a, b) => `$${a} ${b}$`);

  // Absorb a trailing escaped-brace argument into a preceding math span.
  // Pattern: `$X$ \{Y\}` → `$X \{Y\}$`. Common in `\mathcal{H}\{x[n]\}` after
  // upstream normalizers wrapped only the `\mathcal{H}` part. Loop because
  // chains like `\f{a}\{b\}\(c\)` should fully absorb.
  for (let pass = 0; pass < 4; pass++) {
    const next = working.replace(
      /\$([^$\n]+?)\$(\s*)(\\[{(\[](?:[^$\n\\]|\\(?![{}()\[\]]))*?\\[})\]])/g,
      (_m, math, ws, esc) => `$${math}${ws}${esc}$`,
    );
    if (next === working) break;
    working = next;
  }

  return working;
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

    const trimmed = line.trim();

    // Standalone Markdown image line → figure block.
    // We only handle inline data: URLs (extractor / model embed them) and
    // absolute http(s) URLs.
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/);
    if (imgMatch) {
      const url = imgMatch[2];
      if (/^(data:|https?:|\/)/.test(url)) {
        flushAll();
        blocks.push({
          type: "figure",
          imageDataUrl: url,
          caption: imgMatch[1] || undefined,
        });
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
