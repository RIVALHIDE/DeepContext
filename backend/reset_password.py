"""Local administrator password recovery for DeepContext.

Passwords are intentionally read with getpass instead of a command-line flag,
so they do not appear in shell history or the process list.
"""

import argparse
import getpass
import sqlite3

from auth import normalize_email, password_hash
from database import DB_PATH


def reset_local_password(email: str, new_password: str, db_path: str = DB_PATH) -> int:
    """Replace one local password, revoke its sessions, and return the count."""
    normalized = normalize_email(email)
    if not 12 <= len(new_password) <= 128:
        raise ValueError("Password must contain between 12 and 128 characters.")

    with sqlite3.connect(db_path) as database:
        user = database.execute(
            "SELECT id FROM auth_users WHERE email=?", (normalized,),
        ).fetchone()
        if not user:
            raise LookupError(f"No DeepContext account exists for {normalized}.")

        database.execute(
            "UPDATE auth_users SET password_hash=? WHERE id=?",
            (password_hash(new_password), user[0]),
        )
        revoked = database.execute(
            "DELETE FROM auth_sessions WHERE user_id=?", (user[0],),
        ).rowcount
        suffix = f":{normalized}"
        database.execute(
            "DELETE FROM login_attempts WHERE substr(key, -length(?))=?",
            (suffix, suffix),
        )
    return revoked


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reset a DeepContext account password from the backend host.",
    )
    parser.add_argument("email", help="Email address of the local account")
    args = parser.parse_args()

    first = getpass.getpass("New password (12-128 characters): ")
    second = getpass.getpass("Confirm new password: ")
    if first != second:
        parser.error("Passwords do not match.")

    try:
        revoked = reset_local_password(args.email, first)
    except (LookupError, ValueError) as error:
        parser.error(str(error))
    print(f"Password updated. Revoked {revoked} active session(s). You can sign in now.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
