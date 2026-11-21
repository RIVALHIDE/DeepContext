import os
import re
import numpy as np
from rank_bm25 import BM25Okapi
from typing import List, TypedDict, Optional, Annotated
import json
import operator
from functools import lru_cache
from langchain_chroma import Chroma
from chromadb.config import System
from chromadb.telemetry.product import ProductTelemetryClient, ProductTelemetryEvent
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_groq import ChatGroq
from access_policy import retrieval_filter
from acl_security import record_retrieval_audit
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.prompts import MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.documents import Document
from langgraph.graph import StateGraph, END
from dotenv import load_dotenv
from ingestor import DataIngestor
from overrides import override
from diagram_utils import detect_diagram_request_type, extract_diagrams_from_docs
from diagram_flow_parser import diagrams_to_flow
from chroma_health import (
    build_chroma_client,
    ensure_collection,
    get_chroma_settings,
    wait_for_chroma,
)
from reranker import ChunkReranker
from postgres_vector_store import PostgresVectorStore

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(CURRENT_DIR, ".env"))

# Simple console logging via print statements (no logger)

# Simple in-memory metrics for observability (exports/logging only)
metrics: dict = {
    "rerank_calls": 0,
    "diversity_selections": 0,
    "expansions_per_query": 0,
}


class NoOpProductTelemetry(ProductTelemetryClient):
    """Disable Chroma product telemetry to avoid noisy startup/runtime errors."""

    def __init__(self, system: System):
        super().__init__(system)

    @override
    def capture(self, event: ProductTelemetryEvent) -> None:
        return None

# Known garbage patterns produced by broken contextualize LLM calls
_GARBAGE_PATTERNS = [
    "omerang", "boomerang", "Question:", "question:", 
    "standalone question", "Standalone question"
]

_SMALL_TALK_RESPONSES = {
    "greeting": "Hello! I can help you with questions about your uploaded documents. Ask me anything from the knowledge base.",
    "thanks": "You're welcome. If you need anything from the uploaded documents, ask away.",
    "farewell": "Goodbye! Come back anytime if you want help with the knowledge base.",
    "assistant_help": "I can answer questions using your uploaded documents, summarize relevant information, and help you find specific details from the knowledge base.",
}

_GREETING_PHRASES = {
    "hello",
    "hi",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
}

_THANKS_PHRASES = {
    "thanks",
    "thank you",
    "thx",
    "thanks a lot",
    "thank you so much",
}

_FAREWELL_PHRASES = {
    "bye",
    "goodbye",
    "see you",
    "see you later",
}

_ASSISTANT_HELP_PHRASES = {
    "help",
    "what can you do",
    "how can you help",
    "what do you do",
}

def _is_garbage(text: str) -> bool:
    """Returns True if the standalone_q looks like LLM hallucination/garbage."""
    if not text or len(text.strip()) < 8:
        return True
    for pattern in _GARBAGE_PATTERNS:
        if pattern.lower() in text.lower():
            return True
    # Path-like or repo file spam (common garbage mode)
    slash_count = text.count("/") + text.count("\\")
    if len(text) > 200 and slash_count > 4:
        return True
    # Highly repetitive token soup
    tokens = re.findall(r"[A-Za-z0-9_.-]+", text)
    if len(tokens) >= 30:
        unique_ratio = len(set(tokens)) / len(tokens)
        if unique_ratio < 0.35:
            return True
        most_common_ratio = max(tokens.count(t) for t in set(tokens)) / len(tokens)
        if most_common_ratio > 0.2:
            return True
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) >= 8 and (len(set(lines)) / len(lines)) < 0.4:
        return True
    return False


def _extract_answer_text(answer_obj) -> str:
    """
    Normalize LangChain/Groq outputs to a plain string for storage + API response.
    """
    if isinstance(answer_obj, str):
        return answer_obj.strip()
    # LangChain BaseMessage (e.g., AIMessage)
    content = getattr(answer_obj, "content", None)
    if isinstance(content, str):
        return content.strip()
    # Some chains return dicts
    if isinstance(answer_obj, dict):
        for key in ("answer", "output_text", "content", "text"):
            val = answer_obj.get(key)
            if isinstance(val, str):
                return val.strip()
    return str(answer_obj).strip()


def _normalize_markdown_answer(text: str) -> str:
    """
    Preserve markdown structures while cleaning up excessive spacing in prose.
    """
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return ""

    segments = re.split(r"(```[\s\S]*?```)", normalized)
    cleaned_segments = []

    for segment in segments:
        if not segment:
            continue
        if segment.startswith("```") and segment.endswith("```"):
            cleaned_segments.append(segment.strip())
            continue

        cleaned_segments.append(re.sub(r"\n{3,}", "\n\n", segment).strip("\n"))

    return "\n\n".join(part for part in cleaned_segments if part)


def _extract_history_item(item):
    if isinstance(item, dict):
        return item.get("role"), item.get("content")
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        return item[0], item[1]
    return None, None

