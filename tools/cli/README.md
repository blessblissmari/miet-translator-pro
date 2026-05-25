# MIET Translator Pro — Node.js CLI

Offline / server-side translator for batches of PDFs. Reuses the same prompts
and DSP glossary as the web app but runs the heavy work in Node (with
`pdfjs-dist`, `pandoc`, and OpenRouter).

Useful when:
- You have many files (50+ pages) and want unattended overnight runs.
- You want PRO-grade DOCX with native Office equations (we pipe a clean
  Markdown intermediate through `pandoc` so all `$...$` and `$$...$$` math
  becomes real OMML — the web app falls back to italicised Cambria Math).
- You want OCR on scanned PDFs.

## Setup

```bash
cd tools/cli
npm install
# requires pandoc 3.x in PATH for DOCX math rendering:
# Debian: apt-get install pandoc (>=3.0) — older 2.x will reject \Bigl etc.
export OPENROUTER_API_KEY_ONE=sk-or-...
```

## Three pipelines

| script                       | input                          | output                                        |
| ---------------------------- | ------------------------------ | --------------------------------------------- |
| `translate-docs-pandoc.mjs`  | text-rich academic PDF         | DOCX with native Office equations (ГОСТ)      |
| `translate-slides.mjs`       | landscape slide-deck PDF       | PPTX in MIET template (`assets/template.pptx`)|
| `translate-scan.mjs`         | scanned / image-only PDF       | DOCX via vision-model OCR + pandoc            |

The simple `translate-docs.mjs` (italics-fallback math) is kept for reference;
prefer `translate-docs-pandoc.mjs` for production quality.

## Usage

```bash
# Documents
node translate-docs-pandoc.mjs path/to/A.pdf path/to/B.pdf
# Slide decks
node translate-slides.mjs path/to/Lecture1.pdf
# Scans (handwritten or photographed)
MODEL=nvidia/nemotron-nano-12b-v2-vl:free \
  node translate-scan.mjs path/to/scan.pdf
```

Outputs land in `./outputs/` (override with `OUT_DIR=/some/path`).
Per-page markdown is saved in `./outputs/markdown/` for inspection.

## Models

Defaults (override with `MODEL=...`):

- docs / slides — `openai/gpt-oss-120b:free` (text-only, stable, reasoning auto-excluded)
- scans / OCR  — `google/gemma-4-26b-a4b-it:free` (vision, may be rate-limited)
- fallback OCR — `nvidia/nemotron-nano-12b-v2-vl:free`

Free OpenRouter models have aggressive per-account rate limits;
concurrency is set conservatively (4 for docs/slides, 2 for OCR).
