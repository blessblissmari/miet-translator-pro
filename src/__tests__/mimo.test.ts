import { describe, it, expect } from "vitest";
import { parseJsonLoose } from "../lib/mimo";

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("finds JSON in surrounding text", () => {
    expect(parseJsonLoose('Here is the result: {"x": 2} done')).toEqual({ x: 2 });
  });

  it("handles nested objects", () => {
    const input = '{"outer": {"inner": true}}';
    expect(parseJsonLoose(input)).toEqual({ outer: { inner: true } });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonLoose("not json")).toThrow();
  });
});