def _normalize_user_text(text: str) -> str:
    lowered = str(text or "").lower().strip()
    lowered = re.sub(r"[^\w\s]", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def _merge_diagram_request_type(raw_type, standalone_type):
    priority = {
        None: 0,
        "all": 1,
        "mermaid": 2,
        "plantuml": 2,
    }
    if priority.get(standalone_type, 0) > priority.get(raw_type, 0):
        return standalone_type
    return raw_type


def _filter_diagrams_by_type(diagrams: list, requested_type):
    if requested_type in (None, "all"):
        return diagrams
    return [diagram for diagram in diagrams if diagram.get("type") == requested_type]


_DIAGRAM_QUERY_STOPWORDS = {
    "show", "me", "the", "a", "an", "for", "of", "to", "please", "diagram",
    "flow", "chart", "render", "display", "give", "with", "and", "that",
    "this", "plantuml", "puml", "uml", "mermaid", "sequence", "architecture",
}


def _title_match_tokens(text: str) -> set[str]:
    tokens = re.findall(r"[a-z0-9]+", str(text or "").lower())
    return {
        token for token in tokens
        if len(token) > 2 and token not in _DIAGRAM_QUERY_STOPWORDS
    }


def _diagram_match_tokens(diagram: dict) -> set[str]:
    tokens = _title_match_tokens(diagram.get("title", ""))
    tokens |= _title_match_tokens(diagram.get("code", ""))
    return tokens


def _filter_diagrams_by_title_match(diagrams: list, *queries: str):
    query_tokens = set()
    for query in queries:
        query_tokens |= _title_match_tokens(query)

    if not query_tokens:
        return diagrams

    if len(diagrams) == 1:
        diagram = diagrams[0]
        return diagrams if (query_tokens & _diagram_match_tokens(diagram)) else []

    scored = []
    for diagram in diagrams:
        score = len(query_tokens & _diagram_match_tokens(diagram))
        scored.append((score, diagram))

    best_score = max((score for score, _ in scored), default=0)
    if best_score <= 0:
        return []

    best_diagrams = [diagram for score, diagram in scored if score == best_score]
    if len(best_diagrams) == len(diagrams):
        return diagrams

    return best_diagrams


def _filter_diagram_docs_by_selected(diagram_docs: List[Document], selected_diagrams: list):
    selected_keys = {
        (
            diagram.get("sourceName"),
            diagram.get("type"),
            diagram.get("title"),
            diagram.get("diagramIndex"),
        )
        for diagram in selected_diagrams
    }
    return [
        doc for doc in diagram_docs
        if (
            (getattr(doc, "metadata", {}) or {}).get("source_name"),
            (getattr(doc, "metadata", {}) or {}).get("content_type"),
            (getattr(doc, "metadata", {}) or {}).get("diagram_title"),
            (getattr(doc, "metadata", {}) or {}).get("diagram_index"),
        ) in selected_keys
    ]


def _detect_small_talk_intent(text: str) -> str | None:
    normalized = _normalize_user_text(text)
    if not normalized:
        return None

    tokens = normalized.split()
    if len(tokens) > 6:
        return None

    if normalized in _GREETING_PHRASES:
        return "greeting"
    if normalized in _THANKS_PHRASES:
        return "thanks"
    if normalized in _FAREWELL_PHRASES:
        return "farewell"
    if normalized in _ASSISTANT_HELP_PHRASES:
        return "assistant_help"

    # Allow a very small near-exact greeting surface such as "hi there".
    if len(tokens) == 2 and tokens[0] in {"hello", "hi", "hey"} and tokens[1] in {"there", "team", "assistant"}:
        return "greeting"

    return None


# ── LangGraph State ──────────────────────────────────────────────────────────

class RAGState(TypedDict):
    """State object passed between LangGraph nodes."""
    question: str
    standalone_question: str
    user_team: str
    selected_sources: List[str]
    chat_history: List
    intent: str               # "small_talk" | "question" | "diagram" | "no_docs"
    retrieved_docs: List
    primary_sources: set
    context_block: str
    draft_answer: str
    reflection_passed: bool
    reflection_feedback: str
    retry_count: int
    final_answer: str
    diagrams: list
    sources: list
    citation_names: list
    token_usage: dict
    mode: str


MAX_REFLECTION_RETRIES = 2


@lru_cache(maxsize=2)
def _shared_embeddings(local_files_only: bool):
    """Load one embedding model per process, including eager ingestion."""
    return HuggingFaceEmbeddings(
        model_name="sentence-transformers/all-MiniLM-L6-v2",
        model_kwargs={"device": "cpu", "local_files_only": local_files_only},
        encode_kwargs={"normalize_embeddings": False},
        cache_folder=os.path.expanduser("~/.cache/huggingface/hub"),
    )


class DeepContextEngine:
    def __init__(self):
        # Allow the model to download into the shared cache on first boot, then
        # optionally switch back to cache-only mode for offline runs.
        self.hf_local_files_only = os.getenv("HUGGINGFACE_LOCAL_FILES_ONLY", "false").lower() == "true"
        self.embeddings = _shared_embeddings(self.hf_local_files_only)

        self.db_path = os.path.join(CURRENT_DIR, "chroma_db")
        chroma_cfg = get_chroma_settings()
        self.collection_name = chroma_cfg["collection_name"]
        self.chroma_host = chroma_cfg["host"]
        self.chroma_port = chroma_cfg["port"]
        self.chroma_ssl = chroma_cfg["ssl"]

        self.vector_db = self._create_vector_db()

        self.llm = ChatGroq(
            temperature=0,
            model_name=os.getenv("GROQ_CHAT_MODEL", "openai/gpt-oss-20b"),
            groq_api_key=os.getenv("GROQ_API_KEY"),
            streaming=True,        # added to enable streaming tokens
        )
        self.reranker = ChunkReranker()

    def _retrieval_settings(self) -> dict:
        return {
            "semantic_k": int(os.getenv("RETRIEVAL_SEMANTIC_K", "20")),
            "bm25_k": int(os.getenv("RETRIEVAL_BM25_K", "20")),
            "candidate_k": int(os.getenv("RERANK_CANDIDATE_K", "20")),
            "top_k": int(os.getenv("RERANK_TOP_K", "5")),
            "semantic_distance_max": float(
                os.getenv("RETRIEVAL_SEMANTIC_DISTANCE_MAX", "6.2")
            ),
        }

    @staticmethod
    def _doc_key(doc: Document, fallback_text: str | None = None) -> str:
        meta = getattr(doc, "metadata", {}) or {}
        source_name = meta.get("source_name") or meta.get("source") or "unknown"
        chunk_index = meta.get("chunk_index")
        preview_source = meta.get("raw_text_preview")
        if not preview_source:
            preview_source = fallback_text if fallback_text is not None else doc.page_content
        preview = str(preview_source or "")[:120]
        return f"{source_name}::{chunk_index if chunk_index is not None else 'na'}::{preview}"

    @staticmethod
    def _doc_preview(doc: Document, fallback_text: str | None = None, limit: int = 120) -> str:
        meta = getattr(doc, "metadata", {}) or {}
        preview_source = meta.get("raw_text_preview")
        if not preview_source:
            preview_source = fallback_text if fallback_text is not None else doc.page_content
        return str(preview_source or "")[:limit].replace("\n", " ")

    @staticmethod
    def _display_source_name(source_name: str, metadata: dict | None = None) -> str:
        """Hide the workspace storage prefix while preserving the auth key."""
        value = os.path.basename(str(source_name or "unknown"))
        team_id = str((metadata or {}).get("team_id") or "")
        prefix = f"{team_id}__" if team_id else ""
        if prefix and value.casefold().startswith(prefix.casefold()):
            return value[len(prefix):]
        # Compatibility for chunks created before team_id was consistently
        # present. Workspace IDs are opaque hex/UUID-like values.
        head, separator, tail = value.partition("__")
        if separator and len(head) >= 16 and all(char in "0123456789abcdef-" for char in head.casefold()):
            return tail
        return value

    
    @staticmethod
    def _build_sources_list(docs: List[Document], primary_source_names: set | None = None) -> list:
        """
        Build a deduplicated sources list grouped by source_name, ordered by
        relevance (max rerank_score). Only sources in `primary_source_names`
        (the genuinely-selected, non-forced-diversity sources) are included,
        so files that were merely pulled in for context/diversity don't show
        up as citations.
        """
        groups: dict[str, list[Document]] = {}
        for doc in docs:
            meta = getattr(doc, "metadata", {}) or {}
            src = meta.get("source_name") or "unknown"
            if primary_source_names and src not in primary_source_names:
                continue
            groups.setdefault(src, []).append(doc)

        # Safety net: never return an empty panel if filtering removed everything
        if not groups:
            for doc in docs:
                meta = getattr(doc, "metadata", {}) or {}
                src = meta.get("source_name") or "unknown"
                groups.setdefault(src, []).append(doc)

        def _group_score(group_docs):
            return max(
                float((getattr(d, "metadata", {}) or {}).get("rerank_score", 0.0))
                for d in group_docs
            )

        ordered = sorted(groups.items(), key=lambda item: _group_score(item[1]), reverse=True)

        sources = []
        for idx, (source_name, group_docs) in enumerate(ordered, start=1):
            first = group_docs[0]
            first_meta = getattr(first, "metadata", {}) or {}
            preview = (getattr(first, "page_content", "") or "")[:300].replace("\n", " ").strip()

            chunk_indices = []
            for d in group_docs:
                m = getattr(d, "metadata", {}) or {}
                ci = m.get("chunk_index")
                if ci is not None:
                    chunk_indices.append(ci)
            chunk_indices = sorted(set(chunk_indices))

            sources.append({
                "index": idx,
                "sourceName": source_name,
                "displayName": DeepContextEngine._display_source_name(source_name, first_meta),
                "page": first_meta.get("page"),
                "chunkIndex": first_meta.get("chunk_index"),
                "preview": preview,
                "chunk_count": len(group_docs),
                "chunk_indices": chunk_indices,
                "_uploader_id": first_meta.get("uploader_id"),
                "_uploader_name": first_meta.get("uploader_name"),
                "_uploader_team": first_meta.get("uploader_team"),
            })

        return sources
    
    
    @staticmethod
    def _render_context_docs(docs: List[Document]) -> str:
        rendered = []
        for index, doc in enumerate(docs, start=1):
            meta = getattr(doc, "metadata", {}) or {}
            source_name = meta.get("source_name", "unknown")
            page = meta.get("page", "unknown")
            chunk_index = meta.get("chunk_index", "unknown")
            rendered.append(
                f"[Chunk {index} | source={source_name} | page={page} | chunk={chunk_index}]\n"
                f"{doc.page_content}"
            )
        return "\n\n".join(rendered)
    
    @staticmethod
    def _relative_threshold(best_score: float, ratio: float) -> float:
        """
        Returns a threshold that is `ratio` of the way from 0 to `best_score`,
        regardless of sign. For positive best_score this equals best_score * ratio
        (old behavior). For negative best_score (cross-encoder logits), it correctly
        produces a threshold LESS extreme than best_score, e.g.
        best_score=-7.79, ratio=0.85 -> threshold ≈ -8.96 (not -6.62).
        """
        if best_score == 0:
            return 0.0
        return best_score - abs(best_score) * (1 - ratio)

    def _normalize_chat_history(self, chat_history: List):
        """
        Converts raw SQLite tuples → LangChain message objects.
        Skips any AI message that looks like garbage from old broken responses.
        """
        if not chat_history:
            return []

        result = []
        for item in chat_history[-6:]:
            role, content = _extract_history_item(item)
            if role is None:
                continue
            # ✅ Skip old garbage AI responses so they don't poison the context
            if role == "ai" and _is_garbage(content):
                print("⚠️ Skipping one invalid history entry")
                continue
            if role == "human":
                result.append(HumanMessage(content=content))
            elif role == "ai":
                result.append(AIMessage(content=content))

        return result
    
    def _hybrid_search_candidates(
        self,
        query: str,
        candidate_k: int | None = None,
        team_id: str = None,
        source_names: List[str] | None = None,
    ) -> List[Document]:
        """
        First-stage hybrid retrieval: semantic + BM25 fused with RRF.
        Returns a wider candidate pool for cross-encoder reranking.

        When team_id is provided (and not "default"), applies a ChromaDB
        where-filter so only documents belonging to that team are retrieved
        (Role-Based Access Control).
        """
        settings = self._retrieval_settings()
        candidate_k = candidate_k or settings["candidate_k"]
        semantic_k = settings["semantic_k"]
        bm25_k = settings["bm25_k"]
        distance_max = settings["semantic_distance_max"]

        # RBAC filter: only restrict when a non-default team is specified
        chroma_filter = retrieval_filter(team_id, source_names)

        semantic_results = self.vector_db.similarity_search_with_score(
            query, k=semantic_k, filter=chroma_filter
        )
        semantic_docs = [
            (doc, score) for doc, score in semantic_results if score < distance_max
        ]

        all_dept_data = self.vector_db.get(where=chroma_filter)
        all_texts = all_dept_data.get("documents", [])
        all_metadatas = all_dept_data.get("metadatas", [])

        if not all_texts:
            print(f"⚠️ No docs for BM25, falling back to semantic only. semantic_count={len(semantic_docs)}")
            return [doc for doc, _ in semantic_docs[:candidate_k]]

        tokenized_corpus = [text.lower().split() for text in all_texts]
        bm25 = BM25Okapi(tokenized_corpus)

        tokenized_query = query.lower().split()
        bm25_scores = bm25.get_scores(tokenized_query)
        top_bm25_idx = np.argsort(bm25_scores)[::-1][:bm25_k]

        rrf_k = 60
        rrf_scores: dict[str, float] = {}
        doc_store: dict[str, Document] = {}

        for rank, (doc, _) in enumerate(semantic_docs):
            key = self._doc_key(doc)
            rrf_scores[key] = rrf_scores.get(key, 0.0) + 1.0 / (rrf_k + rank + 1)
            doc_store[key] = doc

        for rank, idx in enumerate(top_bm25_idx):
            if bm25_scores[idx] <= 0:
                continue
            text = all_texts[idx]
            meta = all_metadatas[idx] if idx < len(all_metadatas) else {}
            key = self._doc_key(
                Document(page_content=text, metadata=meta),
                fallback_text=text,
            )
            rrf_scores[key] = rrf_scores.get(key, 0.0) + 1.0 / (rrf_k + rank + 1)
            if key not in doc_store:
                doc_store[key] = Document(page_content=text, metadata=meta)

        ranked_keys = sorted(rrf_scores, key=lambda x: rrf_scores[x], reverse=True)
        candidates = [doc_store[key] for key in ranked_keys if key in doc_store]
        if not candidates and source_names:
            # An explicit @file selection is itself strong retrieval intent.
            # Broad prompts such as "summarize this" can miss the semantic
            # distance threshold, so let the reranker inspect selected chunks.
            grouped: dict[str, list[Document]] = {}
            for text, meta in zip(all_texts, all_metadatas):
                grouped.setdefault(str(meta.get("source_name", "")), []).append(
                    Document(page_content=text, metadata=meta)
                )
            candidates = []
            offset = 0
            while len(candidates) < candidate_k:
                added = False
                for source in source_names:
                    chunks = grouped.get(str(source).casefold(), [])
                    if offset < len(chunks):
                        candidates.append(chunks[offset])
                        added = True
                        if len(candidates) >= candidate_k:
                            break
                if not added:
                    break
                offset += 1
            print(
                f"📎 Explicit file fallback | sources={len(source_names)} | "
                f"candidates={len(candidates)}"
            )
        print(
            f"🔎 Hybrid candidates | semantic={len(semantic_docs)} | "
            f"bm25_hits={sum(1 for i in top_bm25_idx if bm25_scores[i] > 0)} | "
            f"fused={len(candidates[:candidate_k])}"
        )
        return candidates[:candidate_k]
    

    def _rerank_documents(
        self,
        query: str,
        documents: List[Document],
        top_k: int,
    ) -> tuple[list[Document], dict]:
        return self.reranker.rerank(query, documents, top_k=top_k)

    def _expand_sibling_chunks(
        self,
        ranked_docs: List[Document],
        k: int,
        team_id: str = None,
        source_names: List[str] | None = None,
    ):
        if not ranked_docs:
            return [], set()

        chroma_filter = retrieval_filter(team_id, source_names)
        all_dept_data = self.vector_db.get(where=chroma_filter)
        all_texts = all_dept_data.get("documents", [])
        all_metadatas = all_dept_data.get("metadatas", [])

        try:
            MAX_PER_SOURCE = int(os.getenv("SOURCE_DIVERSITY_MAX_PER_SOURCE", "2"))
        except Exception:
            MAX_PER_SOURCE = 2
        try:
            THRESHOLD_RATIO = float(os.getenv("SOURCE_DIVERSITY_THRESHOLD_RATIO", "0.85"))
        except Exception:
            THRESHOLD_RATIO = 0.85

        MIN_UNIQUE_SOURCES = int(os.getenv("SOURCE_DIVERSITY_MIN_UNIQUE_SOURCES", "2"))
        SECONDARY_SOURCE_RATIO = float(os.getenv("SOURCE_DIVERSITY_SECONDARY_RATIO", "0.75"))

        scores = [float((getattr(d, "metadata", {}) or {}).get("rerank_score", 0.0)) for d in ranked_docs]
        best_score = max(scores) if scores else 0.0
        threshold = self._relative_threshold(best_score, THRESHOLD_RATIO) if best_score != 0 else 0.0

        # Phase 1: Source Diversity Selection (genuinely relevant chunks)
        selected: list[Document] = []
        per_source_counts: dict[str, int] = {}
        for doc in ranked_docs:
            meta = (getattr(doc, "metadata", {}) or {})
            src = meta.get("source_name") or "unknown"
            score = float(meta.get("rerank_score", 0.0))
            if score < threshold:
                continue
            if per_source_counts.get(src, 0) >= MAX_PER_SOURCE:
                continue
            selected.append(doc)
            per_source_counts[src] = per_source_counts.get(src, 0) + 1

        if not selected:
            selected = ranked_docs[:k]

        # 🔑 Capture the GENUINELY relevant sources BEFORE any forced-diversity injection.
        # These are the only ones that should ever appear as "citations".
        primary_source_names = {
            (getattr(doc, "metadata", {}) or {}).get("source_name")
            for doc in selected
        }
        primary_source_names.discard(None)

        selected_sources = set(primary_source_names)

        if len(selected_sources) < MIN_UNIQUE_SOURCES:
            secondary_threshold = self._relative_threshold(best_score, SECONDARY_SOURCE_RATIO)

            for doc in ranked_docs:
                meta = (getattr(doc, "metadata", {}) or {})
                source = meta.get("source_name")

                if source in selected_sources:
                    continue

                score = float(meta.get("rerank_score", 0.0))
                if score < secondary_threshold:
                    continue

                selected.append(doc)
                selected_sources.add(source)
                # NOTE: intentionally NOT added to primary_source_names —
                # this is a "for context" addition, not a real citation.

                print("🧭 Forced diversity added one context-only source")

                if len(selected_sources) >= MIN_UNIQUE_SOURCES:
                    break

        # Build index map for neighbor lookup per source
        source_index_map: dict[str, dict[int, Document]] = {}
        for text, meta in zip(all_texts, all_metadatas):
            if not isinstance(meta, dict):
                continue
            src = meta.get("source_name")
            ci = meta.get("chunk_index")
            if src is None or ci is None:
                continue
            source_index_map.setdefault(src, {})[int(ci)] = Document(page_content=text, metadata=meta)

        # Phase 2: Neighbor expansion
        expanded: list[Document] = []
        seen_keys: set[str] = set()

        def _add_doc(doc: Document):
            key = self._doc_key(doc)
            if key in seen_keys:
                return False
            expanded.append(doc)
            seen_keys.add(key)
            return True

        for sel in selected:
            meta = (getattr(sel, "metadata", {}) or {})
            src = meta.get("source_name")
            ci = meta.get("chunk_index")
            if src is None or ci is None:
                _add_doc(sel)
                continue

            ci = int(ci)
            index_map = source_index_map.get(src, {})
            for neighbor_idx in (ci - 1, ci, ci + 1):
                neighbor_doc = index_map.get(neighbor_idx)
                if neighbor_doc is not None:
                    _add_doc(neighbor_doc)

        if len(expanded) < k:
            for doc in ranked_docs:
                if len(expanded) >= k:
                    break
                _add_doc(doc)

        def _sort_key(d: Document):
            m = (getattr(d, "metadata", {}) or {})
            return (m.get("source_name") or "", int(m.get("chunk_index") or 0))

        final = sorted(expanded, key=_sort_key)

        # (logging blocks unchanged — keep them as-is)

        return final[:k], primary_source_names
    
    def _retrieve_documents(self, query: str, top_k: int | None = None, team_id: str = None, source_names: List[str] | None = None):
        documents, primary_sources = self._hybrid_search(
            query,
            k=top_k or self._retrieval_settings()["top_k"],
            team_id=team_id,
            source_names=source_names,
        )
        record_retrieval_audit(team_id, query, documents)
        return documents, primary_sources

    def _hybrid_search(self, query: str, k: int = 5, team_id: str = None, source_names: List[str] | None = None):
        settings = self._retrieval_settings()
        candidate_k = settings["candidate_k"] if self.reranker.enabled else k
        candidates = self._hybrid_search_candidates(query, candidate_k=candidate_k, team_id=team_id, source_names=source_names)
        if not candidates:
            return [], set()

        if self.reranker.enabled:
            reranked, rerank_meta = self._rerank_documents(query, candidates, top_k=k)
            if rerank_meta.get("enabled"):
                print(
                    f"🎯 Rerank | candidates={rerank_meta['candidate_count']} | "
                    f"latency_ms={rerank_meta['latency_ms']:.0f}"
                )
            else:
                reason = rerank_meta.get("reason", "unknown")
                print(
                    f"🎯 Rerank fallback | candidates={rerank_meta.get('candidate_count', len(candidates))} | "
                    f"reason={reason} | top_k={k}"
                )
        else:
            reranked = candidates[:k]
            print(f"🎯 Rerank disabled | candidates={len(candidates)} | top_k={k}")

        return self._expand_sibling_chunks(reranked, k=k, team_id=team_id, source_names=source_names)

    def _create_vector_db(self):
        """Create the configured local Chroma or cloud pgvector store."""
        if os.getenv("VECTOR_STORE_BACKEND", "chroma").strip().lower() == "postgres":
            return PostgresVectorStore(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
            )
        wait_for_chroma()
        fresh_client = build_chroma_client(
            host=self.chroma_host,
            port=self.chroma_port,
            ssl=self.chroma_ssl,
        )
        ensure_collection(fresh_client, self.collection_name)
        return Chroma(
            client=fresh_client,
            collection_name=self.collection_name,
            embedding_function=self.embeddings
        )

    def _reload_vector_db(self):
        """Recreate the HTTP-backed Chroma handle."""
        self.vector_db = self._create_vector_db()
        return self.vector_db

    def _fetch_diagram_docs_for_sources(
        self,
        vector_db,
        source_names: set[str] | list[str] | None,
        team_id: str = None,
    ) -> List[Document]:
        """Return only caller-visible diagram chunks.

        An empty source list intentionally means "all permitted sources in this
        workspace". The workspace and ACL constraints are still applied inside
        the vector-store query, before any diagram metadata is inspected.
        """
        normalized_sources = {
            str(source).strip().casefold()
            for source in (source_names or [])
            if str(source).strip()
        }
        chroma_filter = retrieval_filter(team_id, normalized_sources or None)
        snapshot = vector_db.get(where=chroma_filter)
        documents = snapshot.get("documents", [])
        metadatas = snapshot.get("metadatas", [])

        diagram_docs = []
        for text, meta in zip(documents, metadatas):
            if not isinstance(meta, dict):
                continue
            if normalized_sources and str(meta.get("source_name", "")).casefold() not in normalized_sources:
                continue
            if meta.get("content_type") not in {"plantuml", "mermaid"}:
                continue
            diagram_docs.append(Document(page_content=text, metadata=meta))

        return diagram_docs

    def fresh_reader(self):
        """
        Create a fresh Chroma reader while reusing the loaded embedding model and LLM.
        """
        reader = DeepContextEngine.__new__(DeepContextEngine)
        reader.embeddings = self.embeddings
        reader.db_path = self.db_path
        reader.collection_name = self.collection_name
        reader.chroma_host = self.chroma_host
        reader.chroma_port = self.chroma_port
        reader.chroma_ssl = self.chroma_ssl
        reader.llm = self.llm
        reader.vector_db = reader._create_vector_db()
        return reader

    def get_vector_db(self, refresh: bool = False):
        if refresh or self.vector_db is None:
            return self._reload_vector_db()
        return self.vector_db

    def _try_persist(self):
        vector_db = self.get_vector_db()
        if hasattr(vector_db, "persist"):
            vector_db.persist()
            return
        client = getattr(vector_db, "_client", None)
        if client is not None and hasattr(client, "persist"):
            client.persist()

    def _get_standalone_question(self, user_question: str, safe_history: List) -> str:
        if not safe_history:
            return user_question

        contextualize_q_system_prompt = (
            "You are a helpful assistant. Convert the latest user question into a "
            "self-contained standalone question using prior context if needed. "
            "Return ONLY the question. No prefixes, no explanation, no extra words."
            
            "Rewrite the user question in one standalone question. No prefixes, no explanation, no extra words."
            "Rules: "
            "1. The output must an question instead of answer."
            "2. Output must end with a ?"
            "3. Do not answer using facts from chat history."
            "4. Do not add prefixes, quotes, explanations, or markdown."
            "5. If the latest user turn is already standalone, return it as a single clean question."
        )   
    
        contextualize_q_prompt = ChatPromptTemplate.from_messages([
            ("system", contextualize_q_system_prompt),
            MessagesPlaceholder("chat-history"),
            ("human", "{input}")
        ])

        try:
            chain = contextualize_q_prompt | self.llm
            response = chain.invoke({
                "input": user_question,
                "chat-history": safe_history
            })
            candidate = response.content.strip()

            # Hard sanity checks for runaway/garbage rewrites
            if len(candidate) > 220:
                return user_question
            if (candidate.count("/") + candidate.count("\\")) > 4:
                return user_question

            if _is_garbage(candidate):
                print(f"⚠️ Garbage standalone_q detected, falling back. Got: {candidate[:80]}")
                return user_question

            return candidate

        except Exception:
            print("⚠️ Contextualize step failed; falling back to original question.")
            return user_question

    def _build_answer_request(self, user_question: str, chat_history: List = None, team_id: str = None, selected_sources: List[str] | None = None) -> dict:
        small_talk_intent = _detect_small_talk_intent(user_question)
        if small_talk_intent:
            return {
                "mode": "small_talk",
                "answer": _SMALL_TALK_RESPONSES[small_talk_intent],
                "retrieved": False,
                "intent": small_talk_intent,
                "diagrams": [],
                "sources": [],
            }

        # Step 1: Reload Chroma to pick up freshly ingested docs
        vector_db = self.get_vector_db(refresh=True)

        safe_history = self._normalize_chat_history(chat_history)
        standalone_q = self._get_standalone_question(user_question, safe_history)
        retrieval_query = standalone_q.strip() or user_question
        print(f"✅ Retrieval query prepared | used_history={bool(safe_history)}")

        valid_docs, primary_sources = self._retrieve_documents(retrieval_query, team_id=team_id, source_names=selected_sources)
        if (
            not valid_docs
            and retrieval_query.strip().casefold() != user_question.strip().casefold()
        ):
            print("⚠️ No hits for contextual query; retrying the original question")
            valid_docs, primary_sources = self._retrieve_documents(user_question, team_id=team_id, source_names=selected_sources)

        if not valid_docs:
            return {
                "mode": "no_docs",
                "answer": "I'm sorry, I couldn't find any relevant information in the documents for your question.",
                "retrieved": False,
                "diagrams": [],
                "sources": [],
            }

        all_source_names = {
            (getattr(doc, "metadata", {}) or {}).get("source_name")
            for doc in valid_docs
            if (getattr(doc, "metadata", {}) or {}).get("source_name")
        }
        # Fall back to "all" only if primary set is somehow empty
        effective_primary = (primary_sources & all_source_names) or all_source_names

        diagrams = []
        diagram_docs = []

        raw_diagram_request_type = detect_diagram_request_type(user_question)
        standalone_diagram_request_type = detect_diagram_request_type(standalone_q)
        requested_diagram_type = _merge_diagram_request_type(
            raw_diagram_request_type,
            standalone_diagram_request_type,
        )
        is_diagram_request = requested_diagram_type is not None

        if is_diagram_request:
            source_names = {
                (getattr(doc, "metadata", {}) or {}).get("source_name")
                for doc in valid_docs
                if (getattr(doc, "metadata", {}) or {}).get("source_name")
            }
            diagram_docs = self._fetch_diagram_docs_for_sources(vector_db, source_names, team_id=team_id)
            diagrams = _filter_diagrams_by_type(
                extract_diagrams_from_docs(diagram_docs),
                requested_diagram_type,
            )
            diagrams = _filter_diagrams_by_title_match(
                diagrams,
                standalone_q,
                user_question,
            )
            diagram_docs = _filter_diagram_docs_by_selected(diagram_docs, diagrams) if diagrams else diagram_docs

        # Build citation names strictly from the final context docs
        citation_names = sorted(effective_primary)

        if is_diagram_request and diagrams:
            return {
                "mode": "diagram_only",
                "answer": "",
                "retrieved": True,
                "diagrams": diagrams_to_flow(diagrams),
                "sources": self._build_sources_list(valid_docs, primary_source_names=effective_primary),
                "citation_names": citation_names,
            }

        if is_diagram_request and not diagrams:
            diagram_type_label = {
                "mermaid": "Mermaid",
                "plantuml": "PlantUML",
                "all": "diagram",
            }.get(requested_diagram_type, "diagram")
            return {
                "mode": "diagram_missing",
                "answer": f"I couldn't find a {diagram_type_label} in the retrieved documents for this question.",
                "retrieved": True,
                "diagrams": [],
                "sources": self._build_sources_list(valid_docs, primary_source_names=effective_primary),
                "citation_names": citation_names,
            }

        # Step 6: Answer using ONLY the retrieved docs — no chat history here
        system_prompt = (
            "You are a Corporate Knowledge Assistant. Your ONLY job is to answer the user's "
            "question using the provided context block below.\n\n"
            "STRICT RULES:\n"
            "1. Read the entire provided context carefully before answering. Make sure to read the context block below.\n"
            "2. If the answer IS present in the provided context — answer it directly and completely."
            "Do NOT say 'I don't know' if the information exists in the provided context.\n"
            "3. Only say you don't know if the provided context genuinely has no relevant information "
            "after careful reading.\n"
            "4. For list-type questions (participants, members, action items, decisions), "
            "extract and list every item found in the provided context.\n"
            "5. Do not fabricate anything not in the provided context.\n"
            "6. Format the answer as clean markdown when it improves readability.\n"
            "7. Use bullet points or numbered lists for multi-item answers.\n"
            "8. Use markdown tables only when the source information is naturally tabular.\n"
            "9. Use fenced code blocks for commands, code, or structured snippets.\n"
            "10. Do not use raw HTML.\n"
            "11. Keep simple answers as short plain paragraphs without unnecessary headings.\n\n"
            "provided context:\n{context}"
        )

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt),
            ("human", "{input}")
        ])

        question_answer_chain = prompt | self.llm
        context_block = self._render_context_docs(valid_docs)

        context_block = self._render_context_docs(valid_docs)
        
        print(f"🔎 Grounded context assembled | chunks={len(valid_docs)}")

        return {
            "mode": "answer",
            "answer": None,
            "retrieved": True,
            "diagrams": diagrams,
            "standalone_q": standalone_q,
            "retrieval_query": retrieval_query,
            "valid_docs": valid_docs,
            "context_block": context_block,
            "question_answer_chain": question_answer_chain,
            "sources": self._build_sources_list(valid_docs, primary_source_names=effective_primary),
            "citation_names": citation_names,
        }

    # ── LangGraph Workflow Nodes ─────────────────────────────────────────────

    def _build_langgraph_workflow(self):
        """Build the LangGraph StateGraph for the lightweight reflection loop."""
        workflow = StateGraph(RAGState)

        workflow.add_node("intent_detection", self._node_intent_detection)
        workflow.add_node("retrieve", self._node_retrieve)
        workflow.add_node("draft", self._node_draft)
        workflow.add_node("reflect", self._node_reflect)
        workflow.add_node("format_output", self._node_format_output)

        workflow.set_entry_point("intent_detection")

        workflow.add_conditional_edges(
            "intent_detection",
            self._route_after_intent,
            {
                "small_talk": "format_output",
                "no_docs": "format_output",
                "question": "retrieve",
                "diagram": "retrieve",
            },
        )

        workflow.add_edge("retrieve", "draft")

        workflow.add_conditional_edges(
            "draft",
            self._route_after_draft,
            {
                "format_output": "format_output",
                "reflect": "reflect",
            },
        )

        workflow.add_conditional_edges(
            "reflect",
            self._route_after_reflect,
            {
                "pass": "format_output",
                "retry": "draft",
                "exhausted": "format_output",
            },
        )

        workflow.add_edge("format_output", END)
        return workflow.compile()

    def _node_intent_detection(self, state: RAGState) -> RAGState:
        """Detect intent: small talk, diagram request, or regular question."""
        question = state["question"]

        small_talk = _detect_small_talk_intent(question)
        if small_talk:
            state["intent"] = "small_talk"
            state["final_answer"] = _SMALL_TALK_RESPONSES[small_talk]
            state["mode"] = "small_talk"
            return state

        raw_type = detect_diagram_request_type(question)
        if "/extract_diagram" in question.lower() or raw_type is not None:
            state["intent"] = "diagram"
            state["mode"] = "diagram"
            return state

        state["intent"] = "question"
        state["mode"] = "question"
        return state

    @staticmethod
    def _route_after_intent(state: RAGState) -> str:
        intent = state.get("intent")
        if intent == "small_talk":
            return "small_talk"
        return intent

    def _node_retrieve(self, state: RAGState) -> RAGState:
        """Retrieve documents from ChromaDB with RBAC filter (team_id)."""
        question = state["question"]
        team_id = state.get("user_team")
        selected_sources = state.get("selected_sources", [])
        chat_history = state.get("chat_history", [])

        vector_db = self.get_vector_db(refresh=True)

        safe_history = self._normalize_chat_history(chat_history)
        standalone_q = self._get_standalone_question(question, safe_history)
        retrieval_query = standalone_q.strip() or question
        state["standalone_question"] = standalone_q

        # Diagram commands are metadata lookups, not ordinary semantic Q&A.
        # Read diagram chunks directly under the mandatory workspace + ACL
        # filter so a short command such as `/extract_diagram` is reliable.
        if state.get("intent") == "diagram":
            valid_docs = self._fetch_diagram_docs_for_sources(
                vector_db,
                selected_sources or None,
                team_id=team_id,
            )
            primary_sources = {
                (getattr(doc, "metadata", {}) or {}).get("source_name")
                for doc in valid_docs
                if (getattr(doc, "metadata", {}) or {}).get("source_name")
            }
            record_retrieval_audit(team_id, retrieval_query, valid_docs)
        else:
            valid_docs, primary_sources = self._retrieve_documents(
                retrieval_query,
                team_id=team_id,
                source_names=selected_sources,
            )

        if (
            not valid_docs
            and state.get("intent") != "diagram"
            and retrieval_query.strip().casefold() != question.strip().casefold()
        ):
            valid_docs, primary_sources = self._retrieve_documents(question, team_id=team_id, source_names=selected_sources)

        if not valid_docs:
            state["intent"] = "no_docs"
            state["final_answer"] = (
                "I'm sorry, I couldn't find any relevant information "
                "in the documents for your question."
            )
            state["mode"] = "no_docs"
            state["retrieved_docs"] = []
            state["primary_sources"] = set()
            return state

        state["retrieved_docs"] = valid_docs
        state["primary_sources"] = primary_sources
        state["context_block"] = self._render_context_docs(valid_docs)

        all_source_names = {
            (getattr(doc, "metadata", {}) or {}).get("source_name")
            for doc in valid_docs
            if (getattr(doc, "metadata", {}) or {}).get("source_name")
        }
        effective_primary = (primary_sources & all_source_names) or all_source_names
        state["citation_names"] = sorted(effective_primary)
        state["sources"] = self._build_sources_list(
            valid_docs, primary_source_names=effective_primary
        )
        return state

    def _node_draft(self, state: RAGState) -> RAGState:
        """Generate a draft answer (LLM) or extract diagrams."""
        intent = state.get("intent")
        question = state["question"]
        team_id = state.get("user_team")

        if intent == "diagram":
            valid_docs = state.get("retrieved_docs", [])
            vector_db = self.get_vector_db()
            source_names = {
                (getattr(doc, "metadata", {}) or {}).get("source_name")
                for doc in valid_docs
                if (getattr(doc, "metadata", {}) or {}).get("source_name")
            }
            diagram_docs = self._fetch_diagram_docs_for_sources(
                vector_db, source_names, team_id=team_id
            )
            raw_type = detect_diagram_request_type(question)
            diagrams = _filter_diagrams_by_type(
                extract_diagrams_from_docs(diagram_docs),
                raw_type or "all",
            )
            diagrams = _filter_diagrams_by_title_match(
                diagrams, state.get("standalone_question", ""), question
            )
            diagrams = diagrams_to_flow(diagrams)
            state["diagrams"] = diagrams
            if diagrams:
                state["draft_answer"] = ""
                state["reflection_passed"] = True
            else:
                state["draft_answer"] = (
                    "I couldn't find a diagram in the retrieved documents for this question."
                )
                state["reflection_passed"] = True
            return state

        context_block = state.get("context_block", "")
        standalone_q = state.get("standalone_question", question)

        system_prompt = (
            "You are a Corporate Knowledge Assistant. Your ONLY job is to answer the user's "
            "question using the provided context block below.\n\n"
            "STRICT RULES:\n"
            "1. Read the entire provided context carefully before answering.\n"
            "2. If the answer IS present in the provided context — answer it directly and completely.\n"
            "3. Only say you don't know if the provided context genuinely has no relevant information.\n"
            "4. For list-type questions, extract and list every item found in the provided context.\n"
            "5. Do not fabricate anything not in the provided context.\n"
            "6. Format the answer as clean markdown when it improves readability.\n"
            "7. Use bullet points or numbered lists for multi-item answers.\n"
            "8. Use markdown tables only when the source information is naturally tabular.\n"
            "9. Use fenced code blocks for commands, code, or structured snippets.\n"
            "10. Do not use raw HTML.\n"
            "11. Keep simple answers as short plain paragraphs without unnecessary headings.\n\n"
            "provided context:\n{context}"
        )

        feedback = state.get("reflection_feedback", "")
        if feedback:
            system_prompt += (
                "\n\nIMPORTANT: A previous draft was rejected. "
                "Issues: " + feedback +
                "\nPlease address these issues and provide a corrected answer."
            )

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt),
            ("human", "{input}")
        ])

        chain = prompt | self.llm
        response = chain.invoke({"input": standalone_q, "context": context_block})
        state["draft_answer"] = _normalize_markdown_answer(_extract_answer_text(response))
        return state

    @staticmethod
    def _route_after_draft(state: RAGState) -> str:
        if state.get("intent") == "diagram":
            return "format_output"
        if state.get("intent") == "no_docs":
            return "format_output"
        return "reflect"

    def _node_reflect(self, state: RAGState) -> RAGState:
        """Reflection node: check draft answer for hallucinations."""
        draft = state.get("draft_answer", "")
        context = state.get("context_block", "")
        retry_count = state.get("retry_count", 0)

        if not draft or not context:
            state["reflection_passed"] = True
            return state

        _DONT_KNOW = [
            "i don't know", "i do not know", "no information", "not available",
            "no relevant", "cannot find", "not mentioned", "not provided", "no details",
        ]
        if any(phrase in draft.lower().strip() for phrase in _DONT_KNOW):
            state["reflection_passed"] = True
            return state

        reflection_prompt = (
            "You are a fact-checker. Compare the DRAFT ANSWER against the "
            "RETRIEVED CONTEXT below.\n"
            "Check if every factual claim in the draft answer is directly "
            "supported by the retrieved context.\n\n"
            "Respond with exactly:\n"
            '- "PASS" if every claim is supported by the context.\n'
            '- "FAIL: [brief reason]" if you find unsupported claims or hallucinations.\n\n'
            f"RETRIEVED CONTEXT:\n{context}\n\n"
            f"DRAFT ANSWER:\n{draft}\n\n"
            "Verdict:"
        )

        reflection_chain = (
            ChatPromptTemplate.from_messages([
                ("system", "You are a strict fact-checker. Be concise."),
                ("human", reflection_prompt),
            ])
            | self.llm
        )

        try:
            response = reflection_chain.invoke({})
            verdict = _extract_answer_text(response).strip()

            if verdict.upper().startswith("PASS"):
                state["reflection_passed"] = True
                state["reflection_feedback"] = ""
                print(f"✅ Reflection PASSED | retry_count={retry_count}")
            else:
                state["reflection_passed"] = False
                state["reflection_feedback"] = verdict
                state["retry_count"] = retry_count + 1
                print(
                    f"❌ Reflection FAILED | retry_count={state['retry_count']} "
                    f"| feedback={verdict[:120]}"
                )
        except Exception as exc:
            print(f"⚠️ Reflection check failed ({exc}), accepting draft.")
            state["reflection_passed"] = True

        return state

    @staticmethod
    def _route_after_reflect(state: RAGState) -> str:
        if state.get("reflection_passed", True):
            return "pass"
        if state.get("retry_count", 0) >= MAX_REFLECTION_RETRIES:
            return "exhausted"
        return "retry"

    def _node_format_output(self, state: RAGState) -> RAGState:
        """Format the final output state."""
        state["final_answer"] = state.get(
            "draft_answer", state.get("final_answer", "")
        )
        return state

    def run_workflow(
        self,
        question: str,
        user_team: str = None,
        chat_history: List = None,
        selected_sources: List[str] | None = None,
    ) -> dict:
        """Run the LangGraph RAG workflow and return the result dict."""
        if not hasattr(self, "_compiled_workflow"):
            self._compiled_workflow = self._build_langgraph_workflow()

        initial_state: RAGState = {
            "question": question,
            "standalone_question": "",
            "user_team": user_team or "default",
            "selected_sources": selected_sources or [],
            "chat_history": chat_history or [],
            "intent": "",
            "retrieved_docs": [],
            "primary_sources": set(),
            "context_block": "",
            "draft_answer": "",
            "reflection_passed": False,
            "reflection_feedback": "",
            "retry_count": 0,
            "final_answer": "",
            "diagrams": [],
            "sources": [],
            "citation_names": [],
            "token_usage": {},
            "mode": "",
        }

        result = self._compiled_workflow.invoke(initial_state)

        return {
            "answer": result.get("final_answer", ""),
            "retrieved": result.get("intent") not in ("small_talk", "no_docs"),
            "intent": result.get("intent"),
            "diagrams": result.get("diagrams", []),
            "sources": result.get("sources", []),
            "citation_names": result.get("citation_names", []),
        }

    # ── Public API ────────────────────────────────────────────────────────────

    def get_answer(self, user_question: str, chat_history: List = None, user_team: str = None, selected_sources: List[str] | None = None):
        """Run the LangGraph RAG workflow with reflection loop."""
        return self.run_workflow(user_question, user_team=user_team, chat_history=chat_history, selected_sources=selected_sources)
