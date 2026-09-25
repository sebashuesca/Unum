"""Execute source files only with workspace-local runtimes."""
from __future__ import annotations

import asyncio
import os
import re
import signal
from collections.abc import Awaitable, Callable
from pathlib import Path

from .env_manager import EnvironmentManager

Emit = Callable[[dict], Awaitable[None]]


class SourceRunner:
    def __init__(self, env: EnvironmentManager):
        self.env = env

    async def run(self, raw: str, emit: Emit) -> int:
        source = self.env.project_path(raw)
        if not source.is_file():
            raise ValueError("Source file not found")
        suffix = source.suffix.lower()
        environment = self.env.child_env()
        if suffix == ".py":
            venv_path = self.env.home / "venvs" / "workspace"
            if not venv_path.exists():
                await self.env.create_venv("workspace")
            executable = venv_path / "bin" / "python"
            environment = self.env.child_env(venv_path=venv_path)
            command = [str(executable), str(source)]
        elif suffix == ".js":
            command = [str(self.env.local_command("node")), str(source)]
        elif suffix == ".java":
            command = [str(self.env.local_command("java")), str(source)]
        elif suffix in {".cpp", ".cc"}:
            compiler = self.env.runtime("cpp", "bin/clang++")
            build_dir = self.env.home / "build"
            build_dir.mkdir(exist_ok=True)
            output = build_dir / re.sub(r"[^A-Za-z0-9_-]", "_", raw)
            code = await self._process([str(compiler), str(source), "-o", str(output)], source.parent, environment, emit)
            if code:
                return code
            command = [str(output)]
        else:
            raise ValueError("Run supports Python, JavaScript, Java and C++ source files")
        return await self._process(command, source.parent, environment, emit)

    async def _process(self, command: list[str], cwd: Path, environment: dict, emit: Emit) -> int:
        process = await asyncio.create_subprocess_exec(*command, cwd=cwd, env=environment,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        async def pump(reader: asyncio.StreamReader, channel: str):
            while chunk := await reader.readline():
                await emit({"event": "run.output", "channel": channel, "data": chunk.decode("utf-8", "replace")})
        try:
            await asyncio.gather(pump(process.stdout, "stdout"), pump(process.stderr, "stderr"))
            return await process.wait()
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                await process.wait()
