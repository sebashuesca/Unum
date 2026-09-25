"""Read-only workspace context and optional local OpenAI-compatible streaming model."""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

import git
import httpx

from .env_manager import EnvironmentManager

IGNORED_DIRS = {".git", ".unum", "node_modules", ".venv", "dist", "dist-electron", "runtimes", "build", "__pycache__"}


def source_files(root: Path):
    for base, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name not in IGNORED_DIRS and not name.startswith(".") and not (Path(base) / name).is_symlink()]
        for name in names:
            path = Path(base) / name
            if not name.startswith(".") and not path.is_symlink():
                yield path


def diagnose(stderr: str) -> list[str]:
    rules = [
        (r"ModuleNotFoundError: No module named ['\"]?([^'\"\s]+)", "Missing Python module {0}. Install it into the project venv."),
        (r"SyntaxError: (.+)", "Python syntax error: {0}. Check the reported line and nearby brackets."),
        (r"Could not find or load main class (.+)", "Java class {0} was not found. Check the classpath and package name."),
        (r"Could not resolve (?:all files|dependency) (.+)", "Gradle could not resolve {0}. Check local dependencies and repository configuration."),
        (r"error: (.+)", "Compiler error: {0}"),
    ]
    suggestions = []
    for pattern, template in rules:
        match = re.search(pattern, stderr)
        if match:
            suggestions.append(template.format(match.group(1).strip()))
    return suggestions[:5] or (["Inspect the first error and its stack trace; subsequent failures may be consequences."] if stderr.strip() else [])


class Agent:
    def __init__(self, env: EnvironmentManager):
        self.env = env
        self.endpoint = os.environ.get("UNUM_MODEL_URL", "")
        self.model = os.environ.get("UNUM_MODEL", "")

    def context(self) -> str:
        paths = []
        for path in source_files(self.env.workspace):
            if len(paths) >= 80:
                break
            if path.is_file():
                paths.append(str(path.relative_to(self.env.workspace)))
        try:
            repo = git.Repo(self.env.workspace, search_parent_directories=False)
            git_info = f"Git branch: {repo.active_branch.name}; status: {repo.git.status('--short')[:2000]}"
        except (git.InvalidGitRepositoryError, TypeError, ValueError):
            git_info = "No Git repository"
        return git_info + "\nFiles:\n" + "\n".join(paths)

    def read_file(self, raw: str) -> str:
        if any(part.startswith(".") or part in IGNORED_DIRS for part in Path(raw).parts):
            raise ValueError("File is outside readable project sources")
        path = self.env.project_path(raw)
        if not path.is_file() or path.stat().st_size > 100_000:
            raise ValueError("File unavailable or too large")
        return path.read_text(encoding="utf-8")

    def tool(self, name: str, arguments: dict) -> str:
        if name == "read_file":
            return self.read_file(arguments["path"])
        if name == "search_text":
            term = str(arguments["term"])
            if not term or len(term) > 200:
                raise ValueError("Invalid search term")
            hits = []
            for path in source_files(self.env.workspace):
                if len(hits) >= 50:
                    break
                if not path.is_file() or path.stat().st_size > 100_000:
                    continue
                try:
                    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                        if term.lower() in line.lower():
                            hits.append(f"{path.relative_to(self.env.workspace)}:{number}: {line[:200]}")
                            if len(hits) >= 50:
                                break
                except (UnicodeError, OSError):
                    continue
            return "\n".join(hits) or "No matches"
        if name == "repository_context":
            return self.context()
        raise ValueError("Unsupported tool")

    async def stream(self, question: str, stderr: str = "") -> AsyncIterator[str]:
        if not self.endpoint or not self.model:
            answer = "Local model is not configured. Set UNUM_MODEL_URL and UNUM_MODEL in the backend environment."
            if stderr:
                answer += "\n\n" + "\n".join(diagnose(stderr))
            for part in answer.split(" "):
                yield part + " "
                await asyncio.sleep(0)
            return
        if not self.endpoint.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("Model endpoint must be local")
        prompt = "You are a read-only coding assistant. Suggest changes; do not claim to edit files.\n" + self.context()
        if stderr:
            prompt += "\nBuild stderr:\n" + stderr[-8000:]
        url = self.endpoint.rstrip("/") + "/chat/completions"
        messages: list[dict] = [{"role": "system", "content": prompt}, {"role": "user", "content": question}]
        tools = [
            {"type": "function", "function": {"name": "read_file", "description": "Read a workspace file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
            {"type": "function", "function": {"name": "search_text", "description": "Search source text in workspace files", "parameters": {"type": "object", "properties": {"term": {"type": "string"}}, "required": ["term"]}}},
            {"type": "function", "function": {"name": "repository_context", "description": "Read the repository file list and Git status", "parameters": {"type": "object", "properties": {}}}},
        ]
        async with httpx.AsyncClient(timeout=60) as client:
            for _ in range(3):
                response = await client.post(url, json={"model": self.model, "stream": False, "messages": messages, "tools": tools, "tool_choice": "auto"})
                if response.status_code in {400, 422}:
                    break  # Local model does not implement tool calls; use plain streaming below.
                response.raise_for_status()
                assistant = response.json()["choices"][0]["message"]
                calls = assistant.get("tool_calls") or []
                if not calls:
                    content = assistant.get("content") or ""
                    for start in range(0, len(content), 80):
                        yield content[start:start + 80]
                    return
                messages.append(assistant)
                for call in calls:
                    try:
                        value = self.tool(call["function"]["name"], json.loads(call["function"].get("arguments") or "{}"))
                    except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
                        value = f"Tool error: {exc}"
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": value[:12000]})
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json={"model": self.model, "stream": True, "messages": messages}) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        chunk = json.loads(line[6:])
                        content = chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                        if content:
                            yield content
