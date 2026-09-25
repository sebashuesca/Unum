"""Paged browsing, safe DDL and primary-key edits for external SQL engines."""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import MetaData, Table, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine


def safe_name(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or re.search(r"[\x00-\x1f\x7f]", value):
        raise ValueError("Invalid database object name")
    return value

SQL_TYPES = {"INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME"}
TYPE_MAP = {
    "postgresql": {"INTEGER": "INTEGER", "REAL": "DOUBLE PRECISION", "TEXT": "TEXT", "BLOB": "BYTEA", "NUMERIC": "NUMERIC", "BOOLEAN": "BOOLEAN", "DATE": "DATE", "DATETIME": "TIMESTAMP"},
    "mysql": {"INTEGER": "INTEGER", "REAL": "DOUBLE", "TEXT": "TEXT", "BLOB": "BLOB", "NUMERIC": "DECIMAL(20,6)", "BOOLEAN": "BOOLEAN", "DATE": "DATE", "DATETIME": "DATETIME"},
}


def quote(name: str, kind: str) -> str:
    safe_name(name)
    marker = "`" if kind == "mysql" else '"'
    return marker + name.replace(marker, marker + marker) + marker


def render_type(name: str, kind: str) -> str:
    kind = kind if kind in TYPE_MAP else "postgresql"
    value = str(name).upper()
    if value not in SQL_TYPES:
        raise ValueError("Unsupported SQL type")
    return TYPE_MAP[kind][value]


def json_cell(value: object) -> object:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (date, datetime, UUID, Decimal)):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "0x" + bytes(value).hex()
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def convert_input(value: object, column) -> object:
    if value is None:
        return None
    try:
        expected = column.type.python_type
    except NotImplementedError:
        return value
    if expected is bool and isinstance(value, str):
        if value.lower() in {"true", "1", "yes"}:
            return True
        if value.lower() in {"false", "0", "no"}:
            return False
        raise ValueError("Use true or false for a boolean column")
    if expected is date and isinstance(value, str):
        return date.fromisoformat(value)
    if expected is datetime and isinstance(value, str):
        return datetime.fromisoformat(value)
    if expected is Decimal:
        return Decimal(str(value))
    if expected is UUID:
        return UUID(str(value))
    if expected is bytes and isinstance(value, str):
        if not value.startswith("0x"):
            raise ValueError("Binary values must use a 0x hexadecimal prefix")
        return bytes.fromhex(value[2:])
    if expected in {int, float}:
        return expected(value)
    if expected in {dict, list} and isinstance(value, str):
        return json.loads(value)
    return value


class RelationalWorkbench:
    def __init__(self, engine: AsyncEngine, kind: str):
        if kind not in TYPE_MAP:
            raise ValueError("Relational workbench supports PostgreSQL and MySQL")
        self.engine, self.kind = engine, kind
        self.tables: dict[str, Table] = {}

    async def table(self, name: str) -> Table:
        safe_name(name)
        if name not in self.tables:
            async with self.engine.connect() as connection:
                self.tables[name] = await connection.run_sync(lambda sync: Table(name, MetaData(), autoload_with=sync))
        return self.tables[name]

    async def page(self, name: str, offset: int = 0, limit: int = 100) -> dict:
        table = await self.table(name)
        keys = list(table.primary_key.columns)
        size = min(max(int(limit), 1), 500)
        start = max(int(offset), 0)
        statement = select(table).limit(size).offset(start)
        if keys:
            statement = statement.order_by(*keys)
        async with self.engine.connect() as connection:
            total = await connection.scalar(select(func.count()).select_from(table))
            result = await connection.execute(statement)
            columns = list(result.keys())
            raw_rows = result.fetchall()
        return {"columns": columns, "rows": [[json_cell(cell) for cell in row] for row in raw_rows],
                "row_keys": [{key.name: json_cell(row._mapping[key.name]) for key in keys} for row in raw_rows],
                "editable_columns": [column.name for column in table.columns if column.name not in {key.name for key in keys}] if keys else [],
                "total": total}

    async def update_cell(self, name: str, key: dict, column_name: str, value: object) -> None:
        table = await self.table(name)
        keys = list(table.primary_key.columns)
        if not keys or not isinstance(key, dict) or set(key) != {column.name for column in keys}:
            raise ValueError("A complete primary key is required for editing")
        if column_name not in table.columns or column_name in key:
            raise ValueError("Column is not editable")
        target = table.columns[column_name]
        statement = update(table).values({column_name: convert_input(value, target)})
        for primary in keys:
            statement = statement.where(primary == convert_input(key[primary.name], primary))
        async with self.engine.begin() as connection:
            result = await connection.execute(statement)
            if result.rowcount != 1:
                raise ValueError("Row not found or primary key is not unique")

    async def create_table(self, name: str, columns: list[dict], indexes: list[dict] | None = None) -> dict:
        table_name = quote(name, self.kind)
        if not isinstance(columns, list) or not 1 <= len(columns) <= 100:
            raise ValueError("Define 1 to 100 columns")
        definitions: list[str] = []
        primary: list[str] = []
        foreign: list[str] = []
        seen: set[str] = set()
        for column in columns:
            raw_name = safe_name(column["name"])
            if raw_name in seen:
                raise ValueError("Duplicate column")
            seen.add(raw_name)
            column_name = quote(raw_name, self.kind)
            definitions.append(f"{column_name} {render_type(column['type'], self.kind)}" + (" NOT NULL" if column.get("required") else ""))
            if column.get("primary_key"):
                if self.kind == "mysql" and str(column["type"]).upper() in {"TEXT", "BLOB"}:
                    raise ValueError("MySQL primary keys need a bounded non-BLOB type")
                primary.append(column_name)
            if column.get("references_table"):
                reference = quote(column["references_table"], self.kind)
                referenced_column = quote(column["references_column"], self.kind)
                foreign.append(f"FOREIGN KEY ({column_name}) REFERENCES {reference} ({referenced_column})")
        if primary:
            definitions.append(f"PRIMARY KEY ({', '.join(primary)})")
        definitions.extend(foreign)
        ddl = f"CREATE TABLE {table_name} ({', '.join(definitions)})"
        index_statements: list[str] = []
        for index in indexes or []:
            name_of_index = quote(index["name"], self.kind)
            index_columns = index.get("columns") or []
            if not index_columns or any(safe_name(item) not in seen for item in index_columns):
                raise ValueError("Index refers to unknown columns")
            unique = "UNIQUE " if index.get("unique") else ""
            index_statements.append(f"CREATE {unique}INDEX {name_of_index} ON {table_name} ({', '.join(quote(item, self.kind) for item in index_columns)})")
        async with self.engine.begin() as connection:
            await connection.execute(text(ddl))
            for statement in index_statements:
                await connection.execute(text(statement))
        self.tables.pop(name, None)
        return {"table": name, "ddl": ddl}
