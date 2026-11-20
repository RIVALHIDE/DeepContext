import json
import sqlite3

from database import DB_PATH

class ChatHistroyManager:
    def save_messages(self, sessionId: str, role: str, content: str, diagrams=None, sources=None):
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        self._ensure_extra_columns(cursor)

        cursor.execute(
            "INSERT INTO chat_history (session_id, role, content, diagrams, sources) VALUES (?, ?, ?, ?, ?)",
            (
                sessionId,
                role,
                content,
                json.dumps(diagrams) if diagrams else None,
                json.dumps(sources) if sources else None,
            )
        )
        conn.commit()
        conn.close()

    def _ensure_extra_columns(self, cursor):
        cursor.execute("PRAGMA table_info(chat_history)")
        columns = {row[1] for row in cursor.fetchall()}
        if "diagrams" not in columns:
            cursor.execute("ALTER TABLE chat_history ADD COLUMN diagrams TEXT")
        if "sources" not in columns:
            cursor.execute("ALTER TABLE chat_history ADD COLUMN sources TEXT")

    def get_history(self, sessionId: str, limit=200):
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        self._ensure_extra_columns(cursor)

        cursor.execute(
            "SELECT id, role, content, diagrams, sources FROM chat_history WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?",
            (sessionId, limit,)
        )

        result = cursor.fetchall()
        conn.close()

        history = []
        for history_id, role, content, diagrams_raw, sources_raw in reversed(result):
            parsed_diagrams = []
            if diagrams_raw:
                try:
                    parsed_diagrams = json.loads(diagrams_raw)
                except json.JSONDecodeError:
                    parsed_diagrams = []

            parsed_sources = []
            if sources_raw:
                try:
                    parsed_sources = json.loads(sources_raw)
                except json.JSONDecodeError:
                    parsed_sources = []

            entry = {
                "id": history_id,
                "role": role,
                "content": content,
                "diagrams": parsed_diagrams if role == "ai" else [],
            }
            if role == "ai":
                entry["sources"] = parsed_sources

            history.append(entry)

        return history

    def truncate_from_human_turn(self, sessionId: str, human_turn: int):
        """Remove a human turn and everything after it for edit/retry branching."""
        if human_turn < 0:
            raise ValueError("human_turn must be non-negative")

        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        row = cursor.execute(
            """
            SELECT id FROM chat_history
            WHERE session_id = ? AND role = 'human'
            ORDER BY id ASC
            LIMIT 1 OFFSET ?
            """,
            (sessionId, human_turn),
        ).fetchone()
        if row:
            cursor.execute(
                "DELETE FROM chat_history WHERE session_id = ? AND id >= ?",
                (sessionId, row[0]),
            )
            conn.commit()
        conn.close()
    
    def deleteChatBySession(self,sessionId:str):
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        cursor.execute(
            "DELETE FROM chat_history WHERE session_id = ?",
            (sessionId,)        
        )
        
        conn.commit()
        conn.close()
