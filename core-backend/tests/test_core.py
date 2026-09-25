import asyncio
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import zstandard
import httpx
from openpyxl import Workbook
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from fastapi.testclient import TestClient

from unum_core.database import Database
from unum_core.connections import Connection, ConnectionManager
from unum_core.relational import RelationalWorkbench, json_cell, quote
from unum_core.documents import DocumentStore
from unum_core.env_manager import EnvironmentManager
from unum_core.main import app
from unum_core.migration import Migration, normal_name
from unum_core.terminal import Terminal
from unum_core.workspace import WorkspaceConfig
from unum_core.projects import ProjectTemplates
from unum_core.ai_vault import KeyVault
from unum_core.uploads import Uploads
from unum_core.ai_hub import AIHub
from unum_core.agent import Agent
import unum_core.main as main_module


class CoreIntegrationTests(unittest.TestCase):
    def test_websocket_protocol_and_json_schema(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(main_module, "workspace_config", WorkspaceConfig(Path(temporary))):
            with TestClient(app) as client, client.websocket_connect("/ws") as socket:
                socket.send_json({"action": "json.validate", "msg_id": "validate-1", "payload": {
                    "document": '{"count": "wrong"}',
                    "schema": {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"]},
                }})
                result = socket.receive_json()
                self.assertEqual(result["msg_id"], "validate-1")
                self.assertTrue(result["ok"])
                self.assertEqual(len(result["payload"]["errors"]), 1)
                socket.send_json({"action": "SETUP_WORKSPACE", "msg_id": "setup-1", "payload": {"languages": ["python"], "databases": ["sqlite"], "sdks": []}})
                self.assertTrue(socket.receive_json()["ok"])
                socket.send_json({"action": "GENERATE_ER_DIAGRAM", "msg_id": "er-1", "payload": {}})
                self.assertIn("nodes", socket.receive_json()["payload"])
                socket.send_json({"action": "AI_STATUS", "msg_id": "ai-1", "payload": {}})
                self.assertIn("catalog", socket.receive_json()["payload"])
                socket.send_json({"action": "DATABASE_CONNECTIONS", "msg_id": "db-list", "payload": {}})
                self.assertEqual(socket.receive_json()["payload"]["connections"][0]["id"], "local")

    def test_migration_paging_updates_and_documents(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary)
                (workspace / "people.csv").write_text("Name,Age\nAda,37\nLin,42\n")
                env = EnvironmentManager(workspace)
                db = Database(workspace)
                migration = Migration(env, db)
                preview = await migration.preview("people.csv")
                self.assertIn('"age" INTEGER', preview["ddl"])
                imported = await migration.import_file("people.csv")
                self.assertEqual(imported["inserted"], 2)
                book = Workbook()
                book.active.append(["Order ID", "Amount"])
                book.active.append([1, 2.5])
                book.active.append([2, 3.75])
                book.save(workspace / "orders.xlsx")
                self.assertIn('"amount" REAL', (await migration.preview("orders.xlsx"))["ddl"])
                self.assertEqual((await migration.import_file("orders.xlsx"))["inserted"], 2)
                page = await db.page("people")
                self.assertEqual(page["total"], 2)
                await db.create_table("teams", [{"name": "id", "type": "INTEGER", "primary_key": True}, {"name": "label", "type": "TEXT"}])
                await db.create_table("members", [{"name": "team_id", "type": "INTEGER", "references_table": "teams", "references_column": "id"}])
                diagram = await db.er_diagram()
                self.assertTrue(any(edge["to"] == "teams" for edge in diagram["edges"]))
                await db.update_cell("people", page["rows"][0][0], "age", 38)
                self.assertEqual((await db.page("people"))["rows"][0][2], 38)
                documents = DocumentStore(workspace)
                doc_id = await documents.put("notes", {"text": "hello"})
                self.assertEqual((await documents.list("notes"))["documents"][0]["id"], doc_id)
                await db.close()
        asyncio.run(scenario())

    def test_session_database_manager_local_and_validation(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                database = Database(Path(temporary))
                manager = ConnectionManager(database)
                await manager.query("local", "CREATE TABLE sample (id INTEGER)")
                await manager.query("local", "INSERT INTO sample (id) VALUES (7)")
                self.assertEqual((await manager.query("local", "SELECT id FROM sample"))["rows"], [[7]])
                self.assertEqual((await manager.objects("local"))["tables"][0]["name"], "sample")
                with self.assertRaises(ValueError):
                    await manager.connect({"kind": "postgresql", "host": "bad host"})
                with self.assertRaises(ValueError):
                    await manager.query("missing", "SELECT 1")
                await manager.close()
                await database.close()
        asyncio.run(scenario())

    def test_external_relational_design_grid_and_import(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                local = Database(root)
                engine = create_async_engine(f"sqlite+aiosqlite:///{root / 'remote-test.sqlite3'}")
                manager = ConnectionManager(local)
                manager.connections["external"] = Connection("external", "postgresql", "test PostgreSQL", "test", engine)
                manager.relational["external"] = RelationalWorkbench(engine, "postgresql")
                await manager.create_table("external", "teams", [
                    {"name": "id", "type": "INTEGER", "primary_key": True},
                    {"name": "name", "type": "TEXT", "required": True},
                ], [{"name": "teams_name_idx", "columns": ["name"], "unique": True}])
                await manager.create_table("external", "members", [
                    {"name": "id", "type": "INTEGER", "primary_key": True},
                    {"name": "team_id", "type": "INTEGER", "references_table": "teams", "references_column": "id"},
                ])
                await manager.query("external", "INSERT INTO teams (id, name) VALUES (1, 'Alpha')")
                page = await manager.page("external", "teams")
                self.assertEqual(page["row_keys"], [{"id": 1}])
                self.assertEqual(page["editable_columns"], ["name"])
                await manager.update_cell("external", "teams", "name", "Beta", key={"id": 1})
                self.assertEqual((await manager.page("external", "teams"))["rows"][0], [1, "Beta"])
                await manager.create_table("external", "translations", [
                    {"name": "item_id", "type": "INTEGER", "primary_key": True},
                    {"name": "locale", "type": "TEXT", "primary_key": True},
                    {"name": "label", "type": "TEXT"},
                ])
                await manager.query("external", "INSERT INTO translations VALUES (1, 'es', 'Hola')")
                translated = await manager.page("external", "translations")
                self.assertEqual(translated["row_keys"], [{"item_id": 1, "locale": "es"}])
                await manager.update_cell("external", "translations", "label", "Saludos", key=translated["row_keys"][0])
                self.assertEqual((await manager.page("external", "translations"))["rows"][0][-1], "Saludos")
                await manager.create_table("external", "read_only", [{"name": "body", "type": "TEXT"}])
                self.assertEqual((await manager.page("external", "read_only"))["editable_columns"], [])
                with self.assertRaises(ValueError):
                    await manager.update_cell("external", "read_only", "body", "Blocked", key={})
                members = next(item for item in (await manager.objects("external"))["tables"] if item["name"] == "members")
                self.assertEqual(members["foreign_keys"][0]["references_table"], "teams")
                (root / "metrics.csv").write_text("Id,Value\n1,2.5\n2,3.5\n")
                migration = Migration(EnvironmentManager(root), local)
                preview = await migration.preview("metrics.csv", dialect="postgresql")
                self.assertIn("DOUBLE PRECISION", preview["ddl"])
                progress_events = []
                async def track_progress(event):
                    progress_events.append(event)
                imported = await migration.import_file("metrics.csv", engine=engine, dialect="postgresql", progress=track_progress)
                self.assertEqual(imported["inserted"], 2)
                self.assertEqual(progress_events[-1]["event"], "IMPORT_PROGRESS")
                self.assertEqual(progress_events[-1]["percent"], 100)
                self.assertEqual((await manager.page("external", "metrics"))["total"], 2)
                self.assertEqual(json_cell(b"abc"), "0x616263")
                self.assertEqual(quote("my`table", "mysql"), "`my``table`")
                mysql_engine = create_async_engine(f"sqlite+aiosqlite:///{root / 'mysql-test.sqlite3'}")
                mysql_workbench = RelationalWorkbench(mysql_engine, "mysql")
                await mysql_workbench.create_table("line items", [
                    {"name": "line id", "type": "INTEGER", "primary_key": True},
                    {"name": "description", "type": "TEXT"},
                ])
                async with mysql_engine.begin() as connection:
                    await connection.execute(text("INSERT INTO `line items` (`line id`, description) VALUES (1, 'one')"))
                await mysql_workbench.update_cell("line items", {"line id": 1}, "description", "two")
                self.assertEqual((await mysql_workbench.page("line items"))["rows"], [[1, "two"]])
                self.assertIn("`metrics`", (await migration.preview("metrics.csv", dialect="mysql"))["ddl"])
                await mysql_engine.dispose()
                await manager.close()
                await local.close()
        asyncio.run(scenario())

    def test_redis_tree_and_type_aware_inspection(self):
        class RedisStub:
            async def scan(self, **_kwargs):
                return 0, ["profile"]
            async def type(self, _key):
                return "hash"
            async def hscan(self, _key, **_kwargs):
                return 0, {"name": "Ada"}
            async def aclose(self):
                return None
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                local = Database(Path(temporary))
                manager = ConnectionManager(local)
                manager.connections["redis-test"] = Connection("redis-test", "redis", "Redis", "0", RedisStub())
                self.assertEqual((await manager.objects("redis-test"))["tables"][0]["name"], "profile")
                self.assertEqual((await manager.document("redis-test", "inspect", {"key": "profile"}))["value"], {"name": "Ada"})
                await manager.close()
                await local.close()
        asyncio.run(scenario())

    def test_workspace_templates_vault_and_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "example.py").write_text("print('hello')\n")
            agent = Agent(EnvironmentManager(root))
            self.assertIn("print('hello')", agent.tool("read_file", {"path": "example.py"}))
            self.assertIn("example.py:1", agent.tool("search_text", {"term": "hello"}))
            with self.assertRaises(ValueError):
                agent.tool("read_file", {"path": "../outside.py"})
            with self.assertRaises(ValueError):
                agent.tool("read_file", {"path": ".unum/ai_keys.enc"})
            config = WorkspaceConfig(root)
            self.assertEqual(normal_name("Año Fiscal"), "ano_fiscal")
            saved = config.save({"languages": ["python", "sql"], "databases": ["sqlite"], "sdks": []})
            self.assertEqual(config.load(), saved)
            project = ProjectTemplates(EnvironmentManager(root)).create("java", "demo")
            self.assertTrue((root / project["path"] / "pom.xml").is_file())
            vault = KeyVault(root)
            vault.save("openai", "test-secret", "correct-horse")
            self.assertEqual(vault.get("openai", "correct-horse"), "test-secret")
            self.assertNotIn("test-secret", vault.path.read_text())
            with self.assertRaises(ValueError):
                vault.get("openai", "wrong-passphrase")
            uploads = Uploads(root)
            upload_id = uploads.begin("example.csv", 4)["upload_id"]
            uploads.chunk(upload_id, "YSxiCg==")
            self.assertTrue((root / uploads.finish(upload_id)["path"]).is_file())
            uploads.close()

    def test_terminal_pty_output(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                received = []
                async def emit(event):
                    received.append(event)
                terminal = Terminal(EnvironmentManager(Path(temporary)), emit)
                await terminal.start(80, 24)
                terminal.write("printf 'unum-pty-ok\\n'\n")
                async def wait_output():
                    while not any("unum-pty-ok" in event.get("data", "") for event in received):
                        await asyncio.sleep(0.01)
                await asyncio.wait_for(wait_output(), 3)
                await terminal.close()
        asyncio.run(scenario())

    def test_ai_archive_extraction_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "test.tar.zst"
            memory = io.BytesIO()
            with tarfile.open(fileobj=memory, mode="w") as tar:
                info = tarfile.TarInfo("../escape")
                info.size = 4
                tar.addfile(info, io.BytesIO(b"evil"))
            archive.write_bytes(zstandard.ZstdCompressor().compress(memory.getvalue()))
            destination = root / "out"
            destination.mkdir()
            with self.assertRaises(ValueError):
                AIHub._extract_archive(archive, destination)

    def test_ai_hub_local_read_tool_and_stream(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "answer.py").write_text("answer = 42\n")
                hub = AIHub(EnvironmentManager(root))
                hub.process = type("Process", (), {"returncode": None})()
                requests = []
                def handler(request):
                    body = json.loads(request.content)
                    requests.append(body)
                    if len(requests) == 1:
                        result = {"message": {"tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "answer.py"}}}]}, "done": True}
                        return httpx.Response(200, text=json.dumps(result) + "\n")
                    return httpx.Response(200, text='{"message":{"content":"Found 42."}}\n{"done":true}\n')
                original = httpx.AsyncClient
                with patch("unum_core.ai_hub.httpx.AsyncClient", side_effect=lambda **kwargs: original(transport=httpx.MockTransport(handler))):
                    chunks = [chunk async for chunk in hub.stream_response("Read answer.py", "code")]
                self.assertEqual(chunks, ["Found 42."])
                self.assertIn("answer = 42", requests[1]["messages"][-1]["content"])
        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
