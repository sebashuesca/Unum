"""LSP stdio bridge using Content-Length framing, per WebSocket session."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

from jsonschema import Draft202012Validator

from .env_manager import EnvironmentManager


LANGUAGES = {"javascript", "typescript", "python", "java", "kotlin", "cpp", "sql", "json"}


class LspManager:
    def __init__(self, env: EnvironmentManager, emit: Callable[[dict], Awaitable[None]]):
        self.env, self.emit = env, emit
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.readers: dict[str, asyncio.Task] = {}

    async def start(self, language: str, command: list[str]) -> bool:
        if language not in LANGUAGES or not command or not all(isinstance(part, str) for part in command):
            raise ValueError("Invalid LSP configuration")
        if language in self.processes and self.processes[language].returncode is None:
            return False
        # First argument must be a binary installed under .unum/runtimes/lsp.
        executable = self.env.runtime("lsp", command[0])
        process = await asyncio.create_subprocess_exec(str(executable), *command[1:], cwd=self.env.workspace,
            env=self.env.child_env(), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.processes[language] = process
        self.readers[language] = asyncio.create_task(self._read(language, process))
        return True

    async def _read(self, language: str, process: asyncio.subprocess.Process) -> None:
        assert process.stdout
        try:
            while True:
                headers = {}
                while line := await process.stdout.readline():
                    if line == b"\r\n":
                        break
                    key, _, value = line.decode("ascii", "replace").partition(":")
                    headers[key.lower()] = value.strip()
                if not line:
                    break
                length = int(headers.get("content-length", "0"))
                if length <= 0 or length > 8_000_000:
                    break
                body = await process.stdout.readexactly(length)
                await self.emit({"event": "lsp.message", "language": language, "message": json.loads(body)})
        except (asyncio.IncompleteReadError, ValueError, json.JSONDecodeError):
            pass
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            if self.processes.get(language) is process:
                self.processes.pop(language, None)
                self.readers.pop(language, None)
            try:
                await self.emit({"event": "lsp.exit", "language": language})
            except Exception:
                pass

    async def send(self, language: str, message: dict) -> None:
        process = self.processes.get(language)
        if not process or process.returncode is not None or not process.stdin:
            raise ValueError("LSP server is not running")
        body = json.dumps(message, separators=(",", ":")).encode()
        process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await process.stdin.drain()

    async def close(self) -> None:
        processes = list(self.processes.values())
        readers = list(self.readers.values())
        for process in processes:
            if process.returncode is None:
                process.terminate()
        for process in processes:
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        for task in readers:
            task.cancel()
        await asyncio.gather(*readers, return_exceptions=True)


def validate_json(document: str, schema: dict) -> list[dict]:
    Draft202012Validator.check_schema(schema)
    value = json.loads(document)
    errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda e: list(map(str, e.path)))
    return [{"path": "/" + "/".join(map(str, error.path)), "message": error.message} for error in errors]
