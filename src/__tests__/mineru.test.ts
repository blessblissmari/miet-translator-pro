import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import {
  mineruZipToExtractedDoc,
  submitUrlTask,
  pollTask,
  submitFileTask,
  pollBatch,
  extractWithMineruLocal,
  checkLocalBridge,
  localResponseToExtractedDoc,
} from "../lib/mineru";

describe("mineruZipToExtractedDoc", () => {
  it("parses a result zip with full.md into pages", async () => {
    const zip = new JSZip();
    zip.file(
      "full.md",
      "# Hello\n\nThis is a parsed document.\n\n## Section\n\nMore text here.",
    );
    const buf = await zip.generateAsync({ type: "arraybuffer" });

    const doc = await mineruZipToExtractedDoc(buf);
    expect(doc.pages.length).toBeGreaterThanOrEqual(1);
    expect(doc.pages[0].text).toContain("Hello");
    expect(doc.meta.title).toBe("Hello");
  });

  it("falls back to a single empty page when zip has no markdown", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "no markdown here");
    const buf = await zip.generateAsync({ type: "arraybuffer" });

    const doc = await mineruZipToExtractedDoc(buf);
    expect(doc.pages.length).toBe(1);
    expect(doc.pages[0].text).toBe("(пусто)");
  });

  it("splits long markdown into multiple pages", async () => {
    const longMd =
      "# Title\n\n" + Array.from({ length: 200 }, (_, i) => `Paragraph ${i}. `.repeat(20)).join("\n\n");
    const zip = new JSZip();
    zip.file("full.md", longMd);
    const buf = await zip.generateAsync({ type: "arraybuffer" });

    const doc = await mineruZipToExtractedDoc(buf);
    expect(doc.pages.length).toBeGreaterThan(1);
  });

  it("extracts title from first H1 heading", async () => {
    const zip = new JSZip();
    zip.file("full.md", "# My Document\n\nBody text.");
    const buf = await zip.generateAsync({ type: "arraybuffer" });

    const doc = await mineruZipToExtractedDoc(buf);
    expect(doc.meta.title).toBe("My Document");
  });
});

describe("MinerU API client (mocked fetch)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("submitUrlTask returns task_id on success", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 0, data: { task_id: "task_123" } }),
    });
    const id = await submitUrlTask("https://example.com/doc.pdf", {
      token: "fake-token",
    });
    expect(id).toBe("task_123");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/extract/task"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer fake-token",
        }),
      }),
    );
  });

  it("submitUrlTask throws on non-zero API code", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 401, msg: "invalid token" }),
    });
    await expect(
      submitUrlTask("https://example.com/doc.pdf", { token: "bad" }),
    ).rejects.toThrow(/invalid token/);
  });

  it("submitUrlTask throws on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    await expect(
      submitUrlTask("https://example.com/doc.pdf", { token: "x" }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("pollTask returns data when state=done", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: { state: "done", full_zip_url: "https://example.com/result.zip" },
      }),
    });
    const data = await pollTask("task_123", { token: "x" });
    expect(data.state).toBe("done");
    expect(data.full_zip_url).toBe("https://example.com/result.zip");
  });

  it("pollTask throws when state=failed", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: { state: "failed", err_msg: "OCR engine crashed" },
      }),
    });
    await expect(pollTask("task_123", { token: "x" })).rejects.toThrow(
      /OCR engine crashed/,
    );
  });

  it("submitFileTask uploads file via signed PUT URL and returns batch_id", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { batch_id: "batch_abc", file_urls: ["https://upload.example.com/sig1"] },
        }),
      })
      .mockResolvedValueOnce({ ok: true }); // PUT

    const blob = new Blob(["fake pdf"], { type: "application/pdf" });
    const id = await submitFileTask(blob, "test.pdf", { token: "x" });
    expect(id).toBe("batch_abc");
    // Verify the PUT was called to the signed URL
    expect(fetchSpy.mock.calls[1][0]).toBe("https://upload.example.com/sig1");
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: "PUT" });
  });

  it("submitFileTask throws when upload-url request fails", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    const blob = new Blob(["x"], { type: "application/pdf" });
    await expect(submitFileTask(blob, "x.pdf", { token: "bad" })).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it("pollBatch returns zip URL when result state=done", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          extract_result: [
            { file_name: "x.pdf", state: "done", full_zip_url: "https://r.example/r.zip" },
          ],
        },
      }),
    });
    const r = await pollBatch("batch_abc", { token: "x" });
    expect(r.full_zip_url).toBe("https://r.example/r.zip");
  });

  it("pollBatch throws when first result state=failed", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          extract_result: [{ file_name: "x.pdf", state: "failed", err_msg: "unsupported" }],
        },
      }),
    });
    await expect(pollBatch("batch_abc", { token: "x" })).rejects.toThrow(/unsupported/);
  });
});

