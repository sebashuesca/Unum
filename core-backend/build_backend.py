"""Build a native, self-contained backend for electron-builder extraResources."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "core-backend"
FRONTEND = ROOT / "app-frontend"


def target() -> tuple[str, str]:
    if sys.platform == "win32":
        return "win", "unum-backend.exe"
    if sys.platform.startswith("linux"):
        return "linux", "unum-backend"
    raise SystemExit("Unum packaging currently supports native Windows and Linux builds")


def build() -> Path:
    from PyInstaller.__main__ import run as pyinstaller_run

    platform_dir, executable = target()
    output = FRONTEND / "resources" / "bin" / platform_dir
    work = BACKEND / "build" / "pyinstaller" / platform_dir
    output.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    options = [
        str(BACKEND / "packaging_entry.py"),
        "--name=unum-backend",
        "--onefile",
        "--console",
        "--noconfirm",
        "--clean",
        "--noupx",
        f"--paths={BACKEND / 'src'}",
        f"--distpath={output}",
        f"--workpath={work}",
        f"--specpath={work}",
    ]
    for package in ("unum_core", "uvicorn", "sqlalchemy", "aiosqlite", "asyncpg",
                    "asyncmy", "redis", "cassandra", "pymongo"):
        options.extend(("--collect-submodules", package))
    for package in ("jsonschema", "jsonschema_specifications", "pandas", "openpyxl", "certifi"):
        options.extend(("--collect-data", package))
    for module in ("sqlalchemy.dialects.sqlite.aiosqlite", "sqlalchemy.dialects.postgresql.asyncpg",
                   "sqlalchemy.dialects.mysql.asyncmy", "uvicorn.loops.auto",
                   "uvicorn.protocols.http.auto", "uvicorn.protocols.websockets.auto"):
        options.extend(("--hidden-import", module))
    pyinstaller_run(options)
    binary = output / executable
    if not binary.is_file():
        raise SystemExit(f"PyInstaller did not create {binary}")
    print(binary)
    return binary


if __name__ == "__main__":
    build()
