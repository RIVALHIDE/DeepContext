import sqlite3
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BACKEND_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# Shared between API and Celery via the ./backend/data Docker volume mount.
DB_PATH = os.getenv("SQLITE_DB_PATH", os.path.join(DATA_DIR, "users.db"))


def initDB():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
    
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                diagrams TEXT,
                sources TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )            
        ''')

        cursor.execute("PRAGMA table_info(chat_history)")
        columns = {row[1] for row in cursor.fetchall()}
        if "diagrams" not in columns:
            cursor.execute("ALTER TABLE chat_history ADD COLUMN diagrams TEXT")
        if "sources" not in columns:
            cursor.execute("ALTER TABLE chat_history ADD COLUMN sources TEXT")

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE,
                username TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_message_at DATETIME,
                last_message_preview TEXT
            )
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY,
                source_name TEXT NOT NULL,
                workspace_id TEXT NOT NULL DEFAULT 'default',
                current_version INTEGER NOT NULL DEFAULT 1,
                chunk_ids TEXT NOT NULL DEFAULT '[]',
                ingested_at TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        cursor.execute("PRAGMA table_info(documents)")
        document_columns = {row[1] for row in cursor.fetchall()}
        if "workspace_id" not in document_columns:
            cursor.execute("ALTER TABLE documents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'")
        # Backfill registries created before workspace-aware document tracking.
        # document_access is installed by auth and may not exist on the very
        # first database initialization, hence the guarded lookup.
        access_table = cursor.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_access'"
        ).fetchone()
        if access_table:
            cursor.execute('''
                UPDATE documents
                SET workspace_id = COALESCE((
                    SELECT da.workspace_id FROM document_access da
                    WHERE da.source_name = documents.source_name
                    LIMIT 1
                ), workspace_id)
                WHERE workspace_id = 'default'
            ''')

        # Remove the legacy global UNIQUE(source_name) constraint. A filename
        # is unique only inside its workspace, not across the whole product.
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
            cursor.executescript('''
                ALTER TABLE documents RENAME TO documents_legacy;
                CREATE TABLE documents (
                    document_id TEXT PRIMARY KEY,
                    source_name TEXT NOT NULL,
                    workspace_id TEXT NOT NULL DEFAULT 'default',
                    current_version INTEGER NOT NULL DEFAULT 1,
                    chunk_ids TEXT NOT NULL DEFAULT '[]',
                    ingested_at TEXT,
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
            ''')
        cursor.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_source "
            "ON documents(workspace_id, source_name)"
        )

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS pending_uploads (
                document_id TEXT PRIMARY KEY,
                source_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                mime_type TEXT,
                status TEXT NOT NULL DEFAULT 'pending_approval',
                uploaded_by TEXT DEFAULT 'anonymous',
                team_id TEXT DEFAULT 'default',
                uploaded_at TEXT,
                approved_at TEXT,
                approved_by TEXT,
                job_id TEXT
            )
        ''')

        conn.commit()
        conn.close()
    except Exception as e:
        return {"message":e}
