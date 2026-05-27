// Sanitize LaTeX math so that pandoc-3.x texmath can render it as Office OMML
// without falling back to raw-text output for unsupported commands.
//
// We only mutate text inside math delimiters ($...$ or $$...$$); prose is
// untouched.

const REPLACEMENTS = [
  // Resizable brackets → plain brackets
  [/\\Bigl\(/g, "("], [/\\Bigr\)/g, ")"],
  [/\\bigl\(/g, "("], [/\\bigr\)/g, ")"],
  [/\\biggl\(/g, "("], [/\\biggr\)/g, ")"],
  [/\\Biggl\(/g, "("], [/\\Biggr\)/g, ")"],
  [/\\Bigl\[/g, "["], [/\\Bigr\]/g, "]"],
  [/\\bigl\[/g, "["], [/\\bigr\]/g, "]"],
  [/\\Bigl\\\{/g, "\\{"], [/\\Bigr\\\}/g, "\\}"],
  [/\\bigl\\\{/g, "\\{"], [/\\bigr\\\}/g, "\\}"],
  [/\\Big\(/g, "("], [/\\Big\)/g, ")"], [/\\big\(/g, "("], [/\\big\)/g, ")"],
  [/\\Big\[/g, "["], [/\\Big\]/g, "]"], [/\\big\[/g, "["], [/\\big\]/g, "]"],
  [/\\Big\|/g, "|"], [/\\big\|/g, "|"],
  [/\\left\(/g, "("], [/\\right\)/g, ")"],
  [/\\left\[/g, "["], [/\\right\]/g, "]"],
  [/\\left\\\{/g, "\\{"], [/\\right\\\}/g, "\\}"],
  [/\\left\|/g, "|"], [/\\right\|/g, "|"],
  [/\\left\./g, ""],  [/\\right\./g, ""],
  // Spacing commands that aren't critical
  [/\\,/g, " "], [/\\;/g, " "], [/\\!/g, ""], [/\\:/g, " "], [/\\>/g, " "],
  [/\\quad/g, "  "], [/\\qquad/g, "   "],
  // Phantom and mathstrut
  [/\\phantom\{[^}]*\}/g, ""], [/\\mathstrut/g, ""],
  // Text/mathit/etc to plain
  [/\\textrm\{([^}]*)\}/g, "\\text{$1}"],
  // \notin, \in already supported; just clean problematic commands:
  [/\\nicefrac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2"],
  // Remove \displaystyle (texmath understands it but some converters trip)
  [/\\displaystyle/g, ""],
  // Replace \\[Npt] line break spacers with simple \\
  [/\\\\\s*\[\d+(?:\.\d+)?(?:pt|px|em|mm|cm)\]/g, "\\\\"],
  // \boldsymbol → \mathbf
  [/\\boldsymbol\{([^}]*)\}/g, "\\mathbf{$1}"],
  // \le/\ge already work; convert variants
  [/\\leqslant/g, "\\le"], [/\\geqslant/g, "\\ge"],
];

function sanitizeMath(body) {
  let s = body;
  for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep);
  return s;
}

function stripUnsupportedTex(md) {
  // \includegraphics[opts]{file}  →  *[Рисунок]*
  md = md.replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{[^}]*\}/g, "*[Рисунок]*");
  // \label{x} and \tag{x} — strip
  md = md.replace(/\\label\{[^}]*\}/g, "").replace(/\\tag\{[^}]*\}/g, "");
  // \begin{figure}...\end{figure} blocks — strip wrapper, keep inner
  md = md.replace(/\\begin\{figure\}[\s\S]*?\\end\{figure\}/g, "*[Рисунок]*");
  // \caption{...}  →  *...*
  md = md.replace(/\\caption\{([^}]*)\}/g, "*$1*");
  // \centering — strip
  md = md.replace(/\\centering\b/g, "");

  // Inside aligned / align* / gathered / split / cases / array environments,
  // drop the `&` alignment markers so LibreOffice doesn't render them as `¿`.
  // We turn `&=` (and `& =`) into `=`, and lone `&` into a space.
  md = md.replace(
    /\\begin\{(aligned|align\*?|gathered|split)\}([\s\S]*?)\\end\{\1\}/g,
    (_m, env, body) => {
      const cleaned = body
        .replace(/&\s*=/g, "=")
        .replace(/&\s*\\approx/g, "\\approx")
        .replace(/&\s*\\le\b/g, "\\le")
        .replace(/&\s*\\ge\b/g, "\\ge")
        .replace(/&\s*\\to\b/g, "\\to")
        .replace(/&/g, " ");
      return `\\begin{${env}}${cleaned}\\end{${env}}`;
    },
  );
  return md;
}

