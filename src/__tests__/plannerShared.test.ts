import { describe, it, expect } from "vitest";
import { stripCodeFences, parseMarkdownToBlocks } from "../lib/plannerShared";

describe("stripCodeFences", () => {
  it("strips triple-backtick fences", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
  it("strips fences without language tag", () => {
    expect(stripCodeFences("```\nhello\n```")).toBe("hello");
  });
  it("returns plain text unchanged", () => {
    expect(stripCodeFences("hello world")).toBe("hello world");
  });
  it("trims whitespace", () => {
    expect(stripCodeFences("  foo  ")).toBe("foo");
  });
});

describe("parseMarkdownToBlocks", () => {
  it("parses headings", () => {
    const blocks = parseMarkdownToBlocks("# Title\n## Sub\n### Sub2");
    expect(blocks).toEqual([
      { type: "h1", text: "Title" },
      { type: "h2", text: "Sub" },
      { type: "h3", text: "Sub2" },
    ]);
  });

  it("parses unordered list", () => {
    const blocks = parseMarkdownToBlocks("- one\n- two\n- three");
    expect(blocks).toEqual([
      { type: "list", ordered: false, items: ["one", "two", "three"] },
    ]);
  });

  it("parses ordered list", () => {
    const blocks = parseMarkdownToBlocks("1. first\n2. second");
    expect(blocks).toEqual([
      { type: "list", ordered: true, items: ["first", "second"] },
    ]);
  });

  it("parses paragraphs", () => {
    const blocks = parseMarkdownToBlocks("Hello world.\n\nSecond paragraph.");
    expect(blocks).toEqual([
      { type: "para", text: "Hello world." },
      { type: "para", text: "Second paragraph." },
    ]);
  });

  it("parses display math (single-line)", () => {
    const blocks = parseMarkdownToBlocks("$$E = mc^2$$");
    expect(blocks).toEqual([
      { type: "formula", latex: "E = mc^2", display: true },
    ]);
  });

  it("parses display math (multi-line)", () => {
    const blocks = parseMarkdownToBlocks("$$\nx^2 + y^2\n$$");
    expect(blocks).toEqual([
      { type: "formula", latex: "x^2 + y^2", display: true },
    ]);
  });

  it("parses markdown table", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toEqual([
      {
        type: "table",
        rows: [["A", "B"], ["1", "2"], ["3", "4"]],
        header: true,
      },
    ]);
  });

  it("handles mixed content", () => {
    const md = "# Intro\n\nSome text.\n\n- bullet\n\n$$x=1$$\n\nEnd.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "h1", "para", "list", "formula", "para",
    ]);
  });

  it("switches between ordered and unordered lists", () => {
    const md = "- a\n- b\n\n1. one\n2. two";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toEqual([
      { type: "list", ordered: false, items: ["a", "b"] },
      { type: "list", ordered: true, items: ["one", "two"] },
    ]);
  });
});
