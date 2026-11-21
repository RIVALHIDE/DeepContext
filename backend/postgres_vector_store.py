"""Small LangChain-compatible vector store backed by PostgreSQL + pgvector.

This is used by the free cloud deployment so document vectors can live in the
same persistent Neon database as the rest of the application. Local
development can continue to use Chroma.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Iterable

from langchain_core.documents import Document

from database import connect, is_postgres


EMBEDDING_DIMENSIONS = 384  # sentence-transformers/all-MiniLM-L6-v2


def _metadata(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _compare(actual: Any, operator: str, expected: Any) -> bool:
    try:
        if operator == "$eq":
            return actual == expected
        if operator == "$ne":
            return actual != expected
        if operator == "$in":
            return actual in expected
        if operator == "$nin":
            return actual not in expected
        if operator == "$lte":
            return actual <= expected
        if operator == "$lt":
            return actual < expected
        if operator == "$gte":
            return actual >= expected
        if operator == "$gt":
            return actual > expected
    except (TypeError, ValueError):
        return False
    return False


def metadata_matches(metadata: dict, where: dict | None) -> bool:
    """Evaluate the subset of Chroma filters used by DeepContext."""
    if not where:
        return True
    if "$and" in where:
        return all(metadata_matches(metadata, item) for item in where["$and"])
    if "$or" in where:
        return any(metadata_matches(metadata, item) for item in where["$or"])

    for key, expected in where.items():
        actual = metadata.get(key)
        if isinstance(expected, dict):
            if not all(_compare(actual, operator, value) for operator, value in expected.items()):
                return False
        elif actual != expected:
            return False
    return True


def _vector_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{float(value):.10g}" for value in values) + "]"


class PostgresVectorStore:
    """Compatibility layer for the Chroma methods used by this project."""

    def __init__(self, collection_name: str, embedding_function):
        if not is_postgres():
            raise RuntimeError("VECTOR_STORE_BACKEND=postgres requires DATABASE_URL")
        self.collection_name = collection_name
        self.embedding_function = embedding_function
        # Existing application code calls vector_db._collection.update(...).
        self._collection = self
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with connect() as database:
            database.execute("CREATE EXTENSION IF NOT EXISTS vector")
            database.execute(
                f"""
                CREATE TABLE IF NOT EXISTS vector_documents (
                    vector_id TEXT PRIMARY KEY,
                    collection_name TEXT NOT NULL,
                    document TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                    embedding vector({EMBEDDING_DIMENSIONS}) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            database.execute(
                "CREATE INDEX IF NOT EXISTS idx_vector_documents_collection "
                "ON vector_documents(collection_name)"
            )

    def add_texts(self, texts, metadatas=None, ids=None, **kwargs):
        texts = [str(text) for text in texts]
        metadatas = list(metadatas or ({} for _ in texts))
        ids = list(ids or (str(uuid.uuid4()) for _ in texts))
        if not texts:
            return []
        embeddings = self.embedding_function.embed_documents(texts)
        with connect() as database:
            for vector_id, document, metadata, embedding in zip(ids, texts, metadatas, embeddings):
                database.execute(
                    """
                    INSERT INTO vector_documents
                        (vector_id, collection_name, document, metadata, embedding)
                    VALUES (?, ?, ?, ?::jsonb, ?::vector)
                    ON CONFLICT(vector_id) DO UPDATE SET
                        collection_name=excluded.collection_name,
                        document=excluded.document,
                        metadata=excluded.metadata,
                        embedding=excluded.embedding
                    """,
                    (
                        vector_id,
                        self.collection_name,
                        document,
                        json.dumps(metadata or {}),
                        _vector_literal(embedding),
                    ),
                )
        return ids

    def add_documents(self, documents, ids=None, **kwargs):
        return self.add_texts(
            [document.page_content for document in documents],
            [document.metadata for document in documents],
            ids=ids,
        )

    def similarity_search_with_score(self, query, k=4, filter=None, **kwargs):
        query_vector = _vector_literal(self.embedding_function.embed_query(query))
        with connect() as database:
            rows = database.execute(
                """
                SELECT document, metadata, embedding <=> ?::vector AS distance
                FROM vector_documents
                WHERE collection_name=?
                ORDER BY embedding <=> ?::vector
                """,
                (query_vector, self.collection_name, query_vector),
            ).fetchall()
        results = []
        for row in rows:
            metadata = _metadata(row["metadata"])
            if metadata_matches(metadata, filter):
                results.append(
                    (Document(page_content=row["document"], metadata=metadata), float(row["distance"]))
                )
                if len(results) >= int(k):
                    break
        return results

    def get(self, where=None, **kwargs):
        with connect() as database:
            rows = database.execute(
                """
                SELECT vector_id, document, metadata
                FROM vector_documents
                WHERE collection_name=?
                ORDER BY created_at, vector_id
                """,
                (self.collection_name,),
            ).fetchall()
        selected = []
        for row in rows:
            metadata = _metadata(row["metadata"])
            if metadata_matches(metadata, where):
                selected.append((row, metadata))
        return {
            "ids": [row["vector_id"] for row, _ in selected],
            "documents": [row["document"] for row, _ in selected],
            "metadatas": [metadata for _, metadata in selected],
        }

    def update(self, ids, metadatas=None, documents=None, **kwargs):
        metadatas = list(metadatas or [])
        documents = list(documents or [])
        with connect() as database:
            for index, vector_id in enumerate(ids):
                if index < len(metadatas):
                    database.execute(
                        "UPDATE vector_documents SET metadata=?::jsonb "
                        "WHERE vector_id=? AND collection_name=?",
                        (json.dumps(metadatas[index] or {}), vector_id, self.collection_name),
                    )
                if index < len(documents):
                    embedding = self.embedding_function.embed_query(documents[index])
                    database.execute(
                        "UPDATE vector_documents SET document=?, embedding=?::vector "
                        "WHERE vector_id=? AND collection_name=?",
                        (documents[index], _vector_literal(embedding), vector_id, self.collection_name),
                    )

    def delete(self, ids=None, **kwargs):
        ids = list(ids or [])
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        with connect() as database:
            database.execute(
                f"DELETE FROM vector_documents WHERE collection_name=? "
                f"AND vector_id IN ({placeholders})",
                (self.collection_name, *ids),
            )

    def count(self):
        with connect() as database:
            row = database.execute(
                "SELECT COUNT(*) AS total FROM vector_documents WHERE collection_name=?",
                (self.collection_name,),
            ).fetchone()
        return int(row["total"])

    def persist(self):
        return None
