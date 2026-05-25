// Convert short inline LaTeX-ish math to Unicode for environments that
// cannot render OMML/MathML (PPTX bullets, plain markdown previews).
//
// Heuristic: aggressive Unicode replacement for things that have proper
// glyphs (Greek, super/sub, common operators). Anything that can't be
// faithfully represented in Unicode is preserved verbatim — the slide
// builder should escalate those to image rendering.

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε", Zeta: "Ζ",
  Eta: "Η", Theta: "Θ", Iota: "Ι", Kappa: "Κ", Lambda: "Λ", Mu: "Μ", Nu: "Ν",
  Xi: "Ξ", Omicron: "Ο", Pi: "Π", Rho: "Ρ", Sigma: "Σ", Tau: "Τ", Upsilon: "Υ",
  Phi: "Φ", Chi: "Χ", Psi: "Ψ", Omega: "Ω",
};

const OPERATORS = {
  "sum": "∑", "prod": "∏", "int": "∫", "iint": "∬", "iiint": "∭", "oint": "∮",
  "infty": "∞", "partial": "∂", "nabla": "∇", "forall": "∀", "exists": "∃",
  "in": "∈", "notin": "∉", "subset": "⊂", "supset": "⊃", "subseteq": "⊆",
  "cup": "∪", "cap": "∩", "emptyset": "∅", "varnothing": "∅",
  "leq": "≤", "geq": "≥", "neq": "≠", "approx": "≈", "equiv": "≡", "sim": "∼",
  "pm": "±", "mp": "∓", "times": "×", "div": "÷", "cdot": "·", "ast": "∗",
  "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒",
  "Leftarrow": "⇐", "leftrightarrow": "↔", "mapsto": "↦",
  "ldots": "…", "cdots": "⋯", "vdots": "⋮", "ddots": "⋱",
  "angle": "∠", "perp": "⊥", "parallel": "∥",
  "log": "log", "sin": "sin", "cos": "cos", "tan": "tan", "arctan": "arctan",
  "ln": "ln", "exp": "exp", "lim": "lim", "max": "max", "min": "min",
};

const SUP = {
  "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹",
  "+":"⁺","-":"⁻","=":"⁼","(":"⁽",")":"⁾","n":"ⁿ","i":"ⁱ",
  "a":"ᵃ","b":"ᵇ","c":"ᶜ","d":"ᵈ","e":"ᵉ","f":"ᶠ","g":"ᵍ","h":"ʰ","j":"ʲ",
  "k":"ᵏ","l":"ˡ","m":"ᵐ","o":"ᵒ","p":"ᵖ","r":"ʳ","s":"ˢ","t":"ᵗ","u":"ᵘ",
  "v":"ᵛ","w":"ʷ","x":"ˣ","y":"ʸ","z":"ᶻ",
};

const SUB = {
  "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉",
  "+":"₊","-":"₋","=":"₌","(":"₍",")":"₎",
  "a":"ₐ","e":"ₑ","h":"ₕ","i":"ᵢ","j":"ⱼ","k":"ₖ","l":"ₗ","m":"ₘ","n":"ₙ",
  "o":"ₒ","p":"ₚ","r":"ᵣ","s":"ₛ","t":"ₜ","u":"ᵤ","v":"ᵥ","x":"ₓ",
};

function toSuper(s) {
  let out = "";
  for (const ch of s) {
    if (SUP[ch]) out += SUP[ch];
    else return null; // not fully convertible
  }
  return out;
}

function toSub(s) {
  let out = "";
  for (const ch of s) {
    if (SUB[ch]) out += SUB[ch];
    else return null;
  }
  return out;
}

// Replace \alpha, \omega, \sum, etc. with Unicode glyphs.
function replaceCommands(s) {
  return s.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (m, name) => {
    if (GREEK[name]) return GREEK[name];
    if (OPERATORS[name]) return OPERATORS[name];
    return m;
  });
}

