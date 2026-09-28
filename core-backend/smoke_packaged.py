"""Smoke test for a PyInstaller backend, including its WebSocket terminal."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

import websockets
from websockets.exceptions import InvalidStatus


async def verify(token: str, port: int) -> None:
    uri = f"ws://127.0.0.1:{port}/ws?token={token}"
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?token=wrong", origin="file://", open_timeout=10):
            raise AssertionError("Packaged backend accepted an invalid IPC token")
    except InvalidStatus as error:
        assert error.response.status_code == 403, error
    async with websockets.connect(uri, origin="file://", open_timeout=10) as socket:
        await socket.send(json.dumps({"action": "terminal.start", "msg_id": "start", "payload": {"cols": 80, "rows": 24}}))
        while True:
            message = json.loads(await asyncio.wait_for(socket.recv(), 10))
            if message.get("msg_id") == "start":
                assert message.get("ok"), message
                break
        command = "echo UNUM_PACKAGED_TERMINAL\r" if os.name == "nt" else "printf 'UNUM_%s\\n' PACKAGED_TERMINAL\n"
        await socket.send(json.dumps({"action": "terminal.input", "msg_id": "input", "payload": {"data": command}}))
        deadline = asyncio.get_running_loop().time() + 10
        while asyncio.get_running_loop().time() < deadline:
            message = json.loads(await asyncio.wait_for(socket.recv(), 10))
            if message.get("event") == "terminal.output" and "UNUM_PACKAGED_TERMINAL" in message.get("data", ""):
                return
        raise AssertionError("Packaged terminal did not echo the command")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python smoke_packaged.py /path/to/unum-backend")
    binary = Path(sys.argv[1]).resolve(strict=True)
    token = "packaging-smoke-test"
    with tempfile.TemporaryDirectory(prefix="unum-packaged-") as temporary:
        workspace = Path(temporary)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {**os.environ, "UNUM_WORKSPACE": str(workspace), "UNUM_IPC_TOKEN": token,
               "UNUM_BACKEND_PORT": str(port)}
        import subprocess

        process = subprocess.Popen([str(binary)], cwd=workspace, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(f"Backend exited early: {process.stdout.read()}")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        health = json.load(response)
                    if health.get("workspace") == str(workspace) and health.get("ok") is True:
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise TimeoutError("Packaged backend did not pass /health in 30 seconds")
            asyncio.run(verify(token, port))
            print("Packaged backend health and terminal: OK")
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()


if __name__ == "__main__":
    main()
