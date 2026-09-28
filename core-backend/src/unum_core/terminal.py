"""Async PTY owned by one WebSocket connection."""
import asyncio
import os
import sys
from collections.abc import Awaitable, Callable

from .agent import diagnose
from .env_manager import EnvironmentManager

# Detección de sistema operativo para manejar módulos exclusivos de Unix (Linux/macOS)
IS_WINDOWS = sys.platform.startswith("win")

if not IS_WINDOWS:
    import fcntl
    import pty
    import termios
    import struct
    import signal


class Terminal:
    def __init__(self, env: EnvironmentManager, emit: Callable[[dict], Awaitable[None]]):
        self.env = env
        self.emit = emit
        self.master: int | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.error_buffer = ""
        self.last_diagnosis = ""

    async def start(self, cols: int = 80, rows: int = 24) -> None:
        if self.process and self.process.returncode is None:
            return

        if IS_WINDOWS:
            # Windows uses asynchronous pipes for its built-in command shell.
            self.process = await asyncio.create_subprocess_exec(
                os.environ.get("COMSPEC", "cmd.exe"),
                cwd=self.env.workspace,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env.child_env(additions={"TERM": "xterm-256color"}),
            )
            self.master = None
        else:
            master, slave = pty.openpty()
            self.master = master
            self.resize(cols, rows)
            try:
                self.process = await asyncio.create_subprocess_exec(
                    os.environ.get("SHELL", "/bin/sh"), cwd=self.env.workspace,
                    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                    env=self.env.child_env(additions={"TERM": "xterm-256color"}),
                )
            finally:
                os.close(slave)

        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            if IS_WINDOWS:
                assert self.process and self.process.stdout and self.process.stderr
                await asyncio.gather(self._read_pipe(self.process.stdout), self._read_pipe(self.process.stderr))
                return
            while True:
                assert self.master is not None
                try:
                    data = await asyncio.to_thread(os.read, self.master, 8192)
                except OSError:
                    break
                if not data:
                    break
                await self._send_output(data)
        finally:
            await self.emit({"event": "terminal.exit"})

    async def _read_pipe(self, pipe: asyncio.StreamReader) -> None:
        while data := await pipe.read(8192):
            await self._send_output(data)

    async def _send_output(self, data: bytes) -> None:
        decoded = data.decode("utf-8", "replace")
        await self.emit({"event": "terminal.output", "data": decoded})
        self.error_buffer = (self.error_buffer + decoded)[-4000:]
        if any(marker in self.error_buffer for marker in ("ModuleNotFoundError:", "SyntaxError:", "Traceback (most recent call last):")):
            suggestions = diagnose(self.error_buffer)
            fingerprint = "|".join(suggestions)
            if fingerprint != self.last_diagnosis:
                self.last_diagnosis = fingerprint
                await self.emit({"event": "agent.suggestion", "suggestions": suggestions})

    def write(self, data: str) -> None:
        if IS_WINDOWS:
            if self.process and self.process.stdin:
                self.process.stdin.write(data.replace("\r", "\r\n").encode("utf-8"))
        else:
            if self.master is None:
                raise ValueError("Terminal is not running")
            os.write(self.master, data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        if not IS_WINDOWS and self.master is not None:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, min(rows, 300)), max(1, min(cols, 500)), 0, 0))

    async def close(self) -> None:
        if self.process and self.process.returncode is None:
            if IS_WINDOWS:
                self.process.terminate()
                await self.process.wait()
            else:
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(self.process.wait(), 2)
                except asyncio.TimeoutError:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    await self.process.wait()

        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)

        if not IS_WINDOWS and self.master is not None:
            os.close(self.master)
            self.master = None
