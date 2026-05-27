import { describe, it, expect } from "vitest";
import { preprocessLatex } from "../lib/latexOmml";

describe("preprocessLatex", () => {
  it("repairs whitespace injected mid-command", () => {
    expect(preprocessLatex(String.raw`\m athcal{H}`)).toContain("ℋ");
    expect(preprocessLatex(String.raw`3\d elta[n-2]`)).toBe(String.raw`3\delta[n-2]`);
    expect(preprocessLatex(String.raw`\f rac{a}{b}`)).toBe(String.raw`\frac{a}{b}`);
    expect(preprocessLatex(String.raw`\sum_{n=0}^{\inf ty}`)).toBe(String.raw`\sum_{n=0}^{\infty}`);
  });

  it("collapses doubled backslash for known macros", () => {
    expect(preprocessLatex(String.raw`\\mathcal{H}`)).toBe("ℋ");
    expect(preprocessLatex(String.raw`\\delta[n]`)).toBe(String.raw`\delta[n]`);
    // Leaves real \\ (line break) alone — `xyz` is not a known command.
    expect(preprocessLatex(String.raw`a\\xyz b`)).toBe(String.raw`a\\xyz b`);
  });

  it("substitutes mathcal/mathbb/mathbf single letters to unicode", () => {
    expect(preprocessLatex(String.raw`\mathcal{H}`)).toBe("ℋ");
    expect(preprocessLatex(String.raw`\mathbb{R}`)).toBe("ℝ");
    expect(preprocessLatex(String.raw`\mathbb{N}`)).toBe("ℕ");
    expect(preprocessLatex(String.raw`\mathbf{x}`)).toBe("𝐱");
  });

  it("leaves plain math unchanged", () => {
    const s = String.raw`y[n] = x[n+1] - 2x[n] + x[n-1]`;
    expect(preprocessLatex(s)).toBe(s);
  });
});
