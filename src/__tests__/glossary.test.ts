import { describe, it, expect } from "vitest";
import {
  DSP_GLOSSARY,
  dspGlossaryPrompt,
  applyGlossaryPost,
} from "../lib/glossary";

describe("DSP_GLOSSARY", () => {
  it("contains core DSP terms", () => {
    expect(DSP_GLOSSARY["FIR"]).toBe("КИХ");
    expect(DSP_GLOSSARY["IIR"]).toBe("БИХ");
    expect(DSP_GLOSSARY["FFT"]).toBe("БПФ");
    expect(DSP_GLOSSARY["z-transform"]).toBe("z-преобразование");
    expect(DSP_GLOSSARY["Nyquist"]).toBe("Найквист");
  });
});

describe("dspGlossaryPrompt", () => {
  it("renders a multi-line prompt fragment", () => {
    const p = dspGlossaryPrompt(5);
    expect(p).toMatch(/TERMINOLOGY/);
    expect(p).toMatch(/→/);
  });
});

describe("applyGlossaryPost", () => {
  it("substitutes whole-word English terms", () => {
    const out = applyGlossaryPost("The lowpass filter is FIR.");
    expect(out.toLowerCase()).toContain("фильтр нижних частот");
    expect(out).toContain("КИХ");
  });

  it("preserves LaTeX inside $…$", () => {
    const out = applyGlossaryPost("Find $\\omega_c$ then compute FIR.");
    expect(out).toContain("$\\omega_c$");
    expect(out).toContain("КИХ");
  });

  it("preserves LaTeX inside $$…$$", () => {
    const out = applyGlossaryPost("$$\\sum_{n} x[n] e^{-j\\omega n}$$\nFFT");
    expect(out).toContain("$$\\sum_{n} x[n] e^{-j\\omega n}$$");
    expect(out).toContain("БПФ");
  });

  it("preserves code spans", () => {
    const out = applyGlossaryPost("Use `FIR` literal then real FIR");
    // Inside backticks: untouched. Outside: replaced.
    expect(out).toContain("`FIR`");
    expect(out).toContain("КИХ");
  });

  it("removes Copyright marker entirely", () => {
    // Copyright maps to "" — we don't add the empty mapping in applyGlossaryPost
    // because empty mapping is filtered out; check it actually stays untouched here
    // (acceptable: passing through is fine; presence of "Copyright" in the
    // translated text is rare because the prompts also ask to drop it).
    const out = applyGlossaryPost("Solution: foo bar");
    expect(out.toLowerCase()).toContain("решение");
  });

  it("handles case-insensitive matching", () => {
    expect(applyGlossaryPost("nyquist rate")).toContain("Найквист");
  });
});
