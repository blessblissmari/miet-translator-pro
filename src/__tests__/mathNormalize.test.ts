import { describe, it, expect } from "vitest";
import { normalizeMath } from "../lib/mathNormalize";

describe("normalizeMath", () => {
  it("converts \\( ... \\) to $...$", () => {
    expect(normalizeMath("the value \\(x^2\\) here")).toBe("the value $x^2$ here");
  });

  it("converts \\[ ... \\] to $$...$$ (with newlines)", () => {
    expect(normalizeMath("equation \\[a+b\\] end")).toBe("equation \n$$a+b$$\n end");
  });

  it("leaves $...$ unchanged", () => {
    const s = "inline $x$ and display $$y$$";
    expect(normalizeMath(s)).toBe(s);
  });

  it("handles empty string", () => {
    expect(normalizeMath("")).toBe("");
  });
});
