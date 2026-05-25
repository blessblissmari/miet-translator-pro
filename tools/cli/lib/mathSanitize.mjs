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
  // First pass: $$...$$
  md = md.replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => `$$${sanitizeMath(body)}$$`);
  // Second pass: $...$ (avoid $$ already handled — use single-$ regex that
  // doesn't span $$).
  md = md.replace(/(^|[^\$])\$([^\$\n]+?)\$(?!\$)/g, (_m, pre, body) => `${pre}$${sanitizeMath(body)}$`);
  return md;
}
