"""Local runtimes and child processes. Never writes to the user's PATH."""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import venv
from pathlib import Path


def process_group_options() -> dict:
    return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        process.terminate()
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), 2)
    except asyncio.TimeoutError:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()


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
        if getattr(sys, "frozen", False):
            executable = self.runtime("python", "python.exe" if os.name == "nt" else "bin/python")
            process = await asyncio.create_subprocess_exec(str(executable), "-m", "venv", str(path),
                                                            cwd=self.workspace, env=self.child_env())
            if await process.wait():
                raise RuntimeError("Workspace Python runtime failed to create a virtual environment")
        else:
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
            env["ANDROID_AVD_HOME"] = str(self.home / "android-user" / "avd")
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
            "emulator": ("android", "emulator/emulator"),
            "gradle": ("gradle", "bin/gradle"),
            "maven": ("maven", "bin/mvn"),
            "java": ("java", "bin/java"),
            "node": ("node", "bin/node"),
        }
        if tool not in paths:
            raise ValueError("Unsupported local tool")
        name, relative = paths[tool]
        suffix = ({"adb": ".exe", "emulator": ".exe", "java": ".exe", "node": ".exe",
                   "gradle": ".bat", "maven": ".cmd"}.get(tool, "") if os.name == "nt" else "")
        return self.runtime(name, relative + suffix)

    def project_path(self, raw: str) -> Path:
        path = (self.workspace / raw).resolve()
        if not path.is_relative_to(self.workspace):
            raise ValueError("Path outside workspace")
        return path

    def runtime_status(self) -> dict[str, bool]:
        checks = {"java": "bin/java", "android": "platform-tools/adb", "gradle": "bin/gradle", "maven": "bin/mvn", "node": "bin/node", "cpp": "bin/clang++"}
        if os.name == "nt":
            checks = {"java": "bin/java.exe", "android": "platform-tools/adb.exe", "gradle": "bin/gradle.bat",
                      "maven": "bin/mvn.cmd", "node": "bin/node.exe", "cpp": "bin/clang++.exe"}
        status = {name: (self.home / "runtimes" / name / executable).is_file() for name, executable in checks.items()}
        status["emulator"] = (self.home / "runtimes" / "android" / "emulator" / ("emulator.exe" if os.name == "nt" else "emulator")).is_file()
        status["java"] = status["java"] and (self.home / "runtimes" / "java" / "bin" / ("javac.exe" if os.name == "nt" else "javac")).is_file()
        status["lsp"] = (self.home / "runtimes" / "lsp").is_dir()
        return status
