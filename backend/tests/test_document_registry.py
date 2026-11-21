"""Workspace-isolation tests for the SQLite/Chroma document registry."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import database
import document_registry
import auth


class FakeVectorDB:
    def __init__(self, rows):
        self.rows = list(rows)
        self.deleted = []
        self.where_calls = []
        self.updated = []
        self._collection = self

    def get(self, where=None):
        self.where_calls.append(where)
        rows = self.rows
        if where:
            conditions = where.get("$and", [where])
            rows = [row for row in rows if all(
                row[2].get(key) == value
                for condition in conditions
                for key, value in condition.items()
            )]
        return {
            "ids": [row[0] for row in rows],
            "documents": [row[1] for row in rows],
            "metadatas": [row[2] for row in rows],
        }

    def delete(self, ids):
        self.deleted.extend(ids)
        self.rows = [row for row in self.rows if row[0] not in set(ids)]

    def update(self, ids, metadatas):
        self.updated.extend(zip(ids, metadatas))
        updates = dict(zip(ids, metadatas))
        self.rows = [
            (row_id, text, updates.get(row_id, metadata))
            for row_id, text, metadata in self.rows
        ]


class DocumentRegistryWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        path = str(Path(self.directory.name, "registry.db"))
        for target in ("database.DB_PATH", "document_registry.DB_PATH", "auth.DB_PATH"):
            patcher = patch(target, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        database.initDB()
        auth.init_auth()
        database.initDB()

    def register(self, workspace, document_id, chunk_id):
        return document_registry.upsert_document(
            document_id=document_id,
            source_name="policy.md",
            workspace_id=workspace,
            current_version=1,
            chunk_ids=[chunk_id],
            ingested_at="2026-01-01 00:00:00",
        )

    def test_same_filename_is_independent_in_each_workspace(self):
        self.register("alpha", "document-alpha", "chunk-alpha")
        self.register("beta", "document-beta", "chunk-beta")

        self.assertEqual(document_registry.get_document("policy.md", "alpha")["document_id"], "document-alpha")
        self.assertEqual(document_registry.get_document("policy.md", "beta")["document_id"], "document-beta")
        self.assertEqual([row["workspace_id"] for row in document_registry.list_documents("alpha")], ["alpha"])

    def test_delete_never_collects_or_removes_another_workspace_chunks(self):
        self.register("alpha", "document-alpha", "chunk-alpha")
        self.register("beta", "document-beta", "chunk-beta")
        vectors = FakeVectorDB([
            ("chunk-alpha", "Alpha policy", {"source_name": "policy.md", "team_id": "alpha"}),
            ("chunk-beta", "Beta policy", {"source_name": "policy.md", "team_id": "beta"}),
        ])

        deleted = document_registry.delete_chunks_for_source(vectors, "policy.md", "alpha")

        self.assertEqual(deleted, 1)
        self.assertEqual(vectors.deleted, ["chunk-alpha"])
        self.assertEqual(vectors.rows[0][0], "chunk-beta")
        self.assertEqual(vectors.where_calls[-1], {
            "$and": [{"team_id": "alpha"}, {"source_name": "policy.md"}],
        })

    def test_registry_rejects_unscoped_operations(self):
        with self.assertRaises(ValueError):
            document_registry.list_documents("")
        with self.assertRaises(ValueError):
            document_registry.delete_document_record("policy.md", "")

    def test_document_access_key_allows_same_source_in_two_workspaces(self):
        with auth.connect() as connection:
            connection.execute("INSERT INTO document_access VALUES (?, ?, ?)", ("policy.md", "alpha", 0))
            connection.execute("INSERT INTO document_access VALUES (?, ?, ?)", ("policy.md", "beta", 2))
            rows = connection.execute(
                "SELECT workspace_id, access_level FROM document_access WHERE source_name=? ORDER BY workspace_id",
                ("policy.md",),
            ).fetchall()
        self.assertEqual([(row["workspace_id"], row["access_level"]) for row in rows], [("alpha", 0.0), ("beta", 2.0)])

    def test_legacy_migration_preserves_access_and_repairs_chunk_acl_metadata(self):
        with auth.connect() as connection:
            connection.execute(
                "INSERT INTO document_access VALUES (?, ?, ?)",
                ("payroll.pdf", "alpha", 2),
            )
        vectors = FakeVectorDB([
            ("old-chunk", "Restricted payroll", {
                "source_name": "payroll.pdf", "team_id": "alpha",
                "ingested_at": "2026-01-01 00:00:00",
            }),
        ])

        result = document_registry.migrate_legacy_duplicate_chunks(vectors)

        self.assertEqual(result["documents_processed"], 1)
        record = document_registry.get_document("payroll.pdf", "alpha")
        self.assertEqual(record["acl_entries"], ["role:admin", "role:owner"])
        repaired = vectors.updated[0][1]
        self.assertEqual(repaired["document_id"], record["document_id"])
        self.assertEqual(repaired["acl_entries"], '["role:admin","role:owner"]')


if __name__ == "__main__":
    unittest.main()
