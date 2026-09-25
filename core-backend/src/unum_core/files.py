"""Workspace file operations with path confinement."""
from pathlib import Path

from .env_manager import EnvironmentManager

IGNORED = {".git", ".unum", ".venv", "node_modules", "dist", "dist-electron", "runtimes", "build", "__pycache__"}
MAX_FILE = 2_000_000


class Files:
    def __init__(self, env: EnvironmentManager):
        self.env = env

    def tree(self, raw: str = ".", depth: int = 4) -> list[dict]:
        root = self.env.project_path(raw)
        if not root.is_dir():
            raise ValueError("Not a directory")
        def walk(path: Path, level: int) -> list[dict]:
            if level >= depth:
                return []
            entries = []
            for item in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
                if item.name in IGNORED or item.name.startswith(".") or item.name.endswith(".egg-info"):
                    continue
                if item.is_symlink():
                    continue
                entries.append({"name": item.name, "path": str(item.relative_to(self.env.workspace)),
                                "type": "directory" if item.is_dir() else "file",
                                "children": walk(item, level + 1) if item.is_dir() else []})
            return entries
        return walk(root, 0)

    def read(self, raw: str) -> str:
        path = self.env.project_path(raw)
        if not path.is_file() or path.stat().st_size > MAX_FILE:
            raise ValueError("File unavailable or too large")
        return path.read_text(encoding="utf-8")

    def write(self, raw: str, content: str) -> None:
        if len(content.encode("utf-8")) > MAX_FILE:
            raise ValueError("File too large")
        path = self.env.project_path(raw)
        if not path.parent.is_dir():
            raise ValueError("Parent directory does not exist")
        path.write_text(content, encoding="utf-8")

    def create(self, raw: str) -> None:
        path = self.env.project_path(raw)
        if not path.parent.is_dir():
            raise ValueError("Parent directory does not exist")
        with path.open("x", encoding="utf-8"):
            pass
