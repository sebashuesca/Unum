"""Cloud credentials, contained Ollama runtime, model catalog and role routing."""
from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import tarfile
import tempfile
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import httpx
import zstandard

from .ai_vault import KeyVault, PROVIDERS
from .agent import Agent
from .env_manager import EnvironmentManager

Emit = Callable[[dict], Awaitable[None]]
LOCAL_URL = "http://127.0.0.1:11435"
CATALOG = [
    {"id": "hermes", "name": "Hermes", "model": "nous-hermes2:10.7b", "size_gb": 6.1, "role": "General agent", "source": "https://ollama.com/library/nous-hermes2"},
    {"id": "kimi", "name": "Kimi K2", "model": "huihui_ai/kimi-k2:1026b", "size_gb": 373, "role": "Long context · high hardware requirement", "source": "https://ollama.com/huihui_ai/kimi-k2"},
    {"id": "deepseek", "name": "DeepSeek Coder", "model": "deepseek-coder:1.3b", "size_gb": 0.8, "role": "Code & SQL", "source": "https://ollama.com/library/deepseek-coder"},
    {"id": "qwen", "name": "Qwen 2.5 Coder", "model": "qwen2.5-coder:3b", "size_gb": 1.9, "role": "Logic & code", "source": "https://ollama.com/library/qwen2.5-coder"},
    {"id": "codellama", "name": "CodeLlama", "model": "codellama:7b", "size_gb": 3.8, "role": "Code generation", "source": "https://ollama.com/library/codellama"},
]
PROVIDER_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "deepseek": "https://api.deepseek.com",
    "kimi": "https://api.moonshot.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
}
DEFAULT_ROUTES = {
    "code": {"provider": "local", "model": "deepseek-coder:1.3b"},
    "sql": {"provider": "local", "model": "nous-hermes2:10.7b"},
    "debug": {"provider": "local", "model": "qwen2.5-coder:3b"},
}
READ_TOOLS = [
    {"type": "function", "function": {"name": "read_file", "description": "Read a workspace file by relative path", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "search_text", "description": "Search text in workspace source files", "parameters": {"type": "object", "properties": {"term": {"type": "string"}}, "required": ["term"]}}},
    {"type": "function", "function": {"name": "repository_context", "description": "List workspace files and Git status", "parameters": {"type": "object", "properties": {}}}},
]


