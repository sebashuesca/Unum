"""Async SQLite workspace database and paged grid operations."""
from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from .relational import json_cell


def identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError("Invalid SQL identifier")
    return '"' + value + '"'


SQL_TYPES = {"INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME"}


class Database:
    def __init__(self, workspace: Path):
        root = workspace / ".unum"
        root.mkdir(parents=True, exist_ok=True)
        self.engine: AsyncEngine = create_async_engine(f"sqlite+aiosqlite:///{root / 'data.sqlite3'}")
        @event.listens_for(self.engine.sync_engine, "connect")
        def enable_foreign_keys(connection, _record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async def query(self, sql: str, parameters: dict | None = None, limit: int = 1000) -> dict:
        if not sql.strip():
            raise ValueError("Empty SQL")
        async with self.engine.begin() as connection:
            result = await connection.execute(text(sql), parameters or {})
            if not result.returns_rows:
                return {"columns": [], "rows": [], "row_count": result.rowcount}
            columns = list(result.keys())
            rows = [[json_cell(cell) for cell in row] for row in result.fetchmany(min(max(1, limit), 5000))]
            return {"columns": columns, "rows": rows, "row_count": len(rows)}

    async def schema(self) -> list[dict]:
        async with self.engine.connect() as connection:
            result = await connection.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
            names = [r[0] for r in result]
            tables = []
            for name in names:
                info = await connection.execute(text(f"PRAGMA table_info({identifier(name)})"))
                foreign_keys = await connection.execute(text(f"PRAGMA foreign_key_list({identifier(name)})"))
                indexes = await connection.execute(text(f"PRAGMA index_list({identifier(name)})"))
                tables.append({"name": name, "columns": [{"name": row[1], "type": row[2], "primary_key": bool(row[5]), "not_null": bool(row[3])} for row in info],
                    "foreign_keys": [{"column": row[3], "references_table": row[2], "references_column": row[4]} for row in foreign_keys],
                    "indexes": [{"name": row[1], "unique": bool(row[2])} for row in indexes]})
            return tables

    async def objects(self) -> dict:
        async with self.engine.connect() as connection:
            result = await connection.execute(text("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type,name"))
            items = [dict(row._mapping) for row in result]
        return {"tables": await self.schema(), "views": [item["name"] for item in items if item["type"] == "view"], "procedures": []}

    async def er_diagram(self) -> dict:
        tables = await self.schema()
        return {"nodes": [{"id": table["name"], "columns": table["columns"]} for table in tables],
                "edges": [{"from": table["name"], "column": fk["column"], "to": fk["references_table"], "target_column": fk["references_column"]}
                          for table in tables for fk in table["foreign_keys"]]}

    async def create_table(self, name: str, columns: list[dict], indexes: list[dict] | None = None) -> dict:
        table = identifier(name)
        if not isinstance(columns, list) or not columns or len(columns) > 100:
            raise ValueError("Define 1 to 100 columns")
        declarations = []
        primary = []
        foreign = []
        seen = set()
        for column in columns:
            column_name = identifier(column["name"])
            if column_name in seen:
                raise ValueError("Duplicate column")
            seen.add(column_name)
            data_type = str(column["type"]).upper()
            if data_type not in SQL_TYPES:
                raise ValueError("Unsupported column type")
            declarations.append(f"{column_name} {data_type}" + (" NOT NULL" if column.get("required") else ""))
            if column.get("primary_key"):
                primary.append(column_name)
            if column.get("references_table"):
                foreign.append(f"FOREIGN KEY ({column_name}) REFERENCES {identifier(column['references_table'])}({identifier(column['references_column'])})")
        if primary:
            declarations.append(f"PRIMARY KEY ({', '.join(primary)})")
        declarations.extend(foreign)
        ddl = f"CREATE TABLE {table} ({', '.join(declarations)})"
        async with self.engine.begin() as connection:
            await connection.execute(text(ddl))
            for index in indexes or []:
                index_name = identifier(index["name"])
                index_columns = index.get("columns", [])
                if not index_columns or any(identifier(col) not in seen for col in index_columns):
                    raise ValueError("Index refers to unknown columns")
                unique = "UNIQUE " if index.get("unique") else ""
                await connection.execute(text(f"CREATE {unique}INDEX {index_name} ON {table} ({', '.join(identifier(col) for col in index_columns)})"))
        return {"table": name, "ddl": ddl}

    async def page(self, table: str, offset: int = 0, limit: int = 100) -> dict:
        quoted = identifier(table)
        size = min(max(1, limit), 500)
        start = max(0, offset)
        async with self.engine.connect() as connection:
            count = await connection.scalar(text(f"SELECT COUNT(*) FROM {quoted}"))
            result = await connection.execute(text(f"SELECT rowid AS _rowid_, * FROM {quoted} LIMIT :size OFFSET :start"), {"size": size, "start": start})
            return {"columns": list(result.keys()), "rows": [[json_cell(cell) for cell in row] for row in result], "total": count}

    async def update_cell(self, table: str, rowid: int, column: str, value: object) -> None:
        quoted_table, quoted_column = identifier(table), identifier(column)
        if column == "_rowid_":
            raise ValueError("Row identifier is read only")
        async with self.engine.begin() as connection:
            result = await connection.execute(text(f"UPDATE {quoted_table} SET {quoted_column}=:value WHERE rowid=:rowid"), {"value": value, "rowid": rowid})
            if result.rowcount != 1:
                raise ValueError("Row not found")

    async def close(self) -> None:
        await self.engine.dispose()
