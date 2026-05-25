import { describe, it, expect } from "vitest";
import { wrapOrphanLatex } from "../lib/plannerShared";

describe("wrapOrphanLatex", () => {
  it("wraps a bare \\mathcal command", () => {
    expect(wrapOrphanLatex("y[n] = \\mathcal{H}\\{x[n]\\}"))
      .toContain("$\\mathcal{H}");
  });

  it("preserves text already wrapped in $...$", () => {
    const input = "Уже обёрнуто: $\\mathcal{H}\\{x[n]\\}$ хвост";
    const out = wrapOrphanLatex(input);
    // First occurrence stays $...$, hвост stays unchanged
    expect(out).toContain("Уже обёрнуто: $\\mathcal{H}");
    expect(out).toContain("хвост");
  });

  it("doesn't wrap plain text without LaTeX", () => {
    expect(wrapOrphanLatex("обычный текст без формул")).toBe("обычный текст без формул");
  });
});
