#!/usr/bin/env bash
# Convenience launcher for the MinerU bridge.
# Creates .venv on first run, installs deps, then starts the server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ ! -d ".venv" ]; then
  echo "[mineru-bridge] creating .venv…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f ".venv/.installed" ]; then
  echo "[mineru-bridge] installing dependencies (first run, may take a few minutes)…"
  pip install --upgrade pip
  pip install -r server/requirements.txt
  touch .venv/.installed
fi

exec python server/main.py
