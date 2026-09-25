#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
if [ ! -x "$HERE/.venv/bin/python" ]; then
  python3 -m venv "$HERE/.venv"
fi
if ! "$HERE/.venv/bin/python" -c 'import unum_core, fastapi, pandas, sqlalchemy, jsonschema, cryptography, zstandard, asyncpg, asyncmy, pymongo, redis, cassandra' 2>/dev/null; then
  "$HERE/.venv/bin/python" -m pip install -e "$HERE"
fi
export UNUM_WORKSPACE="$ROOT"
exec "$HERE/.venv/bin/python" -m unum_core.main
