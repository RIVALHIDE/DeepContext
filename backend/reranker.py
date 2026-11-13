import os
import time
from typing import Any

from langchain_core.documents import Document


class ChunkReranker:
    def __init__(
        self,
        model_name: str | None = None,
        enabled: bool | None = None,
    ):
        self.enabled = (
            os.getenv("RERANK_ENABLED", "true").lower() == "true"
            if enabled is None
            else enabled
        )
        self.model_name = model_name or os.getenv(
            "RERANK_MODEL",
            "cross-encoder/ms-marco-MiniLM-L-6-v2",
        )
        self.max_chunk_chars = int(os.getenv("RERANK_MAX_CHUNK_CHARS", "1500"))
        self.hf_local_files_only = (
            os.getenv("HUGGINGFACE_LOCAL_FILES_ONLY", "false").lower() == "true"
        )
        self._model = None
        self._load_error: Exception | None = None

    def _load_model(self):
        if self._model is not None:
            return self._model

        if self._load_error is not None:
            return None

        try:
            from sentence_transformers import CrossEncoder

            self._model = CrossEncoder(
                self.model_name,
                device="cpu",
                local_files_only=self.hf_local_files_only,
            )
            print(f"Reranker loaded | model={self.model_name}")
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            self._load_error = exc
            self._model = None
            print(
                "⚠️ Reranker unavailable | "
                f"model={self.model_name} | error={exc}"
            )
        return self._model

    def rerank(
        self,
        query: str,
        documents: list[Document],
        top_k: int,
    ) -> tuple[list[Document], dict[str, Any]]:
        if not documents:
            return [], {"enabled": self.enabled, "latency_ms": 0, "candidate_count": 0}

        if not self.enabled:
            return documents[:top_k], {
                "enabled": False,
                "latency_ms": 0,
                "candidate_count": len(documents),
            }

        model = self._load_model()
        if model is None:
            return documents[:top_k], {
                "enabled": False,
                "latency_ms": 0,
                "candidate_count": len(documents),
                "reason": "model_unavailable",
            }

        pairs = [
            (query, (doc.page_content or "")[: self.max_chunk_chars])
            for doc in documents
        ]

        started = time.perf_counter()
        try:
            scores = model.predict(pairs)
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            print(f"⚠️ Reranker predict failed, falling back to hybrid order: {exc}")
            return documents[:top_k], {
                "enabled": False,
                "latency_ms": (time.perf_counter() - started) * 1000,
                "candidate_count": len(documents),
                "reason": "predict_failed",
            }
        latency_ms = (time.perf_counter() - started) * 1000
        scored_docs = sorted(
            zip(documents, scores),
            key=lambda item: float(item[1]),
            reverse=True,
        )

        # Persist reranker scores into each document's metadata so later
        # components (diversity selector, expansion, logging) can make
        # score-aware decisions.
        for doc, score in scored_docs:
            try:
                meta = (doc.metadata or {})
                # Make a shallow copy to avoid mutating shared references
                new_meta = dict(meta)
                new_meta["rerank_score"] = float(score)
                doc.metadata = new_meta
            except Exception:
                # Be defensive; if metadata can't be set, continue
                pass

        reranked = [doc for doc, _ in scored_docs[:top_k]]

        preview = [
            {
                "source": (doc.metadata or {}).get("source_name", "unknown"),
                "score": round(float((doc.metadata or {}).get("rerank_score", 0.0)), 4),
                "preview": (
                    (doc.metadata or {}).get("raw_text_preview")
                    or (doc.page_content or "")
                )[:80].replace("\n", " "),
            }
            for doc in reranked
        ]

        return reranked, {
            "enabled": True,
            "latency_ms": latency_ms,
            "candidate_count": len(documents),
            "top_preview": preview,
        }