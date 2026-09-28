"""Local Android/Java tools; device polling and streamed build output."""
from __future__ import annotations

import asyncio
import base64
import os
import re
from collections.abc import Awaitable, Callable

from .env_manager import EnvironmentManager, process_group_options, stop_process


class AndroidOrchestrator:
    def __init__(self, env: EnvironmentManager):
        self.env = env
        self.emulator: asyncio.subprocess.Process | None = None

    def status(self) -> dict:
        runtimes = self.env.runtime_status()
        return {"android_home": str(self.env.home / "runtimes" / "android") if runtimes["android"] else None,
                "java_home": str(self.env.home / "runtimes" / "java") if runtimes["java"] else None,
                "runtimes": runtimes}

    async def avds(self) -> list[str]:
        executable = self.env.local_command("emulator")
        process = await asyncio.create_subprocess_exec(str(executable), "-list-avds", cwd=self.env.workspace,
            env=self.env.child_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(process.communicate(), 10)
        if process.returncode:
            raise RuntimeError(error.decode("utf-8", "replace"))
        return [line.strip() for line in output.decode("utf-8", "replace").splitlines() if line.strip()]

    async def start_emulator(self, avd: str) -> dict:
        if not re.fullmatch(r"[\w.\-]{1,100}", avd) or avd not in await self.avds():
            raise ValueError("Unknown local AVD")
        if self.emulator and self.emulator.returncode is None:
            return {"started": True, "avd": avd}
        executable = self.env.local_command("emulator")
        self.emulator = await asyncio.create_subprocess_exec(str(executable), "-avd", avd, "-no-window", "-no-audio",
            cwd=self.env.workspace, env=self.env.child_env(), stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, **process_group_options())
        return {"started": True, "avd": avd}

    async def screen(self, serial: str) -> dict:
        if not re.fullmatch(r"[\w.\-:]{1,100}", serial):
            raise ValueError("Invalid device serial")
        process = await asyncio.create_subprocess_exec(str(self.env.local_command("adb")), "-s", serial,
            "exec-out", "screencap", "-p", env=self.env.child_env(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(process.communicate(), 8)
        if process.returncode or not output.startswith(b"\x89PNG") or len(output) > 8_000_000:
            raise RuntimeError(error.decode("utf-8", "replace") or "Screen capture unavailable")
        return {"png": base64.b64encode(output).decode("ascii")}

    async def tap(self, serial: str, x: int, y: int) -> None:
        if not re.fullmatch(r"[\w.\-:]{1,100}", serial) or not all(isinstance(v, int) and 0 <= v <= 10000 for v in (x, y)):
            raise ValueError("Invalid tap")
        process = await asyncio.create_subprocess_exec(str(self.env.local_command("adb")), "-s", serial,
            "shell", "input", "tap", str(x), str(y), env=self.env.child_env())
        await asyncio.wait_for(process.wait(), 8)

    async def close(self) -> None:
        if self.emulator and self.emulator.returncode is None:
            self.emulator.terminate()
            try:
                await asyncio.wait_for(self.emulator.wait(), 5)
            except asyncio.TimeoutError:
                self.emulator.kill()
                await self.emulator.wait()

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
        if tool not in {"gradle", "maven", "apk"} or not isinstance(args, list) or any(not isinstance(a, str) for a in args):
            raise ValueError("Invalid build command")
        self.env.local_command("java")
        self.env.runtime("java", "bin/javac.exe" if os.name == "nt" else "bin/javac")
        cwd = self.env.project_path(project)
        if not cwd.is_dir():
            raise ValueError("Project directory unavailable")
        if tool == "apk":
            args = ["assembleRelease" if args and args[0] == "release" else "assembleDebug"]
            wrapper = cwd / ("gradlew.bat" if os.name == "nt" else "gradlew")
            if wrapper.is_file() and not wrapper.is_symlink():
                executable = wrapper
            else:
                executable = self.env.local_command("gradle")
        else:
            executable = self.env.local_command(tool)
        process = await asyncio.create_subprocess_exec(str(executable), *args, cwd=cwd, env=self.env.child_env(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **process_group_options())
        async def pump(stream: asyncio.StreamReader, channel: str):
            while data := await stream.readline():
                await emit({"event": "build.output", "channel": channel, "data": data.decode("utf-8", "replace")})
        try:
            await asyncio.gather(pump(process.stdout, "stdout"), pump(process.stderr, "stderr"))
            return await process.wait()
        finally:
            if process.returncode is None:
                await stop_process(process)

    def apk_artifacts(self, project: str) -> list[str]:
        root = self.env.project_path(project)
        return [str(path.relative_to(self.env.workspace)) for path in root.glob("**/build/outputs/apk/**/*.apk") if path.is_file() and path.resolve().is_relative_to(self.env.workspace)][:20]
