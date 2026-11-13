import sqlite3
import os

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
                source_name TEXT NOT NULL UNIQUE,
                current_version INTEGER NOT NULL DEFAULT 1,
                chunk_ids TEXT NOT NULL DEFAULT '[]',
                ingested_at TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')

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
