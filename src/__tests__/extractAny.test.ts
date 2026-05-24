import { describe, it, expect } from "vitest";
import { classifyInput } from "../lib/extractAny";

describe("classifyInput", () => {
  it("classifies PDF", () => {
    expect(classifyInput("report.pdf")).toBe("pdf");
    expect(classifyInput("SLIDES.PDF")).toBe("pdf");
  });
  it("classifies PPTX", () => {
    expect(classifyInput("deck.pptx")).toBe("pptx");
  });
  it("classifies DOCX", () => {
    expect(classifyInput("essay.docx")).toBe("docx");
  });
  it("classifies images", () => {
    expect(classifyInput("photo.png")).toBe("image");
    expect(classifyInput("scan.jpg")).toBe("image");
    expect(classifyInput("pic.jpeg")).toBe("image");
    expect(classifyInput("anim.gif")).toBe("image");
    expect(classifyInput("art.webp")).toBe("image");
  });
  it("classifies text files", () => {
    expect(classifyInput("notes.txt")).toBe("text");
    expect(classifyInput("readme.md")).toBe("text");
  });
  it("returns unknown for unrecognized", () => {
    expect(classifyInput("data.csv")).toBe("unknown");
    expect(classifyInput("video.mp4")).toBe("unknown");
  });
});
