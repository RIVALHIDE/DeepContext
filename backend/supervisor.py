import os
from datetime import datetime
from meeting_agent import MeetingAgent
from ingestor import DataIngestor
from ingest_progress import publish
from document_registry import (
    collect_chunk_ids_for_version,
    delete_chunks_for_source,
    prepare_supersede,
    upsert_document,
)
from rag_engine import DeepContextEngine

class Supervisor:
    def __init__(self):
        self.engine = DeepContextEngine()
        self.ingest = DataIngestor()
        self.meeting_ai = MeetingAgent() # Initialize once

    def _supersede_existing_document(self, vector_db, file_name: str) -> tuple[str, int]:
        deleted_count = delete_chunks_for_source(vector_db, file_name)
        document_id, new_version = prepare_supersede(file_name)
        if deleted_count:
            print(
                f"♻️ [VERSION] Superseded {file_name} | deleted_chunks={deleted_count} | "
                f"next_version={new_version}"
            )
        else:
            print(f"🆕 [VERSION] First ingest for source  {file_name} | version={new_version}")
        return document_id, new_version

    def _register_indexed_chunks(
        self,
        vector_db,
        file_name: str,
        document_id: str,
        version: int,
        ingested_at: str,
    ) -> list[str]:
        chunk_ids = collect_chunk_ids_for_version(
            vector_db,
            file_name,
            version=version,
            ingested_at=ingested_at,
        )
        upsert_document(
            document_id=document_id,
            source_name=file_name,
            current_version=version,
            chunk_ids=chunk_ids,
            ingested_at=ingested_at,
            status="active",
        )
        return chunk_ids
        
    def supervisor(self, file_path: str, job_id: str | None = None, team_id: str = "default", access_level: int = 0):
        file_name = os.path.basename(file_path).lower()
        vector_db = self.engine.get_vector_db(refresh=True)
        ingested_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # --- BRANCH 1: MEETING FATIGUE LOGIC ---
        if "meeting" in file_name or "transcript" in file_name:
            print(f"🎙️ [MODE: MEETING] Analyzing transcript: {file_name}")
            
            docs = self.ingest.ingestion_documents(file_path, job_id=job_id)
            if not docs:
                raise RuntimeError(f"No content extracted from meeting file: {file_name}")
            full_text = " ".join([d.page_content for d in docs])

            if job_id:
                publish(
                    job_id,
                    "extracting",
                    "Analyzing meeting transcript",
                    file_name=file_name,
                )
            
            summary_report = self.meeting_ai.analyze_transcript_text(full_text)
            document_id, version = self._supersede_existing_document(vector_db, file_name)

            if job_id:
                publish(
                    job_id,
                    "indexing",
                    "Saving meeting summary to knowledge base",
                    file_name=file_name,
                )

            vector_db.add_texts(
                texts=[summary_report],
                metadatas=[{
                    "type": "meeting_summary", 
                    "source_name": file_name,
                    "document_id": document_id,
                    "version": version,
                    "ingested_at": ingested_at,
                    "status": "verified",
                    "team_id": team_id,
                    "access_level": access_level,
                }]
            )
            
            self.engine._try_persist()
            chunk_ids = self._register_indexed_chunks(
                vector_db,
                file_name,
                document_id,
                version,
                ingested_at,
            )
            print(
                f"📦 [WRITE] Meeting summary stored | version={version} | chunks={len(chunk_ids)} | "
                f"source={file_name}"
            )
            print(f"✅ [SUCCESS] Meeting summary saved to ChromaDB.")
            return "Meeting Processed"

        # --- BRANCH 2: STANDARD AUDIT LOGIC (Your existing code) ---
        else:
            print(f"🚀 [MODE: AUDIT] Starting High-Speed Audit: {file_name}")
            new_chunks = self.ingest.ingestion_documents(file_path, job_id=job_id)
            if not new_chunks:
                raise RuntimeError(f"No content extracted from file: {file_name}")

            document_id, version = self._supersede_existing_document(vector_db, file_name)

            batch_size = 20  
            processed_chunks = []
            
            for i in range(0, len(new_chunks), batch_size):
                current_batch = new_chunks[i : i + batch_size]
                for chunk in current_batch:
                    chunk.metadata.update({
                        "source_name": file_name,
                        "document_id": document_id,
                        "version": version,
                        "ingested_at": ingested_at,
                        "status": "verified",
                        "team_id": team_id,
                        "access_level": access_level,
                    })
                    processed_chunks.append(chunk)

            if job_id:
                publish(
                    job_id,
                    "indexing",
                    f"Writing {len(processed_chunks)} chunks to ChromaDB",
                    file_name=file_name,
                    chunk_count=len(processed_chunks),
                )

            vector_db.add_documents(processed_chunks)
            self.engine._try_persist()
            chunk_ids = self._register_indexed_chunks(
                vector_db,
                file_name,
                document_id,
                version,
                ingested_at,
            )
            print(
                f"📦 [WRITE] Audit chunks stored | version={version} | chunks_written={len(chunk_ids)} | "
                f"source={file_name}"
            )
            return processed_chunks