class AIHub:
    def __init__(self, env: EnvironmentManager):
        self.env = env
        self.vault = KeyVault(env.workspace)
        self.root = env.workspace / "core-backend" / "runtimes" / "ai"
        self.root.mkdir(parents=True, exist_ok=True)
        self.binary = self.root / "ollama" / "bin" / "ollama"
        self.routes_path = env.home / "ai_routes.json"
        self.process: asyncio.subprocess.Process | None = None
        self._install_lock = asyncio.Lock()
        self._pull_lock = asyncio.Lock()
        self.agent = Agent(env)

    def routes(self) -> dict:
        if not self.routes_path.is_file():
            return DEFAULT_ROUTES.copy()
        return json.loads(self.routes_path.read_text())

    def set_routes(self, routes: dict) -> dict:
        if not isinstance(routes, dict) or set(routes) != set(DEFAULT_ROUTES):
            raise ValueError("Configure code, sql and debug roles")
        for route in routes.values():
            if not isinstance(route, dict) or route.get("provider") not in {*PROVIDERS, "local"}:
                raise ValueError("Invalid route provider")
            model = route.get("model")
            if not isinstance(model, str) or not model or len(model) > 200:
                raise ValueError("Invalid model name")
        temporary = self.routes_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(routes, indent=2) + "\n")
        os.replace(temporary, self.routes_path)
        return routes

    def status(self) -> dict:
        return {"installed": self.binary.is_file(), "running": bool(self.process and self.process.returncode is None),
                "catalog": CATALOG, "routes": self.routes(), "providers": self.vault.providers()}

    async def test_key(self, provider: str, passphrase: str) -> dict:
        key = await asyncio.to_thread(self.vault.get, provider, passphrase)
        headers = self._headers(provider, key)
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(PROVIDER_URLS[provider] + "/models", headers=headers)
            response.raise_for_status()
            body = response.json()
        names = [model.get("id") for model in body.get("data", [])[:10] if isinstance(model, dict)]
        return {"ok": True, "models": names}

    @staticmethod
    def _headers(provider: str, key: str) -> dict:
        if provider == "anthropic":
            return {"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async def install_engine(self, emit: Emit) -> dict:
        async with self._install_lock:
            if self.binary.is_file():
                return {"installed": True, "path": str(self.binary)}
            if platform.system() != "Linux" or platform.machine() not in {"x86_64", "aarch64"}:
                raise ValueError("GUI installer currently supports Linux x86_64 and aarch64")
            arch = "amd64" if platform.machine() == "x86_64" else "arm64"
            url = f"https://ollama.com/download/ollama-linux-{arch}.tar.zst"
            with tempfile.TemporaryDirectory(prefix="ai-install-", dir=self.root) as temporary:
                staging = Path(temporary)
                archive = staging / "ollama.tar.zst"
                downloaded = 0
                last_time = time.monotonic()
                last_bytes = 0
                async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
                    async with client.stream("GET", url) as response:
                        response.raise_for_status()
                        total = int(response.headers.get("content-length", "0"))
                        free = shutil.disk_usage(self.root).free
                        if total and free < total * 2:
                            raise ValueError("Insufficient free disk space for engine installation")
                        with archive.open("wb") as output:
                            async for chunk in response.aiter_bytes(1024 * 1024):
                                downloaded += len(chunk)
                                if downloaded > 5_000_000_000:
                                    raise ValueError("Engine archive exceeds 5 GB limit")
                                output.write(chunk)
                                now = time.monotonic()
                                if now - last_time >= 0.25:
                                    speed = (downloaded - last_bytes) / (now - last_time) / 1024
                                    await emit({"event": "AI_DOWNLOAD_PROGRESS", "kind": "engine", "percent": round(downloaded / total * 100, 1) if total else None,
                                                "downloaded": downloaded, "total": total, "speed_kbps": round(speed, 1)})
                                    last_time, last_bytes = now, downloaded
                extracted = staging / "extracted"
                extracted.mkdir()
                await asyncio.to_thread(self._extract_archive, archive, extracted)
                binary = extracted / "bin" / "ollama"
                if not binary.is_file():
                    raise ValueError("Downloaded archive has no Ollama binary")
                binary.chmod(binary.stat().st_mode | 0o111)
                os.replace(extracted, self.root / "ollama")
            await emit({"event": "AI_DOWNLOAD_PROGRESS", "kind": "engine", "percent": 100, "speed_kbps": 0, "done": True})
            return {"installed": True, "path": str(self.binary)}

    @staticmethod
    def _extract_archive(archive: Path, destination: Path) -> None:
        extracted_bytes = 0
        with archive.open("rb") as source, zstandard.ZstdDecompressor().stream_reader(source) as reader:
            with tarfile.open(fileobj=reader, mode="r|") as tar:
                for member in tar:
                    if member.size < 0 or member.size > 20_000_000_000:
                        raise ValueError("Engine archive member exceeds size limit")
                    extracted_bytes += member.size
                    if extracted_bytes > 20_000_000_000:
                        raise ValueError("Engine archive exceeds expanded size limit")
                    target = (destination / member.name).resolve()
                    if not target.is_relative_to(destination):
                        raise ValueError("Unsafe archive path")
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        content = tar.extractfile(member)
                        if content is None:
                            raise ValueError("Corrupt archive")
                        with target.open("wb") as output:
                            shutil.copyfileobj(content, output)
                        target.chmod(member.mode & 0o755)
                    elif member.issym():
                        link_target = (target.parent / member.linkname).resolve()
                        if not link_target.is_relative_to(destination):
                            raise ValueError("Unsafe archive link")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.symlink_to(member.linkname)

    async def start_engine(self) -> dict:
        if self.process and self.process.returncode is None:
            return {"running": True}
        if not self.binary.is_file():
            raise ValueError("Install the local AI engine first")
        models = self.root / "models"
        models.mkdir(exist_ok=True)
        log = (self.root / "engine.log").open("ab")
        try:
            child_env = self.env.child_env(additions={"OLLAMA_HOST": "127.0.0.1:11435", "OLLAMA_MODELS": str(models), "OLLAMA_NO_CLOUD": "1"})
            child_env["PATH"] = str(self.binary.parent) + os.pathsep + child_env["PATH"]
            self.process = await asyncio.create_subprocess_exec(str(self.binary), "serve", cwd=self.root, env=child_env,
                stdout=log, stderr=log, start_new_session=True)
        finally:
            log.close()
        async with httpx.AsyncClient(timeout=1) as client:
            for _ in range(30):
                if self.process.returncode is not None:
                    raise RuntimeError("Local AI engine exited during startup; see runtimes/ai/engine.log")
                try:
                    response = await client.get(LOCAL_URL + "/api/version")
                    if response.is_success:
                        return {"running": True, "version": response.json().get("version")}
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        await self.stop_engine()
        raise RuntimeError("Local AI engine did not become ready")

    async def stop_engine(self) -> dict:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None
        return {"running": False}

    async def installed_models(self) -> list[str]:
        if not self.process or self.process.returncode is not None:
            return []
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(LOCAL_URL + "/api/tags")
            response.raise_for_status()
            return [item["name"] for item in response.json().get("models", [])]

    async def pull_model(self, model_id: str, emit: Emit) -> dict:
        selected = next((item for item in CATALOG if item["id"] == model_id), None)
        if not selected:
            raise ValueError("Unknown catalog model")
        if not self.process or self.process.returncode is not None:
            raise ValueError("Start the local AI engine first")
        required = int(selected["size_gb"] * 1_000_000_000 * 1.1)
        if shutil.disk_usage(self.root).free < required:
            raise ValueError(f"Insufficient free disk space; {selected['size_gb']} GB model")
        async with self._pull_lock, httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", LOCAL_URL + "/api/pull", json={"model": selected["model"], "stream": True}) as response:
                response.raise_for_status()
                last_time = time.monotonic()
                last_completed = 0
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    event = json.loads(line)
                    if event.get("error"):
                        raise RuntimeError(event["error"])
                    total, completed = event.get("total", 0), event.get("completed", 0)
                    now = time.monotonic()
                    speed = (completed - last_completed) / max(now - last_time, .001) / 1024 if completed >= last_completed else 0
                    await emit({"event": "AI_DOWNLOAD_PROGRESS", "kind": "model", "model": model_id, "status": event.get("status", ""),
                                "percent": round(completed / total * 100, 1) if total else None,
                                "downloaded": completed, "total": total, "speed_kbps": round(speed, 1)})
                    last_time, last_completed = now, completed
        await emit({"event": "AI_DOWNLOAD_PROGRESS", "kind": "model", "model": model_id, "percent": 100, "speed_kbps": 0, "done": True})
        return {"model": selected["model"], "installed": True}

    async def stream_response(self, question: str, role: str, passphrase: str = "", stderr: str = "") -> AsyncIterator[str]:
        if role not in DEFAULT_ROUTES or not question.strip() or len(question) > 30000:
            raise ValueError("Invalid AI request")
        route = self.routes()[role]
        provider, model = route["provider"], route["model"]
        prompt = "You are Unum Assistant. Suggest concrete code and SQL fixes. Do not claim to edit files."
        if stderr:
            prompt += "\nBuild errors:\n" + stderr[-8000:]
        messages = [{"role": "system", "content": prompt}, {"role": "user", "content": question}]
        if provider == "local":
            if not self.process or self.process.returncode is not None:
                raise ValueError("Start the local AI engine or select a cloud route")
            messages[0]["content"] += "\n" + await asyncio.to_thread(self.agent.context)
            async with httpx.AsyncClient(timeout=None) as client:
                for _ in range(4):
                    content_parts: list[str] = []
                    thinking_parts: list[str] = []
                    tool_calls: list[dict] = []
                    async with client.stream("POST", LOCAL_URL + "/api/chat", json={"model": model, "messages": messages, "tools": READ_TOOLS, "stream": True}) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            event = json.loads(line)
                            if event.get("error"):
                                raise RuntimeError(event["error"])
                            message = event.get("message") or {}
                            chunk = message.get("content") or ""
                            if chunk:
                                content_parts.append(chunk)
                                yield chunk
                            if message.get("thinking"):
                                thinking_parts.append(message["thinking"])
                            tool_calls.extend(message.get("tool_calls") or [])
                    if not tool_calls:
                        return
                    messages.append({"role": "assistant", "content": "".join(content_parts), "thinking": "".join(thinking_parts), "tool_calls": tool_calls[:4]})
                    for call in tool_calls[:4]:
                        function = call.get("function") or {}
                        name = function.get("name", "")
                        arguments = function.get("arguments") or {}
                        if isinstance(arguments, str):
                            try:
                                arguments = json.loads(arguments)
                            except json.JSONDecodeError:
                                arguments = {}
                        try:
                            result = await asyncio.to_thread(self.agent.tool, name, arguments)
                        except (KeyError, TypeError, ValueError, OSError) as exc:
                            result = f"Tool error: {exc}"
                        messages.append({"role": "tool", "tool_name": name, "content": result[:12000]})
                yield "\nRead-only tool limit reached. Please narrow the request."
            return
        key = await asyncio.to_thread(self.vault.get, provider, passphrase)
        headers = self._headers(provider, key)
        if provider == "anthropic":
            body = {"model": model, "max_tokens": 2048, "stream": True, "system": prompt, "messages": [{"role": "user", "content": question}]}
            url = PROVIDER_URLS[provider] + "/messages"
        else:
            body = {"model": model, "stream": True, "messages": messages}
            url = PROVIDER_URLS[provider] + "/chat/completions"
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, headers=headers, json=body) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: ") or line == "data: [DONE]":
                        continue
                    event = json.loads(line[6:])
                    if provider == "anthropic":
                        content = event.get("delta", {}).get("text") if event.get("type") == "content_block_delta" else None
                    else:
                        content = event.get("choices", [{}])[0].get("delta", {}).get("content")
                    if content:
                        yield content
