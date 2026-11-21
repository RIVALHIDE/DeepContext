"""SQLite locally, PostgreSQL in production via DATABASE_URL."""
from __future__ import annotations

import os
import re
import sqlite3
import threading
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

    def execute(self, sql, params=()):
        """Match sqlite3.Cursor.execute while translating SQLite placeholders."""
        self._cursor.execute(_postgres_sql(sql), params)
        return self

    def close(self):
        self._cursor.close()

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
        # Fail with a useful API error instead of holding a request forever
        # when the serverless PostgreSQL endpoint is unavailable.
        connect_timeout = max(5, int(os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "20")))
        self._connection = psycopg.connect(
            database_url(),
            connect_timeout=connect_timeout,
        )

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
                content TEXT, diagrams TEXT, sources TEXT, retrieval_grounded INTEGER,
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
                acl_entries TEXT NOT NULL DEFAULT '["role:admin"]',
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
                access_level INTEGER NOT NULL DEFAULT 0,
                acl_entries TEXT NOT NULL DEFAULT '["role:admin"]'
            );
            CREATE TABLE IF NOT EXISTS workspace_groups (
                id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, name)
            );
            CREATE TABLE IF NOT EXISTS group_memberships (
                workspace_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(workspace_id, group_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS document_acl_entries (
                workspace_id TEXT NOT NULL, document_id TEXT NOT NULL,
                acl_token TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(workspace_id, document_id, acl_token)
            );
            CREATE TABLE IF NOT EXISTS retrieval_audit_log (
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
                occurred_at TIMESTAMPTZ NOT NULL, query_hash TEXT NOT NULL,
                acl_scope_hash TEXT NOT NULL, acl_token_count INTEGER NOT NULL,
                acl_scope_summary TEXT NOT NULL DEFAULT '{}',
                retrieved_document_ids TEXT NOT NULL DEFAULT '[]',
                result_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS workspace_leaderboard (
                workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
                user_name TEXT NOT NULL, team_name TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(workspace_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS workspace_point_events (
                workspace_id TEXT NOT NULL, event_key TEXT NOT NULL,
                user_id TEXT NOT NULL, points INTEGER NOT NULL,
                reason TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(workspace_id, event_key)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_source
              ON documents(workspace_id, source_name);
            CREATE INDEX IF NOT EXISTS idx_workspace_leaderboard_rank
              ON workspace_leaderboard(workspace_id, score DESC, user_name);
            CREATE INDEX IF NOT EXISTS idx_workspace_point_events_user
              ON workspace_point_events(workspace_id, user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_group_memberships_user
              ON group_memberships(workspace_id, user_id, group_id);
            CREATE INDEX IF NOT EXISTS idx_document_acl_token
              ON document_acl_entries(workspace_id, acl_token, document_id);
            CREATE INDEX IF NOT EXISTS idx_retrieval_audit_workspace_time
              ON retrieval_audit_log(workspace_id, occurred_at DESC);
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS diagrams TEXT;
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS sources TEXT;
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS retrieval_grounded INTEGER;
            ALTER TABLE documents ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';
            ALTER TABLE documents ADD COLUMN IF NOT EXISTS acl_entries TEXT NOT NULL DEFAULT '["role:admin"]';
            ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS access_level INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS acl_entries TEXT NOT NULL DEFAULT '["role:admin"]';
            ALTER TABLE retrieval_audit_log ADD COLUMN IF NOT EXISTS acl_scope_summary TEXT NOT NULL DEFAULT '{}';
            """
        )
        conn.execute(
            """CREATE OR REPLACE FUNCTION prevent_retrieval_audit_mutation()
               RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN
                 RAISE EXCEPTION 'retrieval_audit_log is append-only';
               END;
               $$"""
        )
        conn.execute("DROP TRIGGER IF EXISTS retrieval_audit_immutable ON retrieval_audit_log")
        conn.execute(
            """CREATE TRIGGER retrieval_audit_immutable
               BEFORE UPDATE OR DELETE ON retrieval_audit_log
               FOR EACH ROW EXECUTE FUNCTION prevent_retrieval_audit_mutation()"""
        )


def _init_sqlite():
    conn = connect(DB_PATH)
    cursor = conn.cursor()
    cursor.executescript(
        """
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
            content TEXT, diagrams TEXT, sources TEXT, retrieval_grounded INTEGER,
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
            acl_entries TEXT NOT NULL DEFAULT '["role:admin"]',
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
            access_level INTEGER NOT NULL DEFAULT 0,
            acl_entries TEXT NOT NULL DEFAULT '["role:admin"]'
        );
        CREATE TABLE IF NOT EXISTS workspace_groups (
            id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, name)
        );
        CREATE TABLE IF NOT EXISTS group_memberships (
            workspace_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workspace_id, group_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS document_acl_entries (
            workspace_id TEXT NOT NULL, document_id TEXT NOT NULL,
            acl_token TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workspace_id, document_id, acl_token)
        );
        CREATE TABLE IF NOT EXISTS retrieval_audit_log (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL, query_hash TEXT NOT NULL,
            acl_scope_hash TEXT NOT NULL, acl_token_count INTEGER NOT NULL,
            acl_scope_summary TEXT NOT NULL DEFAULT '{}',
            retrieved_document_ids TEXT NOT NULL DEFAULT '[]',
            result_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS workspace_leaderboard (
            workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
            user_name TEXT NOT NULL, team_name TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_point_events (
            workspace_id TEXT NOT NULL, event_key TEXT NOT NULL,
            user_id TEXT NOT NULL, points INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workspace_id, event_key)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_leaderboard_rank
          ON workspace_leaderboard(workspace_id, score DESC, user_name);
        CREATE INDEX IF NOT EXISTS idx_workspace_point_events_user
          ON workspace_point_events(workspace_id, user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_group_memberships_user
          ON group_memberships(workspace_id, user_id, group_id);
        CREATE INDEX IF NOT EXISTS idx_document_acl_token
          ON document_acl_entries(workspace_id, acl_token, document_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_audit_workspace_time
          ON retrieval_audit_log(workspace_id, occurred_at DESC);
        CREATE TRIGGER IF NOT EXISTS retrieval_audit_no_update
          BEFORE UPDATE ON retrieval_audit_log
          BEGIN SELECT RAISE(ABORT, 'retrieval_audit_log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS retrieval_audit_no_delete
          BEFORE DELETE ON retrieval_audit_log
          BEGIN SELECT RAISE(ABORT, 'retrieval_audit_log is append-only'); END;
        """
    )
    for table, column, definition in (
        ("chat_history", "diagrams", "TEXT"),
        ("chat_history", "sources", "TEXT"),
        ("chat_history", "retrieval_grounded", "INTEGER"),
        ("documents", "workspace_id", "TEXT NOT NULL DEFAULT 'default'"),
        ("documents", "acl_entries", "TEXT NOT NULL DEFAULT '[\"role:admin\"]'"),
        ("pending_uploads", "access_level", "INTEGER NOT NULL DEFAULT 0"),
        ("pending_uploads", "acl_entries", "TEXT NOT NULL DEFAULT '[\"role:admin\"]'"),
        ("retrieval_audit_log", "acl_scope_summary", "TEXT NOT NULL DEFAULT '{}'"),
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
                acl_entries TEXT NOT NULL DEFAULT '["role:admin"]',
                status TEXT NOT NULL DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(workspace_id, source_name)
            );
            INSERT OR REPLACE INTO documents(
                document_id, source_name, workspace_id, current_version,
                chunk_ids, ingested_at, acl_entries, status, created_at, updated_at
            ) SELECT document_id, source_name, workspace_id, current_version,
                     chunk_ids, ingested_at, acl_entries, status, created_at, updated_at
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


_INIT_LOCK = threading.Lock()
_INITIALIZED_TARGETS: set[str] = set()


def _database_target() -> str:
    """Stable identity used to initialize each configured database only once."""
    return database_url() if is_postgres() else f"sqlite:{Path(DB_PATH).resolve()}"


def initDB():
    """Install the schema once per process and database.

    API requests arrive concurrently. Running ALTER TABLE from every request
    caused PostgreSQL DDL deadlocks on Neon, so initialization is serialized
    and remembered after the first successful run.
    """
    target = _database_target()
    if target in _INITIALIZED_TARGETS:
        return None

    with _INIT_LOCK:
        if target in _INITIALIZED_TARGETS:
            return None
        try:
            _init_postgres() if is_postgres() else _init_sqlite()
        except Exception as exc:
            # Schema installation is required for authentication, workspace
            # isolation, ingestion and scoring. A production process must not
            # advertise readiness with a partially initialized database.
            raise RuntimeError(f"Database initialization failed: {exc}") from exc
        _INITIALIZED_TARGETS.add(target)
    return None
