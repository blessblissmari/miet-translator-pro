/**
 * Normalize math markup in LLM output so the renderer (temml) and the DOCX
 * builder both pick up real formulas instead of leaving raw LaTeX commands
 * (\delta, \frac, \begin{cases}, …) as plain text.
 *
 * The model frequently:
 *  - emits \( … \) / \[ … \] instead of $ … $ / $$ … $$
 *  - emits \begin{cases}…\end{cases} without any wrapping at all
 *  - emits orphan commands like  3\delta[n-2]  inside a normal paragraph
 *  - repeats placeholders like "(см. рис. на стр. 1)" several times in a row
 *
 * This module fixes all four.
 */

const MATH_ENVS = [
  "cases", "align", "align\\*", "aligned",
  "equation", "equation\\*", "gather", "gather\\*", "gathered",
  "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix",
  "smallmatrix", "array",
];

/** Public entry point — call on raw LLM output before block parsing. */
export function normalizeMath(s: string): string {
  if (!s) return s;

  // 1. \[ … \]   →  $$ … $$
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `\n$$${(inner as string).trim()}$$\n`);

  // 2. \( … \)   →  $ … $
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${(inner as string).trim()}$`);

  // 3. \begin{env} … \end{env}  →  $$\begin{env} … \end{env}$$
  for (const env of MATH_ENVS) {
    const re = new RegExp(`\\\\begin\\{${env}\\}([\\s\\S]*?)\\\\end\\{${env}\\}`, "g");
    s = s.replace(re, (m) => `\n$$${m}$$\n`);
  }
  s = s.replace(/\$\$\s*\$\$/g, "");
  s = s.replace(/\$\$\$\$/g, "$$");

  // 4. orphan LaTeX commands (\delta, x_2, etc.) → wrap in $...$
  s = s.split(/\n/).map(wrapOrphansLine).join("\n");

  // 5. dedupe repeated figure placeholders
  s = s.replace(/(\(\s*см\.\s*рис\.\s*на\s*стр\.\s*\d+\s*\))(?:\s*\1)+/gi, "$1");

  return s;
}

/** Within one line, wrap orphan LaTeX commands in $...$, but skip segments
 *  that are already in math mode ($...$ / $$...$$). */
function wrapOrphansLine(line: string): string {
  const segs = splitByDollar(line);
  return segs.map(s => s.math ? s.t : wrapOrphans(s.t)).join("");
}

interface Seg { math: boolean; t: string }

function splitByDollar(line: string): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  while (i < line.length) {
    const sd = line.indexOf("$", i);
    if (sd < 0) { out.push({ math: false, t: line.slice(i) }); break; }
    if (sd > i) out.push({ math: false, t: line.slice(i, sd) });
    if (line.startsWith("$$", sd)) {
      const close = line.indexOf("$$", sd + 2);
      if (close < 0) { out.push({ math: true, t: line.slice(sd) }); break; }
      out.push({ math: true, t: line.slice(sd, close + 2) });
      i = close + 2;
    } else {
      const close = line.indexOf("$", sd + 1);
      if (close < 0) { out.push({ math: true, t: line.slice(sd) }); break; }
      out.push({ math: true, t: line.slice(sd, close + 1) });
      i = close + 1;
    }
  }
  return out;
}

/**
 * Wrap each orphan LaTeX command (\name + immediate arguments) in $...$.
 * Conservative: does NOT pull in surrounding text — just wraps "\delta[n-2]"
 * or "\frac{a}{b}" or "\sum_{i=0}^N" so temml/OMML can render it.
 */
function wrapOrphans(t: string): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    const bs = t.indexOf("\\", i);
    if (bs < 0) { out += t.slice(i); break; }
    if (!/[a-zA-Z]/.test(t[bs + 1] ?? "")) {
      out += t.slice(i, bs + 1);
      i = bs + 1;
      continue;
    }
    // Consume \name
    let e = bs + 1;
    while (e < t.length && /[a-zA-Z]/.test(t[e])) e++;
    // Consume any immediate subscript/superscript/braced/bracketed arguments,
    // possibly chained: \frac{a}{b}, \sum_{i=0}^{N}, \delta[n-2], \mathcal{H}.
    // Allow ONE optional space between command and the bracket/brace.
    while (e < t.length) {
      const c = t[e];
      if (c === "{") {
        const close = matchBrace(t, e, "{", "}");
        if (close < 0) break;
        e = close + 1;
        continue;
      }
      if (c === "[") {
        const close = matchBrace(t, e, "[", "]");
        if (close < 0) break;
        e = close + 1;
        continue;
      }
      if (c === "_" || c === "^") {
        e++;
        if (e < t.length && (t[e] === "{" || t[e] === "[")) {
          const open = t[e];
          const close = matchBrace(t, e, open, open === "{" ? "}" : "]");
          if (close < 0) break;
          e = close + 1;
        } else if (e < t.length && /[A-Za-z0-9]/.test(t[e])) {
          e++;
        }
        continue;
      }
      break;
    }
    out += t.slice(i, bs) + "$" + t.slice(bs, e) + "$";
    i = e;
  }
  return out;
}

function matchBrace(t: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = openIdx; i < t.length; i++) {
    if (t[i] === openCh) depth++;
    else if (t[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
