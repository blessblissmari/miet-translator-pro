"""
Local MinerU bridge server for miet-translator.

A minimal FastAPI app that wraps the official `mineru` CLI / library. The
frontend (hosted on GitHub Pages) talks to this server running on the user's
own machine — files never leave the local network.

Endpoint:
    POST /parse        multipart "file"   →  { markdown, title, images: [...] }
    GET  /health                          →  { ok: true, mineru_version }

Run:
    pip install -r server/requirements.txt
    python -m mineru.cli.models_download           # one-off: pull model weights
    python server/main.py                          # listens on :8765

The CORS policy allows GitHub Pages and any localhost origin by default; tweak
the `ALLOWED_ORIGINS` env var (comma-separated) to add others.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ── Config ──────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("MINERU_BRIDGE_PORT", "8765"))
HOST = os.environ.get("MINERU_BRIDGE_HOST", "127.0.0.1")
DEFAULT_ORIGINS = [
    "https://blessblissmari.github.io",
    "http://localhost:5173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:4173",
]
ALLOWED_ORIGINS = [
    *DEFAULT_ORIGINS,
    *[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()],
]
# Choose a backend: "pipeline" (CPU-friendly) or "vlm-transformers" (better, needs GPU+RAM).
# Override with env: MINERU_BACKEND=vlm-transformers
DEFAULT_BACKEND = os.environ.get("MINERU_BACKEND", "pipeline")

# ── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="MinerU bridge", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _mineru_version() -> str:
    """Probe installed mineru version. Returns "n/a" if the CLI is missing."""
    try:
        r = subprocess.run(
            ["mineru", "--version"], capture_output=True, text=True, timeout=10
        )
        return (r.stdout or r.stderr).strip()
    except Exception as e:
        return f"n/a ({e})"


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mineru_version": _mineru_version(),
        "backend": DEFAULT_BACKEND,
        "allowed_origins": ALLOWED_ORIGINS,
    }


@app.post("/parse")
async def parse(
    file: UploadFile = File(...),
    backend: str | None = None,
    lang: str = "auto",
) -> JSONResponse:
    """
    Parse a single document with MinerU and return its markdown + embedded
    figures. Synchronous: small PDFs ~5-20s; large ones a few minutes.

    Body: multipart/form-data with "file" field.

    Returns:
        {
          "markdown": "# Title\n\n...",
          "title": "First H1 if any",
          "images": [{"name": "fig_1.png", "dataUrl": "data:image/png;base64,..."}],
          "stats": {"pages": N, "elapsed_ms": M}
        }
    """
    if not file.filename:
        raise HTTPException(400, "missing filename")

    used_backend = backend or DEFAULT_BACKEND
    with tempfile.TemporaryDirectory(prefix="mineru-bridge-") as tmpdir:
        tmp_in = Path(tmpdir) / file.filename
        with tmp_in.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        out_dir = Path(tmpdir) / "out"
        out_dir.mkdir()

        # Invoke the mineru CLI. We prefer the CLI over the library API because
        # it's the most stable surface across mineru versions (1.x → 2.x).
        cmd = [
            "mineru",
            "-p",
            str(tmp_in),
            "-o",
            str(out_dir),
            "-b",
            used_backend,
            "-l",
            lang,
        ]
        import time
        t0 = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True)
        elapsed_ms = int((time.time() - t0) * 1000)
        if proc.returncode != 0:
            raise HTTPException(
                500,
                f"mineru failed (code {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}",
            )

        # Locate the produced markdown file.
        md_files = list(out_dir.rglob("*.md"))
        if not md_files:
            raise HTTPException(500, "mineru did not produce any markdown output")
        # Prefer the largest .md (most likely the full document)
        md_path = max(md_files, key=lambda p: p.stat().st_size)
        markdown = md_path.read_text(encoding="utf-8")

        # Extract title from first H1
        title = None
        for line in markdown.splitlines():
            s = line.strip()
            if s.startswith("# "):
                title = s.removeprefix("# ").strip()
                break

        # Collect figures from sibling images/ directory
        images: list[dict[str, str]] = []
        img_dir = md_path.parent / "images"
        if img_dir.is_dir():
            for img_path in sorted(img_dir.iterdir()):
                if img_path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                    continue
                try:
                    data = img_path.read_bytes()
                    mime = (
                        "image/png"
                        if img_path.suffix.lower() == ".png"
                        else "image/jpeg"
                        if img_path.suffix.lower() in {".jpg", ".jpeg"}
                        else "image/webp"
                    )
                    b64 = base64.b64encode(data).decode("ascii")
                    images.append({"name": img_path.name, "dataUrl": f"data:{mime};base64,{b64}"})
                except Exception:
                    continue

        # Try to get page count from content_list.json if present
        pages = None
        for cl in out_dir.rglob("*_content_list.json"):
            try:
                blocks = json.loads(cl.read_text(encoding="utf-8"))
                if isinstance(blocks, list):
                    page_idx = [b.get("page_idx") for b in blocks if isinstance(b, dict)]
                    if page_idx:
                        pages = max(i for i in page_idx if isinstance(i, int)) + 1
                        break
            except Exception:
                continue

        return JSONResponse(
            {
                "markdown": markdown,
                "title": title,
                "images": images,
                "stats": {"pages": pages, "elapsed_ms": elapsed_ms, "backend": used_backend},
            }
        )


if __name__ == "__main__":
    import uvicorn

    print(
        f"[mineru-bridge] starting on http://{HOST}:{PORT}\n"
        f"  backend: {DEFAULT_BACKEND}\n"
        f"  allowed origins: {ALLOWED_ORIGINS}\n",
        file=sys.stderr,
    )
    uvicorn.run("server.main:app", host=HOST, port=PORT, reload=False)
