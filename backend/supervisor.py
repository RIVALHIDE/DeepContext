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
from acl_security import acl_metadata, normalize_acl_entries

class Supervisor:
    def __init__(self):
        self.engine = DeepContextEngine()
        self.ingest = DataIngestor()
        self.meeting_ai = MeetingAgent() # Initialize once

    def _supersede_existing_document(self, vector_db, file_name: str, workspace_id: str) -> tuple[str, int]:
        deleted_count = delete_chunks_for_source(vector_db, file_name, workspace_id)
        document_id, new_version = prepare_supersede(file_name, workspace_id)
        if deleted_count:
            print(
                f"♻️ [VERSION] Superseded document | deleted_chunks={deleted_count} | "
                f"next_version={new_version}"
            )
        else:
            print(f"🆕 [VERSION] First ingest | version={new_version}")
        return document_id, new_version

    def _register_indexed_chunks(
        self,
        vector_db,
        file_name: str,
        document_id: str,
        version: int,
        ingested_at: str,
        workspace_id: str,
        acl_entries,
    ) -> list[str]:
        chunk_ids = collect_chunk_ids_for_version(
            vector_db,
            file_name,
            workspace_id=workspace_id,
            version=version,
            ingested_at=ingested_at,
        )
        upsert_document(
            document_id=document_id,
            source_name=file_name,
            workspace_id=workspace_id,
            current_version=version,
            chunk_ids=chunk_ids,
            ingested_at=ingested_at,
            status="active",
            acl_entries=acl_entries,
        )
        return chunk_ids
        
    def supervisor(
        self,
        file_path: str,
        job_id: str | None = None,
        team_id: str = "default",
        access_level: float = 0,
        uploader_id: str = "",
        uploader_name: str = "",
        uploader_team: str = "",
        acl_entries=None,
    ):
        file_name = os.path.basename(file_path).lower()
        vector_db = self.engine.get_vector_db(refresh=True)
        ingested_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        acl_tokens = normalize_acl_entries(acl_entries)
        chunk_acl_metadata = acl_metadata(acl_tokens)
        
        # --- BRANCH 1: MEETING FATIGUE LOGIC ---
        if "meeting" in file_name or "transcript" in file_name:
            print("🎙️ [MODE: MEETING] Analyzing transcript")
            
            docs = self.ingest.ingestion_documents(file_path, job_id=job_id)
            if not docs:
                raise RuntimeError("No content extracted from meeting file")
            full_text = " ".join([d.page_content for d in docs])

            if job_id:
                publish(
                    job_id,
                    "extracting",
                    "Analyzing meeting transcript",
                    file_name=file_name,
                )
            
            summary_report = self.meeting_ai.analyze_transcript_text(full_text)
            document_id, version = self._supersede_existing_document(vector_db, file_name, team_id)

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
                    "uploader_id": uploader_id,
                    "uploader_name": uploader_name,
                    "uploader_team": uploader_team,
                    **chunk_acl_metadata,
                }]
            )
            
            self.engine._try_persist()
            chunk_ids = self._register_indexed_chunks(
                vector_db,
                file_name,
                document_id,
                version,
                ingested_at,
                team_id,
                acl_tokens,
            )
            print(
                f"📦 [WRITE] Meeting summary stored | version={version} | chunks={len(chunk_ids)}"
            )
            print(f"✅ [SUCCESS] Meeting summary saved to ChromaDB.")
            return "Meeting Processed"

        # --- BRANCH 2: STANDARD AUDIT LOGIC (Your existing code) ---
        else:
            print("🚀 [MODE: AUDIT] Starting High-Speed Audit")
            new_chunks = self.ingest.ingestion_documents(file_path, job_id=job_id)
            if not new_chunks:
                raise RuntimeError("No content extracted from file")

            document_id, version = self._supersede_existing_document(vector_db, file_name, team_id)

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
                        "uploader_id": uploader_id,
                        "uploader_name": uploader_name,
                        "uploader_team": uploader_team,
                        **chunk_acl_metadata,
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
                team_id,
                acl_tokens,
            )
            print(
                f"📦 [WRITE] Audit chunks stored | version={version} | chunks_written={len(chunk_ids)}"
            )
            return processed_chunks
