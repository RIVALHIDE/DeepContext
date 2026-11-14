import sqlite3
import tempfile
import unittest

from auth import password_hash, verify_password
from reset_password import reset_local_password


class ResetPasswordTests(unittest.TestCase):
    def setUp(self):
        self.database = tempfile.NamedTemporaryFile(suffix=".db")
        with sqlite3.connect(self.database.name) as db:
            db.executescript("""
                CREATE TABLE auth_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT);
                CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, expires INTEGER);
                CREATE TABLE login_attempts (key TEXT, attempted INTEGER);
            """)
            db.execute("INSERT INTO auth_users VALUES (?, ?, ?, ?)", (
                "user-1", "owner@example.com", "Owner", password_hash("old-password-123"),
            ))
            db.execute("INSERT INTO auth_sessions VALUES ('session-1', 'user-1', 'workspace-1', 9999999999)")
            db.execute("INSERT INTO login_attempts VALUES ('127.0.0.1:owner@example.com', 1)")

    def test_reset_hashes_password_and_revokes_sessions(self):
        revoked = reset_local_password(" OWNER@example.com ", "new-password-456", self.database.name)
        with sqlite3.connect(self.database.name) as db:
            stored = db.execute("SELECT password_hash FROM auth_users WHERE id='user-1'").fetchone()[0]
            sessions = db.execute("SELECT COUNT(*) FROM auth_sessions").fetchone()[0]
            attempts = db.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0]
        self.assertEqual(revoked, 1)
        self.assertTrue(verify_password("new-password-456", stored))
        self.assertEqual(sessions, 0)
        self.assertEqual(attempts, 0)

    def test_unknown_account_is_not_created(self):
        with self.assertRaises(LookupError):
            reset_local_password("missing@example.com", "new-password-456", self.database.name)


if __name__ == "__main__":
    unittest.main()
