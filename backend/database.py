"""SQLite locally, PostgreSQL in production via DATABASE_URL."""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")
DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = os.getenv("SQLITE_DB_PATH", str(DATA_DIR / "users.db"))


def database_url() -> str:
    return os.getenv("DATABASE_URL", "").strip()


def is_postgres() -> bool:
    return database_url().startswith(("postgres://", "postgresql://"))


if is_postgres():
    import psycopg
    IntegrityError = psycopg.IntegrityError
else:
    psycopg = None
    IntegrityError = sqlite3.IntegrityError


class Row(dict):
    """Mapping row that also supports SQLite-style numeric indexes."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


class PostgresCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    @property
    def rowcount(self):
        return self._cursor.rowcount

    def _row(self, raw):
        if raw is None:
            return None
        columns = [column.name for column in self._cursor.description]
        return Row(zip(columns, raw))

    def fetchone(self):
        return self._row(self._cursor.fetchone())

    def fetchall(self):
        return [self._row(row) for row in self._cursor.fetchall()]

    def __iter__(self):
        for row in self._cursor:
            yield self._row(row)


def _postgres_sql(sql: str) -> str:
    statement = sql.strip()
    if statement.upper() == "BEGIN IMMEDIATE":
        return "BEGIN"
    statement = statement.replace("?", "%s")
    if re.search(r"\bINSERT\s+OR\s+IGNORE\b", statement, re.IGNORECASE):
        statement = re.sub(
            r"\bINSERT\s+OR\s+IGNORE\b", "INSERT", statement, flags=re.IGNORECASE
        )
        statement = statement.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    return statement


class PostgresConnection:
    def __init__(self):
        self._connection = psycopg.connect(database_url())

    def cursor(self):
        return PostgresCursor(self._connection.cursor())

    def execute(self, sql, params=()):
        cursor = self._connection.cursor()
        cursor.execute(_postgres_sql(sql), params)
        return PostgresCursor(cursor)

    def executescript(self, script):
        cursor = self._connection.cursor()
        for statement in script.split(";"):
            if statement.strip():
                cursor.execute(_postgres_sql(statement))
        return PostgresCursor(cursor)

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.rollback() if exc_type else self.commit()
        self.close()


def connect(path: str | None = None):
    """Open configured DB. An explicit path always selects SQLite (for tests/tools)."""
    if is_postgres() and path is None:
        return PostgresConnection()
    connection = sqlite3.connect(path or DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    return connection


def _init_postgres():
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chat_history (
                id BIGSERIAL PRIMARY KEY, session_id TEXT, role TEXT,
                content TEXT, diagrams TEXT, sources TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id BIGSERIAL PRIMARY KEY, session_id TEXT UNIQUE,
                username TEXT NOT NULL, title TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_message_at TIMESTAMPTZ, last_message_preview TEXT
            );
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
                workspace_id TEXT NOT NULL DEFAULT 'default',
                current_version INTEGER NOT NULL DEFAULT 1,
                chunk_ids TEXT NOT NULL DEFAULT '[]', ingested_at TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(workspace_id, source_name)
            );
            CREATE TABLE IF NOT EXISTS pending_uploads (
                document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
                file_path TEXT NOT NULL, file_size BIGINT NOT NULL, mime_type TEXT,
                status TEXT NOT NULL DEFAULT 'pending_approval',
                uploaded_by TEXT DEFAULT 'anonymous', team_id TEXT DEFAULT 'default',
                uploaded_at TEXT, approved_at TEXT, approved_by TEXT, job_id TEXT,
                access_level INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_source
              ON documents(workspace_id, source_name);
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS diagrams TEXT;
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS sources TEXT;
            ALTER TABLE documents ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';
            ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS access_level INTEGER NOT NULL DEFAULT 0;
            """
        )


def _init_sqlite():
    conn = connect(DB_PATH)
    cursor = conn.cursor()
    cursor.executescript(
        """
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
            content TEXT, diagrams TEXT, sources TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE,
            username TEXT NOT NULL, title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_message_at DATETIME, last_message_preview TEXT
        );
        CREATE TABLE IF NOT EXISTS documents (
            document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            current_version INTEGER NOT NULL DEFAULT 1,
            chunk_ids TEXT NOT NULL DEFAULT '[]', ingested_at TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pending_uploads (
            document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
            file_path TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type TEXT,
            status TEXT NOT NULL DEFAULT 'pending_approval',
            uploaded_by TEXT DEFAULT 'anonymous', team_id TEXT DEFAULT 'default',
            uploaded_at TEXT, approved_at TEXT, approved_by TEXT, job_id TEXT,
            access_level INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    for table, column, definition in (
        ("chat_history", "diagrams", "TEXT"),
        ("chat_history", "sources", "TEXT"),
        ("documents", "workspace_id", "TEXT NOT NULL DEFAULT 'default'"),
        ("pending_uploads", "access_level", "INTEGER NOT NULL DEFAULT 0"),
    ):
        columns = {row[1] for row in cursor.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    access_table = cursor.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_access'"
    ).fetchone()
    if access_table:
        cursor.execute(
            """
            UPDATE documents
            SET workspace_id = COALESCE((
                SELECT da.workspace_id FROM document_access da
                WHERE da.source_name = documents.source_name LIMIT 1
            ), workspace_id)
            WHERE workspace_id = 'default'
            """
        )

    # Older local databases used a global UNIQUE(source_name), which prevents
    # different workspaces from uploading files with the same name.
    legacy_global_unique = False
    for index_row in cursor.execute("PRAGMA index_list(documents)").fetchall():
        if not index_row[2]:
            continue
        columns = [row[2] for row in cursor.execute(
            f"PRAGMA index_info('{index_row[1]}')"
        ).fetchall()]
        if columns == ["source_name"]:
            legacy_global_unique = True
            break
    if legacy_global_unique:
        cursor.executescript(
            """
            ALTER TABLE documents RENAME TO documents_legacy;
            CREATE TABLE documents (
                document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
                workspace_id TEXT NOT NULL DEFAULT 'default',
                current_version INTEGER NOT NULL DEFAULT 1,
                chunk_ids TEXT NOT NULL DEFAULT '[]', ingested_at TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(workspace_id, source_name)
            );
            INSERT OR REPLACE INTO documents(
                document_id, source_name, workspace_id, current_version,
                chunk_ids, ingested_at, status, created_at, updated_at
            ) SELECT document_id, source_name, workspace_id, current_version,
                     chunk_ids, ingested_at, status, created_at, updated_at
              FROM documents_legacy;
            DROP TABLE documents_legacy;
            """
        )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_source "
        "ON documents(workspace_id, source_name)"
    )
    conn.commit()
    conn.close()


def initDB():
    try:
        _init_postgres() if is_postgres() else _init_sqlite()
    except Exception as exc:
        print(f"Database initialization failed: {exc}")
        return {"message": str(exc)}
    return None
