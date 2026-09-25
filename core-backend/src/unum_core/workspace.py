"""Validated, atomic workspace preferences stored next to the project."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

LANGUAGES = {"java", "kotlin", "sql", "javascript", "typescript", "python", "cpp"}
DATABASES = {"postgresql", "mysql", "sqlite", "mongodb", "cassandra", "redis"}
SDKS = {"java21", "android34"}


class WorkspaceConfig:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.path = self.root / "unum_workspace.json"

    def load(self) -> dict | None:
        if not self.path.is_file():
            return None
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise ValueError("Workspace configuration must be an object")
        languages = payload.get("languages", [])
        databases = payload.get("databases", [])
        sdks = payload.get("sdks", [])
        if any(not isinstance(group, list) for group in (languages, databases, sdks)):
            raise ValueError("Selections must be lists")
        if not languages or not set(languages) <= LANGUAGES or not set(databases) <= DATABASES or not set(sdks) <= SDKS:
            raise ValueError("Invalid workspace selections")
        config = {
            "version": 1,
            "languages": sorted(set(languages)),
            "databases": sorted(set(databases)),
            "sdks": sorted(set(sdks)),
            "active_database": payload.get("active_database", "sqlite"),
        }
        if config["active_database"] not in config["databases"]:
            config["active_database"] = config["databases"][0] if config["databases"] else "sqlite"
        descriptor, temporary = tempfile.mkstemp(prefix=".unum-workspace-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(config, output, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return config
