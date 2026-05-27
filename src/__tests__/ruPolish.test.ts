import { describe, it, expect } from "vitest";
import { polishRu } from "../lib/ruPolish";

describe("polishRu", () => {
  it("converts Latin subpart letters to Cyrillic", () => {
    expect(polishRu("2. (a) text")).toContain("(а)");
    expect(polishRu("(b) и (c) и (d)")).toBe("(б) и (в) и (г)");
  });
  it("leaves math (n+1) and (e^{jω}) alone", () => {
    expect(polishRu("формула $x[n] = u[n+1]$")).toContain("u[n+1]");
    expect(polishRu("$e^{j\\omega}$")).toBe("$e^{j\\omega}$");
  });
  it("translates common English phrases", () => {
    expect(polishRu("Based on (c), Hence Therefore")).toMatch(/На основании.*Следовательно/);
  });
  it("replaces 'каузальная' with 'причинная'", () => {
    expect(polishRu("каузальной последовательности")).toBe("причинной последовательности");
    expect(polishRu("каузальный фильтр")).toBe("причинный фильтр");
  });
  it("drops Mitra boilerplate", () => {
    expect(polishRu("Copyright © 2010, S. K. Mitra")).toBe("");
    expect(polishRu("© 2001 Mitra")).toBe("");
  });
  it("low-pass filter -> фильтр нижних частот", () => {
    expect(polishRu("низкочастотный фильтр Баттерворта")).toContain("фильтр нижних частот");
  });
});

import { polishRu as polishRu2 } from "../lib/ruPolish";

describe("CJK scrubbing", () => {
  it("repairs CJK morphemes in russian prose", () => {
    const out = polishRu2("система без 记忆ной (нем记忆ной)");
    expect(out).not.toMatch(/[\u4e00-\u9fff]/);
    expect(out).toContain("памят");
  });
  it("drops unknown CJK runs entirely", () => {
    expect(polishRu2("текст 测试 ещё текст")).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it("leaves clean text alone", () => {
    expect(polishRu2("обычный русский текст")).toBe("обычный русский текст");
  });
});