export function sanitizeLatexMath(md) {
  md = stripUnsupportedTex(md);
  md = fixUnitsInMath(md);
  // First pass: $$...$$
  md = md.replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => `$$${sanitizeMath(body)}$$`);
  // Second pass: $...$ (avoid $$ already handled — use single-$ regex that
  // doesn't span $$).
  md = md.replace(/(^|[^\$])\$([^\$\n]+?)\$(?!\$)/g, (_m, pre, body) => `${pre}$${sanitizeMath(body)}$`);
  return md;
}

function fixUnitsInMath(md) {
  let prev = "";
  let cur = md;
  let iter = 0;
  while (prev !== cur && iter < 5) {
    prev = cur;
    cur = cur.replace(/\$([^$\n]*?)\$/g, (m, body) => {
      if (!/[а-яёА-ЯЁ]/.test(body)) return m;
      let split = 0;
      while (split < body.length && !/[а-яёА-ЯЁ]/.test(body[split])) split++;
      while (split > 0 && /[\sа-яёА-ЯЁ]/.test(body[split - 1])) split--;
      const math = body.slice(0, split).trim();
      const tail = body.slice(split).trim();
      if (!math) return tail;
      return `$${math}$ ${tail}`;
    });
    iter++;
  }
  return cur;
}

/**
 * Wrap obvious bare math tokens (e.g. `\\delta`, `\\mathcal{H}`, `\\max`,
 * `x[n]`, `x_1[n]`, `\\frac`) that appear OUTSIDE of $...$ / $$...$$ /
 * fenced code into `$...$`. Conservative — only triggers on a small set of
 * unmistakable math patterns to avoid mangling prose.
 */
export function wrapBareMath(md) {
  const parts = [];
  const re = /(\$\$[\s\S]*?\$\$|\$[^\$\n]+\$|```[\s\S]*?```|`[^`\n]+`|!\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(md)) !== null) {
    parts.push({ kind: "text", s: md.slice(last, m.index) });
    parts.push({ kind: "skip", s: m[0] });
    last = re.lastIndex;
  }
  parts.push({ kind: "text", s: md.slice(last) });

  // Patterns to wrap when found in "text" segments.
  // Each pattern matches a single math token (no spaces inside the captured form).
  const tokenRe = new RegExp([
    String.raw`\\(?:delta|sum|int|prod|frac|sqrt|alpha|beta|gamma|sigma|omega|pi|infty|mathcal|mathbb|mathrm|cos|sin|tan|log|ln|exp|max|min|lim|hat|tilde|bar|vec|left|right|cdot|times|geq|leq|neq|approx|to|in|forall|exists)(?:\{[^{}\n]*\})?`,
    String.raw`[A-Za-z]_\{[^{}\n]+\}(?:\[[^\]\n]+\])?`,
    String.raw`[A-Za-z]_[A-Za-z0-9]\[[^\]\n]+\]`,
    String.raw`[A-Za-z]\[[a-zA-Z0-9 +\-*/.,]+\]`,
    String.raw`[A-Za-z]\{[^{}\n]+\}`,
  ].join("|"), "g");

  const out = parts.map(p => {
    if (p.kind === "skip") return p.s;
    return p.s.replace(tokenRe, (mm) => "$" + mm + "$");
  });

  let res = out.join("");
  // Merge adjacent `$a$ $b$` into a single math span to reduce $-noise.
  res = res.replace(/\$([^$\n]+)\$ \$([^$\n]+)\$/g, "$$$1 $2$$");
  return res;
}
