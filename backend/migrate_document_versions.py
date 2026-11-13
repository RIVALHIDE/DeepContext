#!/usr/bin/env python3
"""One-time or manual cleanup for duplicate Chroma chunks per source_name."""

from database import initDB
from document_registry import migrate_legacy_duplicate_chunks
from rag_engine import DeepContextEngine


def main():
    initDB()
    engine = DeepContextEngine()
    vector_db = engine.get_vector_db(refresh=True)
    result = migrate_legacy_duplicate_chunks(vector_db)
    engine._try_persist()
    print(
        "Migration complete | "
        f"documents_processed={result['documents_processed']} | "
        f"stale_chunks_deleted={result['stale_chunks_deleted']}"
    )


if __name__ == "__main__":
    main()