// Replace x^{...} and x_{...} where the body is convertible to Unicode.
function replaceScripts(s) {
  // Display sigma-like: \sum_{a}^{b}  →  ∑(a≤·≤b)
  s = s.replace(/(∑|∏|∫)\s*_\{([^{}]+)\}\s*\^\{([^{}]+)\}/g, (_m, op, lo, hi) => {
    return `${op}(${lo}…${hi})`;
  });
  s = s.replace(/(∑|∏|∫)\s*\^\{([^{}]+)\}\s*_\{([^{}]+)\}/g, (_m, op, hi, lo) => {
    return `${op}(${lo}…${hi})`;
  });
  // Generic ^{...}: try Unicode, else keep
  s = s.replace(/\^\{([^{}]+)\}/g, (m, body) => toSuper(body) ?? m);
  s = s.replace(/_\{([^{}]+)\}/g, (m, body) => toSub(body) ?? m);
  // Single-char: x^2  ->  x²
  s = s.replace(/\^([A-Za-z0-9+\-=()])/g, (m, ch) => SUP[ch] ?? m);
  s = s.replace(/_([A-Za-z0-9+\-=()])/g, (m, ch) => SUB[ch] ?? m);
  return s;
}

// Convert $...$ inline math segments to Unicode. Leave $$...$$ for image rendering.
function processDollarMath(s) {
  // Strip $ delimiters and apply transforms inside them.
  return s.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_m, body) => {
    let out = replaceCommands(body);
    out = replaceScripts(out);
    return out;
  });
}

function applyTextFallbacks(s) {
  // Fractions \frac{a}{b} -> (a)/(b); also \dfrac, \tfrac.
  s = s.replace(/\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_m, a, b) => `(${a})/(${b})`);
  // \sqrt[n]{x} -> ⁿ√(x), \sqrt{x} -> √(x)
  s = s.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^{}]+)\}/g, (_m, n, x) => `${toSuper(n) ?? n}√(${x})`);
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, (_m, x) => `√(${x})`);
  // Accents
  s = s.replace(/\\overline\s*\{([^{}]+)\}/g, "$1\u0304");
  s = s.replace(/\\hat\s*\{([^{}]+)\}/g, "$1\u0302");
  s = s.replace(/\\tilde\s*\{([^{}]+)\}/g, "$1\u0303");
  s = s.replace(/\\dot\s*\{([^{}]+)\}/g, "$1\u0307");
  s = s.replace(/\\ddot\s*\{([^{}]+)\}/g, "$1\u0308");
  s = s.replace(/\\vec\s*\{([^{}]+)\}/g, "$1\u20d7");
  // Mathbb
  s = s.replace(/\\mathbb\s*\{R\}/g, "ℝ");
  s = s.replace(/\\mathbb\s*\{C\}/g, "ℂ");
  s = s.replace(/\\mathbb\s*\{N\}/g, "ℕ");
  s = s.replace(/\\mathbb\s*\{Z\}/g, "ℤ");
  s = s.replace(/\\mathbb\s*\{Q\}/g, "ℚ");
  // Text
  s = s.replace(/\\text\s*\{([^{}]+)\}/g, "$1");
  // Spaces
  s = s.replace(/\\,/g, " ");
  s = s.replace(/\\;/g, " ");
  s = s.replace(/\\:/g, " ");
  s = s.replace(/\\!/g, " ");
  s = s.replace(/\\>/g, " ");
  return s;
}

export function latexToUnicode(text) {
  if (!text) return text;
  let s = text;
  s = processDollarMath(s);
  // Also handle un-delimited LaTeX commands that the model emitted bare
  // (e.g. bullet text: "\sum_{n=0}^N x[n]"). Same transformation outside $$.
  // Avoid touching display math $$...$$ — that's handled by the image path.
  // Split on $$...$$ blocks first to preserve them.
  const parts = s.split(/(\$\$[\s\S]*?\$\$)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      parts[i] = replaceScripts(replaceCommands(parts[i]));
      parts[i] = applyTextFallbacks(parts[i]);
    }
  }
  return parts.join("");
}

// True if the string still contains math that Unicode couldn't render.
export function hasUnrenderedMath(text) {
  if (!text) return false;
  if (/\$\$[\s\S]+?\$\$/.test(text)) return true;
  if (/\\(frac|sqrt|begin|sum|prod|int)\b/.test(text)) return true;
  // Leftover ^{...} or _{...} after Unicode pass.
  if (/[\^_]\{[^{}]+\}/.test(text)) return true;
  return false;
}
