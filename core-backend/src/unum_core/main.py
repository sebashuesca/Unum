"""Unum IDE local WebSocket API: {action,msg_id,payload} -> result/events."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import git

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .agent import Agent, diagnose
from .ai_hub import AIHub
from .android_orchestrator import AndroidOrchestrator
from .database import Database
from .connections import ConnectionManager
from .documents import DocumentStore
from .env_manager import EnvironmentManager
from .files import Files
from .lsp_manager import LspManager, validate_json
from .migration import Migration
from .projects import ProjectTemplates
from .runner import SourceRunner
from .terminal import Terminal
from .uploads import Uploads
from .workspace import WorkspaceConfig


WORKSPACE = Path(os.environ.get("UNUM_WORKSPACE", Path.cwd())).resolve()
env = EnvironmentManager(WORKSPACE)
files = Files(env)
db = Database(WORKSPACE)
documents = DocumentStore(WORKSPACE)
migration = Migration(env, db)
android = AndroidOrchestrator(env)
agent = Agent(env)
ai = AIHub(env)
workspace_config = WorkspaceConfig(WORKSPACE)
projects = ProjectTemplates(env)
runner = SourceRunner(env)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await ai.stop_engine()
    await db.close()


app = FastAPI(title="Unum Core", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "workspace": str(WORKSPACE)}


@app.websocket("/ws")
async def websocket(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin", "")
    if origin and not (origin == "null" or origin.startswith(("http://127.0.0.1:", "http://localhost:"))):
        await websocket.close(code=1008)
        return
    token = os.environ.get("UNUM_IPC_TOKEN")
    if token and websocket.query_params.get("token") != token:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    send_lock = asyncio.Lock()

    async def emit(message: dict) -> None:
        async with send_lock:
            await websocket.send_json(message)

    terminal = Terminal(env, emit)
    connections = ConnectionManager(db)
    uploads = Uploads(WORKSPACE)
    lsp = LspManager(env, emit)
    monitor_stop = asyncio.Event()
    monitor_task: asyncio.Task | None = None
    jobs: set[asyncio.Task] = set()

    async def run_job(coro):
        task = asyncio.create_task(coro)
        jobs.add(task)
        task.add_done_callback(jobs.discard)

    async def handle(action: str, payload: dict, msg_id: str | int | None):
        nonlocal monitor_task
        if action == "EXECUTE_TERMINAL":
            action = "terminal." + str(payload.get("operation", "start"))
        if action == "QUERY_DATABASE":
            action = "db.query"
        if action == "IMPORT_EXCEL_CSV":
            action = "migration." + str(payload.get("operation", "preview"))
        if action == "ORCHESTRATE_SDK":
            action = "android." + str(payload.get("operation", "devices"))
        if action == "GET_WORKSPACE":
            return {"configuration": workspace_config.load()}
        if action == "SETUP_WORKSPACE":
            return {"configuration": workspace_config.save(payload)}
        if action == "RUNTIME_STATUS":
            return {"runtimes": env.runtime_status()}
        if action == "GIT_STATUS":
            try:
                repo = git.Repo(WORKSPACE, search_parent_directories=False)
                branch = repo.active_branch.name if not repo.head.is_detached else repo.head.commit.hexsha[:7]
                return {"branch": branch, "dirty": repo.is_dirty(untracked_files=True)}
            except (git.InvalidGitRepositoryError, git.NoSuchPathError, ValueError, TypeError):
                return {"branch": None, "dirty": False}
        if action == "CREATE_PROJECT":
            return projects.create(payload["template"], payload["name"], payload.get("package", "dev.unum.app"))
        if action == "RUN_FILE":
            async def run_file_job():
                stderr = []
                try:
                    async def run_emit(message):
                        if message.get("channel") == "stderr":
                            stderr.append(message["data"])
                        await emit({**message, "msg_id": msg_id})
                    code = await runner.run(payload["path"], run_emit)
                    await emit({"event": "run.exit", "msg_id": msg_id, "code": code,
                                "suggestions": diagnose("".join(stderr)) if code else []})
                except Exception as exc:
                    await emit({"event": "run.exit", "msg_id": msg_id, "code": -1, "suggestions": [str(exc)]})
            await run_job(run_file_job())
            return {"started": True}
        if action == "UPLOAD_FILE":
            operation = payload.get("operation")
            if operation == "begin":
                return uploads.begin(payload["filename"], payload["size"])
            if operation == "chunk":
                return uploads.chunk(payload["upload_id"], payload["data"])
            if operation == "finish":
                return uploads.finish(payload["upload_id"])
            raise ValueError("Invalid upload operation")
        if action == "files.tree":
            return {"entries": files.tree(payload.get("path", "."))}
        if action == "files.read":
            return {"content": files.read(payload["path"]), "uri": env.project_path(payload["path"]).as_uri()}
        if action == "files.write":
            files.write(payload["path"], payload["content"])
            return {"saved": True}
        if action == "files.create":
            files.create(payload["path"])
            return {"created": True}
        if action == "env.create":
            return {"path": str(await env.create_venv(payload["name"]))}
        if action == "terminal.start":
            await terminal.start(payload.get("cols", 80), payload.get("rows", 24))
            return {"started": True}
        if action == "terminal.input":
            terminal.write(payload["data"])
            return {}
        if action == "terminal.resize":
            terminal.resize(payload["cols"], payload["rows"])
            return {}
        if action == "db.query":
            return await connections.query(payload.get("connection_id", "local"), payload["sql"], payload.get("parameters"), payload.get("limit", 1000))
        if action == "DATABASE_CONNECTIONS":
            return {"connections": connections.list()}
        if action == "DATABASE_CONNECT":
            return await connections.connect(payload)
        if action == "DATABASE_DISCONNECT":
            await connections.disconnect(payload["connection_id"])
            return {"disconnected": True}
        if action == "DATABASE_DOCUMENT":
            return await connections.document(payload["connection_id"], payload["operation"], payload)
        if action == "db.schema":
            return {"tables": await db.schema()}
        if action == "db.objects":
            return await connections.objects(payload.get("connection_id", "local"))
        if action == "db.create_table":
            return await connections.create_table(payload.get("connection_id", "local"), payload["name"], payload["columns"], payload.get("indexes"))
        if action == "GENERATE_ER_DIAGRAM":
            return await db.er_diagram()
        if action == "db.page":
            return await connections.page(payload.get("connection_id", "local"), payload["table"], payload.get("offset", 0), payload.get("limit", 100))
        if action == "db.update":
            await connections.update_cell(payload.get("connection_id", "local"), payload["table"], payload["column"], payload.get("value"), rowid=payload.get("rowid"), key=payload.get("key"))
            return {"saved": True}
        if action == "docs.collections":
            return {"collections": await documents.collections()}
        if action == "docs.list":
            return await documents.list(payload["collection"], payload.get("offset", 0), payload.get("limit", 100))
        if action == "docs.put":
            return {"id": await documents.put(payload["collection"], payload["value"], payload.get("id"))}
        if action == "docs.delete":
            await documents.delete(payload["collection"], payload["id"])
            return {"deleted": True}
        if action == "migration.preview":
            target = connections.get(payload.get("connection_id", "local"))
            if target and target.kind not in {"postgresql", "mysql"}:
                raise ValueError("Import requires SQLite, PostgreSQL or MySQL")
            return await migration.preview(payload["path"], payload.get("table"), target.kind if target else "sqlite")
        if action == "migration.import":
            target = connections.get(payload.get("connection_id", "local"))
            if target and target.kind not in {"postgresql", "mysql"}:
                raise ValueError("Import requires SQLite, PostgreSQL or MySQL")
            async def import_progress(event: dict) -> None:
                await emit({**event, "msg_id": msg_id})
            result = await migration.import_file(payload["path"], payload.get("table"), target.client if target else None, target.kind if target else "sqlite", import_progress)
            if target:
                connections.relational[target.id].tables.pop(result["table"], None)
            return result
        if action == "android.devices":
            return {"devices": await android.devices()}
        if action == "android.monitor":
            if monitor_task is None:
                monitor_task = asyncio.create_task(android.monitor(emit, monitor_stop))
            return {"monitoring": True}
        if action == "android.build":
            async def build_job():
                try:
                    stderr = []
                    async def build_emit(message):
                        if message.get("channel") == "stderr":
                            stderr.append(message["data"])
                        await emit({**message, "msg_id": msg_id})
                    code = await android.build(payload["tool"], payload.get("args", []), build_emit, payload.get("project", "."))
                    await emit({"event": "build.exit", "msg_id": msg_id, "code": code,
                                "suggestions": diagnose("".join(stderr)) if code else []})
                except Exception as exc:
                    await emit({"event": "build.exit", "msg_id": msg_id, "code": -1, "suggestions": [str(exc)]})
            await run_job(build_job())
            return {"started": True}
        if action == "json.validate":
            return {"errors": validate_json(payload["document"], payload["schema"])}
        if action == "lsp.start":
            return {"started": True, "created": await lsp.start(payload["language"], payload["command"])}
        if action == "lsp.message":
            await lsp.send(payload["language"], payload["message"])
            return {}
        if action == "agent.context":
            return {"context": agent.context()}
        if action == "agent.read":
            return {"content": agent.read_file(payload["path"])}
        if action == "agent.diagnose":
            return {"suggestions": diagnose(payload["stderr"])}
        if action == "agent.chat":
            async def chat_job():
                try:
                    async for chunk in agent.stream(payload["question"], payload.get("stderr", "")):
                        await emit({"event": "agent.chunk", "msg_id": msg_id, "chunk": chunk})
                    await emit({"event": "agent.done", "msg_id": msg_id})
                except Exception as exc:
                    await emit({"event": "agent.error", "msg_id": msg_id, "error": str(exc)})
            await run_job(chat_job())
            return {"started": True}
        if action == "AI_STATUS":
            return {**ai.status(), "installed_models": await ai.installed_models()}
        if action == "AI_SAVE_KEYS":
            return {"providers": await asyncio.to_thread(ai.vault.save, payload["provider"], payload["api_key"], payload["passphrase"])}
        if action == "AI_TEST_KEY":
            return await ai.test_key(payload["provider"], payload["passphrase"])
        if action == "AI_SET_ROUTES":
            return {"routes": ai.set_routes(payload["routes"])}
        if action == "AI_START_ENGINE":
            return await ai.start_engine()
        if action == "AI_STOP_ENGINE":
            return await ai.stop_engine()
        if action == "AI_INSTALL_LOCAL_ENGINE":
            async def install_job():
                try:
                    result = await ai.install_engine(lambda event: emit({**event, "msg_id": msg_id}))
                    await emit({"event": "AI_JOB_DONE", "msg_id": msg_id, "result": result})
                except Exception as exc:
                    await emit({"event": "AI_JOB_ERROR", "msg_id": msg_id, "error": str(exc)})
            await run_job(install_job())
            return {"started": True}
        if action == "AI_PULL_MODEL":
            async def pull_job():
                try:
                    result = await ai.pull_model(payload["model_id"], lambda event: emit({**event, "msg_id": msg_id}))
                    await emit({"event": "AI_JOB_DONE", "msg_id": msg_id, "result": result})
                except Exception as exc:
                    await emit({"event": "AI_JOB_ERROR", "msg_id": msg_id, "error": str(exc)})
            await run_job(pull_job())
            return {"started": True}
        if action == "STREAM_AI_RESPONSE":
            async def stream_job():
                try:
                    async for chunk in ai.stream_response(payload["question"], payload.get("role", "code"), payload.get("passphrase", ""), payload.get("stderr", "")):
                        await emit({"event": "AI_RESPONSE_CHUNK", "msg_id": msg_id, "chunk": chunk})
                    await emit({"event": "AI_RESPONSE_DONE", "msg_id": msg_id})
                except Exception as exc:
                    await emit({"event": "AI_RESPONSE_ERROR", "msg_id": msg_id, "error": str(exc)})
            await run_job(stream_job())
            return {"started": True}
        raise ValueError(f"Unknown action: {action}")

    try:
        while True:
            message = await websocket.receive_json()
            msg_id = message.get("msg_id") if isinstance(message, dict) else None
            try:
                if not isinstance(message, dict) or not isinstance(message.get("action"), str) or not isinstance(message.get("payload", {}), dict):
                    raise ValueError("Expected {action, msg_id, payload}")
                result = await handle(message["action"], message.get("payload", {}), msg_id)
                await emit({"msg_id": msg_id, "ok": True, "payload": result})
            except Exception as exc:
                await emit({"msg_id": msg_id, "ok": False, "error": str(exc)})
    except WebSocketDisconnect:
        pass
    finally:
        monitor_stop.set()
        if monitor_task:
            monitor_task.cancel()
        for job in jobs:
            job.cancel()
        await asyncio.gather(*(list(jobs) + ([monitor_task] if monitor_task else [])), return_exceptions=True)
        await terminal.close()
        await lsp.close()
        await connections.close()
        uploads.close()


def run() -> None:
    import uvicorn
    uvicorn.run("unum_core.main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    run()
