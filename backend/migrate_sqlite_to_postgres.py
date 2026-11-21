"""One-time migration of an existing local DeepContext DB to PostgreSQL.

Usage:
  DATABASE_URL='postgresql://...' python migrate_sqlite_to_postgres.py \
    --sqlite ./data/users.db
"""
from __future__ import annotations

import argparse
import sqlite3

from auth import init_auth
from database import connect, initDB, is_postgres


TABLES = (
    "auth_users", "workspaces", "memberships", "auth_sessions", "invitations",
    "document_access", "login_attempts", "chat_history", "chat_sessions",
    "documents", "pending_uploads", "nexconn_huddles",
)


def migrate(sqlite_path: str):
    if not is_postgres():
        raise SystemExit("Set DATABASE_URL to the target PostgreSQL connection string first.")
    initDB()
    init_auth()
    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row
    target = connect()
    totals = {}
    try:
        for table in TABLES:
            exists = source.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if not exists:
                continue
            source_columns = [row[1] for row in source.execute(f'PRAGMA table_info("{table}")')]
            target_columns = {
                row[0] for row in target.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?",
                    (table,),
                ).fetchall()
            }
            columns = [column for column in source_columns if column in target_columns]
            if not columns:
                continue
            quoted = ", ".join(f'"{column}"' for column in columns)
            placeholders = ", ".join("?" for _ in columns)
            inserted = 0
            for row in source.execute(f'SELECT {quoted} FROM "{table}"'):
                cursor = target.execute(
                    f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders}) ON CONFLICT DO NOTHING',
                    tuple(row[column] for column in columns),
                )
                inserted += max(cursor.rowcount, 0)
            totals[table] = inserted
        target.execute(
            "SELECT setval(pg_get_serial_sequence('chat_history', 'id'), COALESCE((SELECT MAX(id) FROM chat_history), 1), true)"
        )
        target.execute(
            "SELECT setval(pg_get_serial_sequence('chat_sessions', 'id'), COALESCE((SELECT MAX(id) FROM chat_sessions), 1), true)"
        )
        target.commit()
    except Exception:
        target.rollback()
        raise
    finally:
        target.close()
        source.close()
    return totals


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", required=True, help="Path to backend/data/users.db")
    arguments = parser.parse_args()
    for name, count in migrate(arguments.sqlite).items():
        print(f"{name}: {count} rows copied")
