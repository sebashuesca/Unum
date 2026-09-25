"""Embedded document collections backed by a workspace local dbm key/value engine."""
from __future__ import annotations

import asyncio
import dbm
import json
import re
import uuid
from pathlib import Path


class DocumentStore:
    def __init__(self, workspace: Path):
        self.root = workspace / ".unum" / "documents"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = asyncio.Lock()

    def _path(self, collection: str) -> str:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", collection):
            raise ValueError("Invalid collection name")
        return str(self.root / collection)

    async def collections(self) -> list[str]:
        return sorted({p.name.split(".")[0] for p in self.root.iterdir() if p.is_file()})

    async def list(self, collection: str, offset: int = 0, limit: int = 100) -> dict:
        path = self._path(collection)
        def read():
            with dbm.open(path, "c") as store:
                keys = sorted(store.keys())
                selected = keys[max(0, offset):max(0, offset) + min(max(1, limit), 500)]
                return {"total": len(keys), "documents": [{"id": key.decode(), "value": json.loads(store[key])} for key in selected]}
        async with self.lock:
            return await asyncio.to_thread(read)

    async def put(self, collection: str, value: object, document_id: str | None = None) -> str:
        path = self._path(collection)
        key = document_id or uuid.uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", key):
            raise ValueError("Invalid document id")
        encoded = json.dumps(value, ensure_ascii=False).encode()
        def write():
            with dbm.open(path, "c") as store:
                store[key] = encoded
        async with self.lock:
            await asyncio.to_thread(write)
        return key

    async def delete(self, collection: str, document_id: str) -> None:
        path = self._path(collection)
        def remove():
            with dbm.open(path, "c") as store:
                del store[document_id]
        async with self.lock:
            await asyncio.to_thread(remove)
