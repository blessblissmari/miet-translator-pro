import temml from "temml";

/** Convert a LaTeX formula to OMML (Office Math Markup Language) XML string.
 * Strategy: temml renders MathML, then we transform MathML → OMML using a small
 * converter. We use a tiny MathML→OMML transform good enough for basic formulas
 * (fractions, exponents, subscripts, sums, integrals, identifiers, operators).
 */
export function latexToOmml(latex: string, display = false): string {
  let mathml: string;
  try {
    mathml = temml.renderToString(latex, { displayMode: display, throwOnError: false });
  } catch {
    return fallbackOmml(latex);
  }
  try {
    const parser = new DOMParser();
    const dom = parser.parseFromString(mathml, "text/html");
    const mathEl = dom.querySelector("math");
    if (!mathEl) return fallbackOmml(latex);
    const inner = mathmlToOmmlChildren(mathEl);
    return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`;
  } catch {
    return fallbackOmml(latex);
  }
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
