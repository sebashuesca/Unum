"""Chunked WebSocket uploads used by CSV/XLSX drag and drop."""
from __future__ import annotations

import base64
import binascii
import re
import uuid
from pathlib import Path


class Uploads:
    def __init__(self, workspace: Path):
        self.root = workspace / ".unum" / "uploads"
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace = workspace
        self.active: dict[str, dict] = {}

    def begin(self, filename: str, size: int) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_. -]{1,120}\.(csv|xlsx)", filename, re.I):
            raise ValueError("Select a CSV or XLSX file")
        if not isinstance(size, int) or size < 0 or size > 100_000_000:
            raise ValueError("Import limit is 100 MB")
        upload_id = uuid.uuid4().hex
        path = self.root / f"{upload_id}-{filename}"
        self.active[upload_id] = {"path": path, "size": size, "received": 0, "file": path.open("wb")}
        return {"upload_id": upload_id}

    def chunk(self, upload_id: str, data: str) -> dict:
        entry = self.active.get(upload_id)
        if not entry or entry["file"].closed:
            raise ValueError("Upload not active")
        try:
            chunk = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid upload chunk") from exc
        if len(chunk) > 1024 * 1024 or entry["received"] + len(chunk) > entry["size"]:
            raise ValueError("Upload chunk exceeds declared size")
        entry["file"].write(chunk)
        entry["received"] += len(chunk)
        return {"received": entry["received"], "total": entry["size"]}

    def finish(self, upload_id: str) -> dict:
        entry = self.active.get(upload_id)
        if not entry or entry["received"] != entry["size"]:
            raise ValueError("Upload incomplete")
        entry["file"].close()
        return {"path": str(entry["path"].relative_to(self.workspace))}

    def close(self) -> None:
        for entry in self.active.values():
            if not entry["file"].closed:
                entry["file"].close()
            entry["path"].unlink(missing_ok=True)
        self.active.clear()
