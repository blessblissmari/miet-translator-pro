# MIET Translator Pro — Node.js CLI

Offline / server-side translator for batches of PDFs. Reuses the same prompts
and DSP glossary as the web app but runs the heavy work in Node (with
`pdfjs-dist`, `pandoc`, and Xiaomi **MiMo**).

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
export MIMO_API_KEY=mimo-...
# optional second key for failover:
# export MIMO_API_KEY_2=mimo-...
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
MODEL=mimo-v2-omni node translate-scan.mjs path/to/scan.pdf
```

Outputs land in `./outputs/` (override with `OUT_DIR=/some/path`).
Per-page markdown is saved in `./outputs/markdown/` for inspection.

## Models

Endpoint: `https://token-plan-sgp.xiaomimimo.com/v1` (Singapore, OpenAI-compatible).
Reachable from RU without a VPN. 200M credits per account.

Defaults (override with `MODEL=...`):

- docs / slides — `mimo-v2.5-pro` (flagship, multimodal)
- scans / OCR  — `mimo-v2.5-pro` (vision-capable)
- fallback OCR — `mimo-v2-omni`

Concurrency is set conservatively (4 for docs/slides, 2 for OCR) to stay
under per-key rate limits.