describe("MinerU local bridge (mocked fetch)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("localResponseToExtractedDoc returns pages from markdown", () => {
    const doc = localResponseToExtractedDoc({
      markdown: "# Local Title\n\nFirst para.\n\nSecond para.",
      title: "Local Title",
      images: [],
    });
    expect(doc.pages.length).toBeGreaterThanOrEqual(1);
    expect(doc.pages[0].text).toContain("First para");
    expect(doc.meta.title).toBe("Local Title");
  });

  it("localResponseToExtractedDoc extracts title from H1 when not provided", () => {
    const doc = localResponseToExtractedDoc({
      markdown: "# Inferred Title\n\nbody",
      images: [],
    });
    expect(doc.meta.title).toBe("Inferred Title");
  });

  it("localResponseToExtractedDoc falls back gracefully on empty markdown", () => {
    const doc = localResponseToExtractedDoc({ markdown: "", images: [] });
    expect(doc.pages.length).toBe(1);
    expect(doc.pages[0].text).toBe("(пусто)");
  });

  it("localResponseToExtractedDoc uses first image as preview when present", () => {
    const doc = localResponseToExtractedDoc({
      markdown: "# Title\n\nbody",
      images: [{ name: "fig1.png", dataUrl: "data:image/png;base64,FAKE" }],
    });
    expect(doc.pages[0].imageDataUrl).toBe("data:image/png;base64,FAKE");
  });

  it("checkLocalBridge returns parsed JSON on 200", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, mineru_version: "2.1.0", backend: "pipeline" }),
    });
    const r = await checkLocalBridge("http://localhost:8765");
    expect(r?.ok).toBe(true);
    expect(r?.mineru_version).toBe("2.1.0");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8765/health",
      expect.objectContaining({}),
    );
  });

  it("checkLocalBridge returns null when server unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"));
    const r = await checkLocalBridge("http://localhost:8765");
    expect(r).toBeNull();
  });

  it("checkLocalBridge strips trailing slash from endpoint", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    await checkLocalBridge("http://localhost:8765/");
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:8765/health");
  });

  it("extractWithMineruLocal POSTs FormData to /parse and parses response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        markdown: "# Hello\n\nFrom local server.",
        title: "Hello",
        images: [],
        stats: { pages: 1, elapsed_ms: 1234, backend: "pipeline" },
      }),
    });
    const blob = new Blob(["fake pdf"], { type: "application/pdf" });
    const doc = await extractWithMineruLocal(blob, "test.pdf", {
      endpoint: "http://localhost:8765",
      backend: "pipeline",
      lang: "ru",
    });
    expect(doc.pages[0].text).toContain("From local server");
    expect(doc.meta.title).toBe("Hello");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("http://localhost:8765/parse");
    expect(String(url)).toContain("backend=pipeline");
    expect(String(url)).toContain("lang=ru");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("extractWithMineruLocal throws on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "mineru crashed",
    });
    const blob = new Blob(["x"], { type: "application/pdf" });
    await expect(
      extractWithMineruLocal(blob, "x.pdf", { endpoint: "http://localhost:8765" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
