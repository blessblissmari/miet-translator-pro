import temml from "temml";

/** Convert a LaTeX formula to OMML (Office Math Markup Language) XML string.
 * Strategy: temml renders MathML, then we transform MathML → OMML using a small
 * converter. We use a tiny MathML→OMML transform good enough for basic formulas
 * (fractions, exponents, subscripts, sums, integrals, identifiers, operators).
 */
export function latexToOmml(latex: string, display = false): string {
  const cleanLatex = preprocessLatex(latex);
  let mathml: string;
  try {
    mathml = temml.renderToString(cleanLatex, { displayMode: display, throwOnError: false });
  } catch {
    return fallbackOmml(cleanLatex);
  }
  try {
    const mathEl = parseMathml(mathml);
    if (!mathEl) return fallbackOmml(cleanLatex);
    const inner = mathmlToOmmlChildren(mathEl);
    return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`;
  } catch {
    return fallbackOmml(cleanLatex);
  }
}

/* ── MathML parsing ─────────────────────────────────────── */

/** Parse MathML preferring XML mode (HTML parser can mangle MathML inner
 *  content in some browsers, e.g. Chromium splits `<mi>` text by char or
 *  fails to preserve foreign-content). Falls back to text/html. */
function parseMathml(mathml: string): Element | null {
  const parser = new DOMParser();
  // Try XML first — MathML is XML, this is the correct mode.
  try {
    const xmlSrc = mathml.includes("xmlns=")
      ? mathml
      : mathml.replace(/<math\b/, '<math xmlns="http://www.w3.org/1998/Math/MathML"');
    const dom = parser.parseFromString(xmlSrc, "application/xhtml+xml");
    const parserErr = dom.querySelector("parsererror");
    if (!parserErr) {
      const el = dom.querySelector("math");
      if (el) return el;
    }
  } catch { /* fall through */ }
  // Fallback: HTML parsing
  const dom = parser.parseFromString(mathml, "text/html");
  return dom.querySelector("math");
}

/* ── LaTeX preprocessing ────────────────────────────────── */

// Known LaTeX commands the model commonly uses. Used to repair mid-command
// whitespace and to map single-letter font-style macros to Unicode glyphs.
const KNOWN_CMDS = [
  // Greek lower
  "alpha","beta","gamma","delta","epsilon","varepsilon","zeta","eta","theta",
  "vartheta","iota","kappa","lambda","mu","nu","xi","pi","varpi","rho","varrho",
  "sigma","varsigma","tau","upsilon","phi","varphi","chi","psi","omega",
  // Greek upper
  "Gamma","Delta","Theta","Lambda","Xi","Pi","Sigma","Upsilon","Phi","Psi","Omega",
  // Common operators / symbols
  "sum","prod","int","oint","lim","sup","inf","max","min","arg","log","ln","lg",
  "sin","cos","tan","cot","sec","csc","arcsin","arccos","arctan","sinh","cosh","tanh",
  "exp","det","dim","gcd","ker","deg","hom","Pr",
  "infty","partial","nabla","cdot","cdots","ldots","dots","vdots","ddots",
  "leq","geq","neq","approx","equiv","sim","simeq","cong","propto","perp","parallel",
  "to","gets","mapsto","Rightarrow","Leftarrow","Leftrightarrow","rightarrow","leftarrow",
  "in","notin","subset","subseteq","supset","supseteq","cup","cap","emptyset","forall","exists",
  "pm","mp","times","div","ast","star","cdot","circ","bullet","oplus","otimes",
  // Structures
  "frac","tfrac","dfrac","binom","sqrt","overline","underline","hat","tilde","bar","vec","dot","ddot",
  "left","right","big","Big","bigg","Bigg","bigl","bigr","Bigl","Bigr",
  "mathcal","mathbb","mathbf","mathrm","mathit","mathsf","mathtt","mathfrak","operatorname",
  "text","textbf","textit","textrm","textsf",
  "quad","qquad",",",";",":","!","\\",
  "begin","end",
];

const KNOWN_CMD_SET = new Set(KNOWN_CMDS);

// Unicode maps for font-style commands applied to single letters.
const MATHCAL_MAP: Record<string, string> = {
  A:"𝒜",B:"ℬ",C:"𝒞",D:"𝒟",E:"ℰ",F:"ℱ",G:"𝒢",H:"ℋ",I:"ℐ",J:"𝒥",
  K:"𝒦",L:"ℒ",M:"ℳ",N:"𝒩",O:"𝒪",P:"𝒫",Q:"𝒬",R:"ℛ",S:"𝒮",T:"𝒯",
  U:"𝒰",V:"𝒱",W:"𝒲",X:"𝒳",Y:"𝒴",Z:"𝒵",
};
const MATHBB_MAP: Record<string, string> = {
  A:"𝔸",B:"𝔹",C:"ℂ",D:"𝔻",E:"𝔼",F:"𝔽",G:"𝔾",H:"ℍ",I:"𝕀",J:"𝕁",
  K:"𝕂",L:"𝕃",M:"𝕄",N:"ℕ",O:"𝕆",P:"ℙ",Q:"ℚ",R:"ℝ",S:"𝕊",T:"𝕋",
  U:"𝕌",V:"𝕍",W:"𝕎",X:"𝕏",Y:"𝕐",Z:"ℤ",
};
const MATHBF_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  // Mathematical Bold A-Z = U+1D400..U+1D419
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1d400 + i);
    m[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1d41a + i);
  }
  return m;
})();
const MATHFRAK_MAP: Record<string, string> = {
  A:"𝔄",B:"𝔅",C:"ℭ",D:"𝔇",E:"𝔈",F:"𝔉",G:"𝔊",H:"ℌ",I:"ℑ",J:"𝔍",
  K:"𝔎",L:"𝔏",M:"𝔐",N:"𝔑",O:"𝔒",P:"𝔓",Q:"𝔔",R:"ℜ",S:"𝔖",T:"𝔗",
  U:"𝔘",V:"𝔙",W:"𝔚",X:"𝔛",Y:"𝔜",Z:"ℨ",
};

/** Pre-clean LaTeX before sending to temml.
 *  Fixes common upstream mangling so we get correct MathML and thus correct OMML. */
export function preprocessLatex(latex: string): string {
  if (!latex) return latex;
  let s = latex;

  // 1) Repair `\\` immediately followed by an alpha that starts a known macro.
  //    `\\mathcal{H}` (from JSON over-escape or model confusion) → `\mathcal{H}`.
  //    Only do this when the resulting `\name` is a known command — otherwise
  //    `\\` is a legitimate newline.
  s = s.replace(/\\\\([A-Za-z]+)/g, (m, name) => KNOWN_CMD_SET.has(name) ? `\\${name}` : m);

  // 2) Repair mid-command whitespace: `\m athcal{...}` → `\mathcal{...}`.
  //    For each `\<letters><spaces><letters>` try greedy joins; accept the
  //    longest match that yields a known command.
  s = s.replace(/\\([A-Za-z]+(?:\s+[A-Za-z]+){1,4})/g, (m, body) => {
    const joined = body.replace(/\s+/g, "");
    // Try longest prefix that is a known command.
    for (let len = joined.length; len >= 2; len--) {
      const head = joined.slice(0, len);
      if (KNOWN_CMD_SET.has(head)) {
        const tail = joined.slice(len);
        return `\\${head}${tail ? " " + tail : ""}`;
      }
    }
    return m;
  });

  // 3) Substitute single-letter font-style macros to Unicode glyphs.
  //    This sidesteps temml's class-based styling which the MathML→OMML
  //    converter loses.
  const subSingle = (map: Record<string, string>, name: string) =>
    (s = s.replace(new RegExp(`\\\\${name}\\s*\\{\\s*([A-Za-z])\\s*\\}`, "g"),
      (m, ch) => map[ch] ?? m));
  subSingle(MATHCAL_MAP, "mathcal");
  subSingle(MATHBB_MAP, "mathbb");
  subSingle(MATHBF_MAP, "mathbf");
  subSingle(MATHFRAK_MAP, "mathfrak");

  return s;
}

function fallbackOmml(latex: string): string {
  return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>${escapeXml(latex)}</m:t></m:r></m:oMath>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mathmlToOmmlChildren(node: Element): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent || "").trim();
      if (t) out += `<m:r><m:t>${escapeXml(t)}</m:t></m:r>`;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    out += elemToOmml(el);
  }
  return out;
}

function elemToOmml(el: Element): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "math":
    case "mrow":
    case "mstyle":
    case "semantics":
    case "annotation-xml":
      return mathmlToOmmlChildren(el);
    case "annotation":
      return "";
    case "mi":
    case "mn":
    case "mo":
    case "mtext":
    case "ms": {
      const t = (el.textContent || "").trim();
      if (!t) return "";
      return `<m:r><m:t xml:space="preserve">${escapeXml(t)}</m:t></m:r>`;
    }
    case "mspace":
      return `<m:r><m:t xml:space="preserve"> </m:t></m:r>`;
    case "mfrac": {
      const [num, den] = elementChildren(el);
      return `<m:f><m:num>${num ? mathmlToOmmlChildren(wrapMrow(num)) : ""}</m:num><m:den>${den ? mathmlToOmmlChildren(wrapMrow(den)) : ""}</m:den></m:f>`;
    }
    case "msup": {
      const [base, sup] = elementChildren(el);
      return `<m:sSup><m:e>${base ? mathmlToOmmlChildren(wrapMrow(base)) : ""}</m:e><m:sup>${sup ? mathmlToOmmlChildren(wrapMrow(sup)) : ""}</m:sup></m:sSup>`;
    }
    case "msub": {
      const [base, sub] = elementChildren(el);
      return `<m:sSub><m:e>${base ? mathmlToOmmlChildren(wrapMrow(base)) : ""}</m:e><m:sub>${sub ? mathmlToOmmlChildren(wrapMrow(sub)) : ""}</m:sub></m:sSub>`;
    }
    case "msubsup": {
      const [base, sub, sup] = elementChildren(el);
      return `<m:sSubSup><m:e>${base ? mathmlToOmmlChildren(wrapMrow(base)) : ""}</m:e><m:sub>${sub ? mathmlToOmmlChildren(wrapMrow(sub)) : ""}</m:sub><m:sup>${sup ? mathmlToOmmlChildren(wrapMrow(sup)) : ""}</m:sup></m:sSubSup>`;
    }
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg></m:deg><m:e>${mathmlToOmmlChildren(el)}</m:e></m:rad>`;
    case "mroot": {
      const [base, deg] = elementChildren(el);
      return `<m:rad><m:deg>${deg ? mathmlToOmmlChildren(wrapMrow(deg)) : ""}</m:deg><m:e>${base ? mathmlToOmmlChildren(wrapMrow(base)) : ""}</m:e></m:rad>`;
    }
    case "munder":
    case "mover":
    case "munderover": {
      const kids = elementChildren(el);
      return mathmlToOmmlChildren(wrapMrowList(kids));
    }
    case "mfenced": {
      const open = el.getAttribute("open") ?? "(";
      const close = el.getAttribute("close") ?? ")";
      return `<m:d><m:dPr><m:begChr m:val="${escapeXml(open)}"/><m:endChr m:val="${escapeXml(close)}"/></m:dPr><m:e>${mathmlToOmmlChildren(el)}</m:e></m:d>`;
    }
    default:
      return mathmlToOmmlChildren(el);
  }
}

function elementChildren(el: Element): Element[] {
  return Array.from(el.children);
}

function wrapMrow(el: Element): Element {
  // Treat any single element as if it were wrapped in <mrow> for traversal
  return el;
}
function wrapMrowList(els: Element[]): Element {
  const tmp = document.createElement("mrow");
  for (const e of els) tmp.appendChild(e.cloneNode(true));
  return tmp;
}
