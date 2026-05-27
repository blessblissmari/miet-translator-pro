import { describe, it, expect } from "vitest";
import { wrapOrphanLatex, sanitizeHtml } from "../lib/plannerShared";

describe("wrapOrphanLatex", () => {
  it("wraps a whole math-shaped line as a single span", () => {
    const out = wrapOrphanLatex("y[n] = \\mathcal{H}\\{x[n]\\}");
    expect(out).toBe("$y[n] = \\mathcal{H}\\{x[n]\\}$");
  });

  it("wraps multi-equality lines", () => {
    const out = wrapOrphanLatex("y[n] = x[n+1] - 2x[n] + x[n-1]");
    expect(out).toBe("$y[n] = x[n+1] - 2x[n] + x[n-1]$");
  });

  it("preserves text already wrapped in $...$", () => {
    const input = "Уже обёрнуто: $\\mathcal{H}\\{x[n]\\}$ хвост";
    const out = wrapOrphanLatex(input);
    expect(out).toContain("Уже обёрнуто: $\\mathcal{H}");
    expect(out).toContain("хвост");
  });

  it("doesn't wrap plain Russian prose without LaTeX", () => {
    expect(wrapOrphanLatex("обычный текст без формул")).toBe("обычный текст без формул");
  });

  it("doesn't wrap Russian prose containing math-shaped tokens", () => {
    // We must NOT eat Russian prose just because it contains brackets.
    const input = "Найдите импульсную характеристику системы.";
    expect(wrapOrphanLatex(input)).toBe(input);
  });

  it("wraps a bare \\delta inside Russian prose", () => {
    const input = "Сигнал \\delta[n-2] на входе.";
    const out = wrapOrphanLatex(input);
    expect(out).toContain("$\\delta[n-2]$");
    expect(out).toContain("Сигнал");
    expect(out).toContain("на входе");
  });

  it("wraps standalone x[n] inside Russian prose", () => {
    const input = "Дан сигнал x[n] на входе.";
    const out = wrapOrphanLatex(input);
    expect(out).toContain("$x[n]$");
  });

  it("does not touch lines starting with markdown list markers", () => {
    const input = "- y[n] = x[n] (bullet)";
    const out = wrapOrphanLatex(input);
    // The whole line should not be wrapped as $...$ — bullet must be preserved.
    expect(out.startsWith("- ")).toBe(true);
  });
});

describe("sanitizeHtml", () => {
  it("converts <sub>/<sup> attached to a variable into $...$", () => {
    expect(sanitizeHtml("Threshold V<sub>T</sub> shifts."))
      .toBe("Threshold $V_{T}$ shifts.");
    expect(sanitizeHtml("X<sup>2</sup> term."))
      .toBe("$X^{2}$ term.");
  });

  it("converts <b> and <i> outside math to Markdown", () => {
    expect(sanitizeHtml("<b>Bold</b> and <i>italic</i>"))
      .toBe("**Bold** and *italic*");
  });

  it("converts HTML entities", () => {
    expect(sanitizeHtml("&alpha; &le; &pi;")).toBe("α ≤ π");
  });

  it("strips unknown tags but keeps inner text", () => {
    expect(sanitizeHtml("Hello <span class=\"x\">world</span>")).toBe("Hello world");
  });

  it("drops <script> and <style> blocks entirely", () => {
    expect(sanitizeHtml("a<script>evil()</script>b")).toBe("ab");
    expect(sanitizeHtml("a<style>.x{}</style>b")).toBe("ab");
  });

  it("converts <sub> inside $...$ to _{...} LaTeX", () => {
    expect(sanitizeHtml("$V<sub>T</sub>$")).toBe("$V_{T}$");
  });

  it("does not touch existing math spans", () => {
    expect(sanitizeHtml("text $x^2$ tail")).toBe("text $x^2$ tail");
  });

  it("converts <br> to newline outside math", () => {
    expect(sanitizeHtml("line1<br>line2")).toBe("line1\nline2");
  });
});
