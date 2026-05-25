import { describe, it, expect } from "vitest";
import { latexToUnicode, hasUnrenderedMath } from "../lib/mathUnicode";

describe("latexToUnicode", () => {
  it("converts Greek letters", () => {
    expect(latexToUnicode("$\\alpha + \\beta = \\gamma$")).toBe("α + β = γ");
    expect(latexToUnicode("$\\Omega$ and $\\omega$")).toBe("Ω and ω");
  });

  it("converts common operators", () => {
    expect(latexToUnicode("$x \\in \\mathbb{R}$")).toContain("∈");
    expect(latexToUnicode("$\\infty$")).toBe("∞");
    expect(latexToUnicode("$\\leq$, $\\geq$, $\\neq$")).toBe("≤, ≥, ≠");
  });

  it("converts simple super/subscripts", () => {
    expect(latexToUnicode("$x^2$")).toBe("x²");
    expect(latexToUnicode("$x^{2}$")).toBe("x²");
    expect(latexToUnicode("$x_n$")).toBe("xₙ");
    expect(latexToUnicode("$x_{n+1}$")).toBe("xₙ₊₁");
  });

  it("handles big-operator limits", () => {
    expect(latexToUnicode("$\\sum_{n=0}^{N} x[n]$")).toContain("∑(n=0…N)");
    expect(latexToUnicode("$\\int_{-\\infty}^{\\infty} f(x) dx$")).toContain("∫(-∞…∞)");
  });

  it("converts fractions and sqrt", () => {
    expect(latexToUnicode("$\\frac{1}{2}$")).toBe("(1)/(2)");
    expect(latexToUnicode("$\\sqrt{x}$")).toBe("√(x)");
    expect(latexToUnicode("$\\sqrt[3]{x}$")).toBe("³√(x)");
  });

  it("converts accents", () => {
    expect(latexToUnicode("$\\hat{x}$")).toContain("\u0302");
    expect(latexToUnicode("$\\vec{v}$")).toContain("\u20d7");
    expect(latexToUnicode("$\\overline{x}$")).toContain("\u0304");
  });

  it("works on bare LaTeX (no dollar delimiters)", () => {
    expect(latexToUnicode("text \\alpha and \\sum_{i=1}^{n} stuff")).toContain("α");
    expect(latexToUnicode("text \\alpha and \\sum_{i=1}^{n} stuff")).toContain("∑(i=1…n)");
  });

  it("preserves $$ display math for image-rendering", () => {
    const out = latexToUnicode("simple $x^2$ then $$\\frac{1}{2}$$");
    expect(out).toContain("x²");
    // $$...$$ block left intact (caller may decide to render as image)
    expect(out).toContain("$$");
  });

  it("DSP-style impulse train", () => {
    const out = latexToUnicode("$\\sum_{n=-\\infty}^{\\infty} \\delta(t-nT) \\cdot p(t-nT)$");
    expect(out).toContain("∑(n=-∞…∞)");
    expect(out).toContain("δ(t-nT)");
    expect(out).toContain("·");
    expect(out).not.toContain("\\sum");
    expect(out).not.toContain("\\delta");
  });
});

describe("hasUnrenderedMath", () => {
  it("detects $$..$$ blocks", () => {
    expect(hasUnrenderedMath("$$\\frac{1}{2}$$")).toBe(true);
  });
  it("detects leftover macros", () => {
    expect(hasUnrenderedMath("text \\frac{a}{b} more")).toBe(true);
  });
  it("returns false for clean Unicode", () => {
    expect(hasUnrenderedMath("π/2 plus ∑ₙ x[n]")).toBe(false);
  });
});
