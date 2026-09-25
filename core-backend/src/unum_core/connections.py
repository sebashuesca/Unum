"""Session-scoped database connections; no server or client executable is installed globally."""
from __future__ import annotations

import asyncio
import json
from itertools import islice
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import create_async_engine

from .database import Database
from .relational import RelationalWorkbench, json_cell, safe_name

KINDS = {"postgresql", "mysql", "mongodb", "redis", "cassandra"}
DEFAULT_PORTS = {"postgresql": 5432, "mysql": 3306, "mongodb": 27017, "redis": 6379, "cassandra": 9042}


@dataclass
class Connection:
    id: str
    kind: str
    label: str
    database: str
    client: object


class ConnectionManager:
    def __init__(self, local: Database):
        self.local = local
        self.connections: dict[str, Connection] = {}
        self.relational: dict[str, RelationalWorkbench] = {}

    def list(self) -> list[dict]:
        return [{"id": "local", "kind": "sqlite", "label": "SQLite · local", "database": "data.sqlite3"}] + [
            {"id": item.id, "kind": item.kind, "label": item.label, "database": item.database}
            for item in self.connections.values()
        ]

    async def connect(self, payload: dict) -> dict:
        kind = payload.get("kind")
        if kind not in KINDS:
            raise ValueError("Unsupported database type")
        host = str(payload.get("host", "127.0.0.1"))
        if not re.fullmatch(r"[A-Za-z0-9.:-]{1,255}", host):
            raise ValueError("Invalid host")
        port = int(payload.get("port") or DEFAULT_PORTS[kind])
        if not 1 <= port <= 65535:
            raise ValueError("Invalid port")
        database = str(payload.get("database") or ("0" if kind == "redis" else ""))
        if len(database) > 128 or not database:
            raise ValueError("Enter a database or keyspace name")
        if kind == "redis" and (not database.isdigit() or int(database) > 1024):
            raise ValueError("Redis database must be a number from 0 to 1024")
        label = str(payload.get("label") or f"{kind} · {host}:{port}")[:100]
        username = str(payload.get("username") or "")
        password = str(payload.get("password") or "")
        client: object
        if kind in {"postgresql", "mysql"}:
            driver = "postgresql+asyncpg" if kind == "postgresql" else "mysql+asyncmy"
            url = URL.create(driver, username=username or None, password=password or None, host=host, port=port, database=database)
            engine = create_async_engine(url, pool_pre_ping=True, pool_size=2, max_overflow=0, connect_args={"timeout": 8} if kind == "postgresql" else {"connect_timeout": 8})
            try:
                async with engine.connect() as connection:
                    await connection.execute(text("SELECT 1"))
            except Exception:
                await engine.dispose()
                raise ValueError(f"Unable to connect to {kind} at {host}:{port}") from None
            client = engine
        elif kind == "mongodb":
            from pymongo import AsyncMongoClient
            client = AsyncMongoClient(host, port, username=username or None, password=password or None, serverSelectionTimeoutMS=8000)
            try:
                await client.admin.command("ping")
            except Exception:
                await client.close()
                raise ValueError(f"Unable to connect to MongoDB at {host}:{port}") from None
        elif kind == "redis":
            import redis.asyncio as redis
            client = redis.Redis(host=host, port=port, username=username or None, password=password or None, db=int(database) if database.isdigit() else 0, socket_connect_timeout=8, decode_responses=True)
            try:
                await client.ping()
            except Exception:
                await client.aclose()
                raise ValueError(f"Unable to connect to Redis at {host}:{port}") from None
        else:
            from cassandra.cluster import Cluster
            from cassandra.auth import PlainTextAuthProvider
            def open_cassandra():
                auth = PlainTextAuthProvider(username=username, password=password) if username else None
                cluster = Cluster([host], port=port, auth_provider=auth, connect_timeout=8, control_connection_timeout=8)
                try:
                    session = cluster.connect(database)
                    return cluster, session
                except Exception:
                    cluster.shutdown()
                    raise
            try:
                client = await asyncio.to_thread(open_cassandra)
            except Exception:
                raise ValueError(f"Unable to connect to Cassandra at {host}:{port}") from None
        connection_id = uuid.uuid4().hex
        item = Connection(connection_id, kind, label, database, client)
        self.connections[connection_id] = item
        if kind in {"postgresql", "mysql"}:
            self.relational[connection_id] = RelationalWorkbench(client, kind)
        return {"id": item.id, "kind": kind, "label": label, "database": database}

    def get(self, connection_id: str) -> Connection | None:
        if connection_id == "local":
            return None
        if connection_id not in self.connections:
            raise ValueError("Database connection not found")
        return self.connections[connection_id]

    async def disconnect(self, connection_id: str) -> None:
        item = self.get(connection_id)
        if item is None:
            raise ValueError("Local SQLite connection cannot be disconnected")
        del self.connections[connection_id]
        self.relational.pop(connection_id, None)
        if item.kind in {"postgresql", "mysql"}:
            await item.client.dispose()
        elif item.kind == "mongodb":
            await item.client.close()
        elif item.kind == "redis":
            await item.client.aclose()
        else:
            await asyncio.to_thread(item.client[0].shutdown)

    async def close(self) -> None:
        for connection_id in list(self.connections):
            await self.disconnect(connection_id)

    async def query(self, connection_id: str, sql: str, parameters: dict | None = None, limit: int = 1000) -> dict:
        item = self.get(connection_id)
        if item is None:
            return await self.local.query(sql, parameters, limit)
        if item.kind not in {"postgresql", "mysql", "cassandra"}:
            raise ValueError("Use document operations for MongoDB and Redis")
        if not sql.strip():
            raise ValueError("Empty query")
        size = min(max(1, int(limit)), 5000)
        if item.kind == "cassandra":
            def execute():
                result = item.client[1].execute(sql, parameters or None, timeout=30)
                rows = list(islice(result, size))
                columns = list(rows[0]._fields) if rows else list(result.column_names or [])
                return {"columns": columns, "rows": [[json_cell(cell) for cell in row] for row in rows], "row_count": len(rows)}
            return await asyncio.to_thread(execute)
        async with item.client.begin() as connection:
            result = await connection.execute(text(sql), parameters or {})
            if not result.returns_rows:
                if re.match(r"^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b", sql, re.I):
                    self.relational[connection_id].tables.clear()
                return {"columns": [], "rows": [], "row_count": result.rowcount}
            rows = [[json_cell(cell) for cell in row] for row in result.fetchmany(size)]
            return {"columns": list(result.keys()), "rows": rows, "row_count": len(rows)}

    async def page(self, connection_id: str, table: str, offset: int = 0, limit: int = 100) -> dict:
        item = self.get(connection_id)
        if item is None:
            return await self.local.page(table, offset, limit)
        if item.kind not in {"postgresql", "mysql"}:
            raise ValueError("Paged table browsing requires PostgreSQL or MySQL")
        return await self.relational[connection_id].page(table, offset, limit)

    async def update_cell(self, connection_id: str, table: str, column: str, value: object, *, rowid: int | None = None, key: dict | None = None) -> None:
        item = self.get(connection_id)
        if item is None:
            if rowid is None:
                raise ValueError("SQLite rowid is required")
            await self.local.update_cell(table, rowid, column, value)
            return
        if item.kind not in {"postgresql", "mysql"}:
            raise ValueError("Direct cell editing requires PostgreSQL or MySQL")
        await self.relational[connection_id].update_cell(table, key or {}, column, value)

    async def create_table(self, connection_id: str, name: str, columns: list[dict], indexes: list[dict] | None = None) -> dict:
        item = self.get(connection_id)
        if item is None:
            return await self.local.create_table(name, columns, indexes)
        if item.kind not in {"postgresql", "mysql"}:
            raise ValueError("Visual table design requires PostgreSQL or MySQL")
        return await self.relational[connection_id].create_table(name, columns, indexes)

    async def objects(self, connection_id: str) -> dict:
        item = self.get(connection_id)
        if item is None:
            return await self.local.objects()
        if item.kind in {"postgresql", "mysql"}:
            def reflect(sync_connection):
                inspector = inspect(sync_connection)
                tables = []
                for name in inspector.get_table_names()[:500]:
                    columns = inspector.get_columns(name)
                    primary = set(inspector.get_pk_constraint(name).get("constrained_columns") or [])
                    fks = inspector.get_foreign_keys(name)
                    tables.append({"name": name, "columns": [{"name": col["name"], "type": str(col["type"]), "primary_key": col["name"] in primary, "not_null": not col.get("nullable", True)} for col in columns],
                        "foreign_keys": [{"column": column, "references_table": fk["referred_table"], "references_column": (fk.get("referred_columns") or [""])[index]} for fk in fks for index, column in enumerate(fk.get("constrained_columns") or [])],
                        "indexes": [{"name": idx["name"], "unique": idx.get("unique", False)} for idx in inspector.get_indexes(name)]})
                return {"tables": tables, "views": inspector.get_view_names(), "procedures": []}
            async with item.client.connect() as connection:
                return await connection.run_sync(reflect)
        if item.kind == "mongodb":
            names = await item.client[item.database].list_collection_names()
            return {"tables": [{"name": name, "columns": [], "foreign_keys": [], "indexes": []} for name in names], "views": [], "procedures": []}
        if item.kind == "redis":
            result = await self.document(connection_id, "scan", {"pattern": "*"})
            return {"tables": [{"name": key, "columns": [], "foreign_keys": [], "indexes": []} for key in result["keys"]], "views": [], "procedures": []}
        def cassandra_tables():
            metadata = item.client[0].metadata.keyspaces.get(item.database)
            return {"tables": [{"name": table.name, "columns": [{"name": name, "type": str(column.cql_type), "primary_key": name in [key.name for key in table.primary_key]} for name, column in table.columns.items()], "foreign_keys": [], "indexes": []} for table in metadata.tables.values()] if metadata else [], "views": [], "procedures": []}
        return await asyncio.to_thread(cassandra_tables)

    async def document(self, connection_id: str, operation: str, payload: dict) -> dict:
        item = self.get(connection_id)
        if item is None or item.kind not in {"mongodb", "redis"}:
            raise ValueError("Select a MongoDB or Redis connection")
        if item.kind == "mongodb":
            collection = item.client[item.database][safe_name(payload.get("collection", ""))]
            filter_value = payload.get("filter") or {}
            if not isinstance(filter_value, dict):
                raise ValueError("MongoDB filter must be an object")
            if operation in {"delete", "update"} and not filter_value:
                raise ValueError("MongoDB changes require a non-empty filter")
            if operation == "find":
                rows = []
                async for document in collection.find(filter_value).limit(min(max(int(payload.get("limit", 100)), 1), 500)):
                    rows.append(json.loads(json.dumps(document, default=str)))
                return {"documents": rows}
            if operation == "insert":
                result = await collection.insert_one(payload["document"])
                return {"id": str(result.inserted_id)}
            if operation == "delete":
                result = await collection.delete_one(filter_value)
                return {"deleted": result.deleted_count}
            if operation == "update":
                change = payload.get("update")
                if not isinstance(change, dict) or not change or not all(isinstance(key, str) and key.startswith("$") for key in change):
                    raise ValueError("MongoDB update requires an operator document")
                result = await collection.update_one(filter_value, change)
                return {"matched": result.matched_count, "modified": result.modified_count}
            raise ValueError("Unsupported MongoDB operation")
        if operation == "scan":
            cursor = 0
            keys = []
            while True:
                cursor, batch = await item.client.scan(cursor=cursor, match=payload.get("pattern", "*"), count=100)
                keys.extend(batch)
                if len(keys) >= 500 or cursor == 0:
                    break
            return {"keys": keys[:500]}
        if operation == "get":
            return {"value": await item.client.get(payload["key"])}
        if operation == "inspect":
            key = payload["key"]
            kind = await item.client.type(key)
            if kind == "string":
                value = await item.client.get(key)
            elif kind == "hash":
                _, value = await item.client.hscan(key, count=100)
                value = dict(islice(value.items(), 100))
            elif kind == "list":
                value = await item.client.lrange(key, 0, 99)
            elif kind == "set":
                _, value = await item.client.sscan(key, count=100)
                value = value[:100]
            elif kind == "zset":
                value = await item.client.zrange(key, 0, 99, withscores=True)
            elif kind == "stream":
                value = await item.client.xrange(key, count=100)
            else:
                value = None
            return {"key": key, "type": kind, "value": value}
        if operation == "set":
            await item.client.set(payload["key"], payload["value"])
            return {"saved": True}
        if operation == "delete":
            return {"deleted": await item.client.delete(payload["key"])}
        raise ValueError("Unsupported Redis operation")
