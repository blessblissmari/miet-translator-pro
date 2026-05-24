# MinerU local bridge

A tiny FastAPI server that lets the **miet-translator** web app (hosted on
GitHub Pages) parse PDFs locally with [MinerU](https://github.com/opendatalab/MinerU).

Why local? PDF parsing happens on your own machine — files never leave your
network, no API tokens, no quotas, no cost.

## Quick start

```bash
# 1. Create a Python 3.10+ environment (recommended)
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# 2. Install dependencies (downloads ~2 GB of model weights on first PDF)
pip install -r server/requirements.txt

# 3. Start the bridge — listens on http://127.0.0.1:8765
python server/main.py
```

In the miet-translator UI:

1. Open **Настройки** → check **Использовать MinerU как парсер**.
2. Select **Режим: Локальный**.
3. Endpoint URL stays at `http://localhost:8765`.
4. Drop a PDF on the queue — it'll be sent to your local server.

## Configuration

Environment variables:

| Variable             | Default                   | Description                                        |
| -------------------- | ------------------------- | -------------------------------------------------- |
| `MINERU_BRIDGE_PORT` | `8765`                    | Port to listen on                                  |
| `MINERU_BRIDGE_HOST` | `127.0.0.1`               | Bind address. Use `0.0.0.0` for LAN access         |
| `MINERU_BACKEND`     | `pipeline`                | `pipeline` (CPU) or `vlm-transformers` (GPU)       |
| `ALLOWED_ORIGINS`    | (github.io + localhost)   | Extra CORS origins, comma-separated                |

## Endpoints

- `GET  /health` → `{ ok, mineru_version, backend, allowed_origins }`
- `POST /parse` (multipart `file`) → `{ markdown, title, images, stats }`

## Performance notes

- **First request is slow** — MinerU lazily downloads model weights (~2 GB).
- For a 20-page paper on CPU expect ~30-60 s. Use `MINERU_BACKEND=vlm-transformers`
  on a GPU for higher quality + faster runs.
- Output `images` are returned inline as base64 data URLs — fine for ≤ a few
  dozen figures per doc; for very image-heavy PDFs consider increasing your
  browser's memory budget or running with `MINERU_BACKEND=pipeline`.

## Production / shared deployment

If you want to run the bridge for multiple users:

```bash
MINERU_BRIDGE_HOST=0.0.0.0 \
ALLOWED_ORIGINS="https://yourdomain.com" \
python server/main.py
```

…or stick it behind nginx with HTTPS termination. The server is stateless and
spawns a subprocess per request, so horizontal scaling works as expected.
