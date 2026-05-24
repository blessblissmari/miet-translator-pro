/**
 * Markdown-aware chunker.
 *
 * Goal: split a long Markdown document into chunks ≤ maxChars without ever
 * cutting inside a logical block. Blocks that must stay together:
 *   - display math:        $$ ... $$  (multi-line)
 *   - LaTeX environments:  \begin{cases}…\end{cases}, \begin{align}…\end{align}, …
 *   - markdown tables:     consecutive lines starting and ending with |
 *   - fenced code blocks:  ``` ... ```
 *   - list blocks:         consecutive list items + nested items
 *   - heading + first paragraph (heading should not be orphaned at end of chunk)
 *
 * If a single block by itself exceeds maxChars, it's emitted alone (never split).
 */

const MATH_ENVS = [
  "cases", "align", "align\\*", "aligned", "alignat", "alignat\\*",
  "equation", "equation\\*", "gather", "gather\\*", "gathered",
  "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix",
  "smallmatrix", "array", "split",
];

interface Block { text: string; isHeading: boolean }

/** Tokenize a Markdown string into atomic blocks (each is one logical unit). */
export function tokenizeMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines
    if (lines[i].trim() === "") { i++; continue; }

    // Fenced code block
    const fenceMatch = lines[i].match(/^(\s*)(```|~~~)/);
    if (fenceMatch) {
      const fence = fenceMatch[2];
      const start = i;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) i++;
      if (i < lines.length) i++; // include closing fence
      blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
      continue;
    }

    // Display math $$ ... $$
    if (lines[i].trim().startsWith("$$")) {
      const start = i;
      // Single-line $$..$$
      const inline = lines[i].match(/^\s*\$\$[\s\S]*\$\$\s*$/);
      if (inline) {
        blocks.push({ text: lines[i], isHeading: false });
        i++;
        continue;
      }
      i++;
      while (i < lines.length && !lines[i].includes("$$")) i++;
      if (i < lines.length) i++; // include closing $$
      blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
      continue;
    }

    // \begin{env} ... \end{env}
    const envOpen = lines[i].match(/\\begin\{([a-zA-Z*]+)\}/);
    if (envOpen && MATH_ENVS.some(e => e.replace(/\\/g, "") === envOpen[1])) {
      const env = envOpen[1].replace(/\*/g, "\\*");
      const start = i;
      const closer = new RegExp(`\\\\end\\{${env}\\}`);
      while (i < lines.length && !closer.test(lines[i])) i++;
      if (i < lines.length) i++; // include closer line
      blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
      continue;
    }

    // Markdown table: header + separator + rows
    if (isTableLine(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const start = i;
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) i++;
      blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
      continue;
    }

    // Heading
    if (/^#{1,6}\s/.test(lines[i].trim())) {
      blocks.push({ text: lines[i], isHeading: true });
      i++;
      continue;
    }

    // List block: consecutive list items (may include indented continuations)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.trim() === "") {
          // Allow ONE blank line inside a list if next line is still a list item
          if (i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) {
            i += 2; continue;
          }
          break;
        }
        if (/^\s*([-*+]|\d+[.)])\s+/.test(ln) || /^\s{2,}\S/.test(ln)) { i++; continue; }
        break;
      }
      blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
      continue;
    }

    // Plain paragraph: until blank line
    const start = i;
    while (i < lines.length && lines[i].trim() !== "") i++;
    blocks.push({ text: lines.slice(start, i).join("\n"), isHeading: false });
  }
  return blocks;
}

function isTableLine(s: string): boolean {
  const t = s.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}
function isTableSeparator(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  // Cells must be only -, :, spaces
  return t.split("|").slice(1, -1).every(c => /^\s*:?-{2,}:?\s*$/.test(c));
}

/** Group blocks into chunks ≤ maxChars; never splits a block. */
export function chunkBlocks(blocks: Block[], maxChars = 3500): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push(buf.join("\n\n"));
    buf = []; len = 0;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const blen = b.text.length + 2;

    // Heading should not be the last block in a chunk → start a new chunk if there's content
    if (b.isHeading && len > 0 && len + blen > maxChars * 0.6) {
      flush();
    }

    if (len > 0 && len + blen > maxChars) {
      flush();
    }

    buf.push(b.text);
    len += blen;

    // If a heading just got pushed alone and the next block is small, keep
    // them together by NOT flushing until the next paragraph is appended.
  }
  flush();
  return out;
}

/** Convenience: chunk a Markdown string into ≤ maxChars chunks safely. */
export function chunkMarkdown(md: string, maxChars = 3500): string[] {
  return chunkBlocks(tokenizeMarkdown(md), maxChars);
}
