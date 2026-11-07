import datetime as dt
from typing import Any

from local_llm.env import RAG_METADATA_MAX_VALUE_CHARS
from local_llm.retrieval.vector.main import SearchResult
from local_llm.utils.misc import sanitize_text_for_db

KEYS_TO_EXCLUDE = [
    'content',
    'pages',
    'tables',
    'paragraphs',
    'sections',
    'figures',
    'documents',
    'keyValuePairs',
    'styles',
    'languages',
]


def metadata_max_value_chars(file_max_size_mb: Any) -> int | None:
    """The cap on one list or dict metadata value, in characters; None for no cap.

    RAG_METADATA_MAX_VALUE_CHARS when it is set. Otherwise the upload size limit,
    `rag.file.max_size` in MB, which the caller reads at use time: the limit an
    admin sets in Admin Settings > Documents, or RAG_FILE_MAX_SIZE when none is
    saved. A document cannot legitimately carry more metadata than the file
    itself is allowed to be, and left unbounded a small archive that expands
    enormously during extraction can exhaust memory (#629). An empty, zero,
    negative or unreadable limit means no cap.
    """
    if RAG_METADATA_MAX_VALUE_CHARS is not None:
        return RAG_METADATA_MAX_VALUE_CHARS
    try:
        return max(int(file_max_size_mb or 0), 0) * 1024 * 1024 or None
    except (TypeError, ValueError):
        return None


def _over_cap(value: Any, max_value_chars: int | None) -> bool:
    if max_value_chars is None or not isinstance(value, (list, dict)):
        return False
    try:
        return len(str(value)) > max_value_chars
    except (MemoryError, RecursionError, ValueError):
        return True


def drop_oversized_values(metadata: dict[str, Any], max_value_chars: int | None) -> dict[str, Any]:
    # Removes list and dict values over the cap, keeping everything else as it is.
    return {key: value for key, value in metadata.items() if not _over_cap(value, max_value_chars)}


def filter_metadata(metadata: dict[str, any], *, max_value_chars: int | None) -> dict[str, any]:
    # Removes large/redundant fields from metadata dict.
    result = {}
    for key, value in metadata.items():
        if key in KEYS_TO_EXCLUDE:
            continue
        if _over_cap(value, max_value_chars):
            continue
        result[key] = value
    return result


def process_metadata(
    metadata: dict[str, any],
) -> dict[str, any]:
    # Removes large fields, converts non-serializable types (datetime, list, dict) to strings,
    # and sanitizes strings for database storage (strips null bytes and invalid surrogates).
    result = {}
    for key, value in metadata.items():
        # Skip large fields
        if key in KEYS_TO_EXCLUDE:
            continue
        if value is None:
            continue
        # Only the explicit cap: documents saved through save_docs_to_vector_db have already had
        # the upload limit applied, and the other callers (memories, knowledge) store scalars.
        if _over_cap(value, RAG_METADATA_MAX_VALUE_CHARS):
            continue
        # Convert non-serializable fields to strings
        if isinstance(value, (dt.datetime, list, dict)):
            result[key] = sanitize_text_for_db(str(value))
        else:
            result[key] = sanitize_text_for_db(value)
    return result


def merge_hybrid_search_results(
    vector_result: SearchResult | None,
    fts_results: list[dict[str, Any]],
    num_queries: int,
    limit: int,
    hybrid_bm25_weight: float,
) -> SearchResult:
    rank_constant = 60.0
    bm25_weight = min(max(hybrid_bm25_weight, 0.0), 1.0)
    vector_weight = 1.0 - bm25_weight

    ids = [[] for _ in range(num_queries)]
    distances = [[] for _ in range(num_queries)]
    documents = [[] for _ in range(num_queries)]
    metadatas = [[] for _ in range(num_queries)]

    for qid in range(num_queries):
        candidates: dict[str, dict[str, Any]] = {}

        if vector_result and vector_result.ids and qid < len(vector_result.ids):
            for rank, item_id in enumerate(vector_result.ids[qid] or [], start=1):
                score = vector_weight / (rank_constant + rank) if vector_weight > 0 else 0
                if score <= 0:
                    continue

                candidate = candidates.setdefault(
                    item_id,
                    {
                        'score': 0.0,
                        'document': vector_result.documents[qid][rank - 1],
                        'metadata': vector_result.metadatas[qid][rank - 1],
                    },
                )
                candidate['score'] += score

        for rank, row in enumerate(fts_results, start=1):
            score = bm25_weight / (rank_constant + rank) if bm25_weight > 0 else 0
            if score <= 0:
                continue

            item_id = row['id']
            candidate = candidates.setdefault(
                item_id,
                {
                    'score': 0.0,
                    'document': row['text'],
                    'metadata': row['vmetadata'],
                },
            )
            candidate['score'] += score

        ranked = sorted(candidates.items(), key=lambda item: item[1]['score'], reverse=True)[:limit]
        ids[qid] = [item_id for item_id, _ in ranked]
        distances[qid] = [candidate['score'] for _, candidate in ranked]
        documents[qid] = [candidate['document'] for _, candidate in ranked]
        metadatas[qid] = [candidate['metadata'] for _, candidate in ranked]

    return SearchResult(ids=ids, distances=distances, documents=documents, metadatas=metadatas)
