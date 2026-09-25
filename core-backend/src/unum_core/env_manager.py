"""Local runtimes and child processes. Never writes to the user's PATH."""
from __future__ import annotations

import asyncio
import os
import sys
import venv
from pathlib import Path


class EnvironmentManager:
    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()
        self.home = self.workspace / ".unum"
        self.home.mkdir(parents=True, exist_ok=True)

    def runtime(self, name: str, executable: str) -> Path:
        if name not in {"java", "android", "gradle", "maven", "node", "python", "cpp", "lsp"}:
            raise ValueError("Unknown runtime")
        root = (self.home / "runtimes" / name).resolve()
        candidate = (root / executable).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise FileNotFoundError(f"Local {name} executable unavailable: {executable}")
        return candidate

    async def create_venv(self, name: str) -> Path:
        if not name.isidentifier():
            raise ValueError("Invalid environment name")
        path = self.home / "venvs" / name
        await asyncio.to_thread(venv.EnvBuilder(with_pip=True).create, str(path))
        return path

    def child_env(self, *, venv_path: Path | None = None, additions: dict[str, str] | None = None) -> dict[str, str]:
        env = os.environ.copy()
        for key in ("JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_HOME", "M2_HOME", "VIRTUAL_ENV", "PYTHONPATH"):
            env.pop(key, None)
        local_bins = []
        for name, subdir in (("java", "bin"), ("android", "platform-tools"), ("gradle", "bin"), ("maven", "bin"), ("node", "bin"), ("cpp", "bin")):
            folder = self.home / "runtimes" / name / subdir
            if folder.is_dir():
                local_bins.append(str(folder))
        if venv_path:
            local_bins.insert(0, str(venv_path / ("Scripts" if sys.platform == "win32" else "bin")))
            env["VIRTUAL_ENV"] = str(venv_path)
        # Only the child gets this PATH. The parent process and OS are untouched.
        env["PATH"] = os.pathsep.join(local_bins + [env.get("PATH", "")])
        java_home = self.home / "runtimes" / "java"
        android_home = self.home / "runtimes" / "android"
        gradle_home = self.home / "runtimes" / "gradle"
        if java_home.is_dir():
            env["JAVA_HOME"] = str(java_home)
        if android_home.is_dir():
            env["ANDROID_HOME"] = str(android_home)
            env["ANDROID_SDK_ROOT"] = str(android_home)
            env["ANDROID_USER_HOME"] = str(self.home / "android-user")
        if gradle_home.is_dir():
            env["GRADLE_USER_HOME"] = str(self.home / "gradle-cache")
        env["MAVEN_OPTS"] = f"{env.get('MAVEN_OPTS', '')} -Dmaven.repo.local={self.home / 'maven-cache'}".strip()
        env["PIP_CACHE_DIR"] = str(self.home / "pip-cache")
        env["PIP_REQUIRE_VIRTUALENV"] = "true"
        env.update(additions or {})
        return env

    def local_command(self, tool: str) -> Path:
        paths = {
            "adb": ("android", "platform-tools/adb"),
            "gradle": ("gradle", "bin/gradle"),
            "maven": ("maven", "bin/mvn"),
            "java": ("java", "bin/java"),
            "node": ("node", "bin/node"),
        }
        if tool not in paths:
            raise ValueError("Unsupported local tool")
        name, relative = paths[tool]
        suffix = ".exe" if sys.platform == "win32" and tool in {"adb", "java", "node"} else ""
        return self.runtime(name, relative + suffix)

    def project_path(self, raw: str) -> Path:
        path = (self.workspace / raw).resolve()
        if not path.is_relative_to(self.workspace):
            raise ValueError("Path outside workspace")
        return path

    def runtime_status(self) -> dict[str, bool]:
        checks = {"java": "bin/java", "android": "platform-tools/adb", "gradle": "bin/gradle", "maven": "bin/mvn", "node": "bin/node", "cpp": "bin/clang++"}
        status = {name: (self.home / "runtimes" / name / executable).is_file() for name, executable in checks.items()}
        status["java"] = status["java"] and (self.home / "runtimes" / "java" / "bin" / "javac").is_file()
        status["lsp"] = (self.home / "runtimes" / "lsp").is_dir()
        return status
