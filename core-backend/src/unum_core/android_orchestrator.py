"""Local Android/Java tools; device polling and streamed build output."""
from __future__ import annotations

import asyncio
import os
import shlex
import signal
from collections.abc import Awaitable, Callable

from .env_manager import EnvironmentManager


class AndroidOrchestrator:
    def __init__(self, env: EnvironmentManager):
        self.env = env

    async def devices(self) -> list[dict]:
        adb = self.env.local_command("adb")
        process = await asyncio.create_subprocess_exec(str(adb), "devices", "-l", cwd=self.env.workspace,
            env=self.env.child_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(process.communicate(), 10)
        if process.returncode:
            raise RuntimeError(error.decode("utf-8", "replace"))
        return [{"serial": line.split()[0], "state": line.split()[1], "detail": " ".join(line.split()[2:])}
                for line in output.decode().splitlines()[1:] if len(line.split()) >= 2]

    async def monitor(self, emit: Callable[[dict], Awaitable[None]], stop: asyncio.Event) -> None:
        previous = None
        while not stop.is_set():
            try:
                current = await self.devices()
                if current != previous:
                    await emit({"event": "android.devices", "devices": current})
                    previous = current
            except (FileNotFoundError, RuntimeError, asyncio.TimeoutError) as exc:
                if previous != []:
                    await emit({"event": "android.devices", "devices": [], "error": str(exc)})
                    previous = []
            try:
                await asyncio.wait_for(stop.wait(), 3)
            except asyncio.TimeoutError:
                pass

    async def build(self, tool: str, args: list[str], emit: Callable[[dict], Awaitable[None]], project: str = ".") -> int:
        if tool not in {"gradle", "maven"} or not isinstance(args, list) or any(not isinstance(a, str) for a in args):
            raise ValueError("Invalid build command")
        self.env.local_command("java")
        self.env.runtime("java", "bin/javac")
        executable = self.env.local_command(tool)
        cwd = self.env.project_path(project)
        if not cwd.is_dir():
            raise ValueError("Project directory unavailable")
        command = shlex.join([str(executable), *args])
        # Shell command is assembled from shell quoted arguments; cwd and env are confined to the workspace.
        process = await asyncio.create_subprocess_shell(command, cwd=cwd, env=self.env.child_env(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        async def pump(stream: asyncio.StreamReader, channel: str):
            while data := await stream.readline():
                await emit({"event": "build.output", "channel": channel, "data": data.decode("utf-8", "replace")})
        try:
            await asyncio.gather(pump(process.stdout, "stdout"), pump(process.stderr, "stderr"))
            return await process.wait()
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                await process.wait()
