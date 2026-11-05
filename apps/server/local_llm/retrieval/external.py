import asyncio
import json
import logging
import re
import time
from typing import Any

from local_llm.config import RAG_EMBEDDING_QUERY_PREFIX
from local_llm.models.config import Config
from local_llm.models.knowledge import KnowledgeModel

log = logging.getLogger(__name__)

EXTERNAL_KNOWLEDGE_CONNECTIONS_CONFIG_KEY = 'external_knowledge.connections'
IDENTIFIER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


async def _get_external_connection(connection_id: str) -> dict | None:
    connections = await Config.get(EXTERNAL_KNOWLEDGE_CONNECTIONS_CONFIG_KEY, []) or []
    return next((connection for connection in connections if connection.get('id') == connection_id), None)


def _get_path(data: Any, path: str | None, default=None):
    if not path:
        return default
    value = data
    for part in path.split('.'):
        if isinstance(value, dict):
            value = value.get(part, default)
        else:
            return default
    return value


def _normalize_result(result: dict, mapping: dict, knowledge: KnowledgeModel, distance: float | None = None) -> dict:
    content = _get_path(result, mapping.get('content_field', 'content'), '')
    title = _get_path(result, mapping.get('title_field', 'title'), None)
    source = _get_path(result, mapping.get('source_field', 'source'), None)
    url = _get_path(result, mapping.get('url_field', 'url'), None)
    document_id = _get_path(result, mapping.get('document_id_field', 'document_id'), None)
    page = _get_path(result, mapping.get('page_field', 'page'), None)
    metadata = _get_path(result, mapping.get('metadata_field', 'metadata'), {}) or {}
    score = _get_path(result, mapping.get('score_field', 'score'), distance)

    if not isinstance(metadata, dict):
        metadata = {'external_metadata': metadata}

    source_name = source or title or metadata.get('source') or metadata.get('name') or knowledge.name
    metadata.update(
        {
            'name': title or source_name,
            'source': source_name,
            'url': url,
            'file_id': document_id or f'external-{knowledge.id}',
            'knowledge_id': knowledge.id,
            'knowledge_name': knowledge.name,
            'external': True,
        }
    )
    if page is not None:
        metadata['page'] = page
    if document_id is not None:
        metadata['document_id'] = document_id

    return {
        'content': content,
        'metadata': metadata,
        'distance': score,
    }


def _source_config(knowledge: KnowledgeModel) -> dict:
    external = (knowledge.meta or {}).get('external', {})
    source = external.get('source') or {}
    return source.get('config') or {}


def _root_field(path: str | None) -> str | None:
    if not path:
        return None
    return path.split('.')[0]


def _safe_identifier(value: str, label: str) -> str:
    if not value or not IDENTIFIER_RE.match(value):
        raise RuntimeError(f'Invalid {label}')
    return value


# Metrics whose score is a distance, lower is better; every other reports a similarity.
_DISTANCE_METRICS = {'euclid', 'manhattan', 'l2', 'hamming', 'jaccard'}


def _as_similarity(score, metric: str | None):
    """A provider's score as a similarity, higher is better, as every other source reports one (#503).

    Cosine and inner product already are one; a distance d (Euclid, Manhattan,
    L2, ...) becomes 1 / (1 + d), which keeps the order, the closest hit
    scoring 1. An unknown metric leaves the score as it is.
    """
    if not isinstance(score, int | float) or (metric or '').lower() not in _DISTANCE_METRICS:
        return score
    return 1 / (1 + max(float(score), 0.0))


def _qdrant_metric(client, collection_name: str, vector_field: str | None) -> str | None:
    """The distance the collection's vectors (or its named vector) are compared by, or None if it cannot be read."""
    try:
        vectors = client.get_collection(collection_name).config.params.vectors
        params = vectors.get(vector_field or '') if isinstance(vectors, dict) else vectors
        distance = getattr(params, 'distance', None)
        return str(getattr(distance, 'value', distance)) if distance is not None else None
    except Exception as e:
        log.warning('Could not read the metric of Qdrant collection %s: %s', collection_name, e)
        return None


def _milvus_metric(client, collection_name: str, vector_field: str, timeout: float) -> str | None:
    """The metric of the index on the vector field, or None if it cannot be read."""
    try:
        for index_name in client.list_indexes(collection_name, field_name=vector_field, timeout=timeout) or []:
            metric = (client.describe_index(collection_name, index_name, timeout=timeout) or {}).get('metric_type')
            if metric:
                return str(metric)
    except Exception as e:
        log.warning('Could not read the metric of Milvus collection %s: %s', collection_name, e)
    return None


async def _retrieve_qdrant(connection, auth_config, knowledge, query, count, embedding_function) -> list[dict]:
    try:
        from qdrant_client import QdrantClient
    except ImportError as exc:
        raise RuntimeError('qdrant-client is not installed') from exc

    if not embedding_function:
        raise RuntimeError('Embedding function is not configured')

    config = connection.get('config') or {}
    external = (knowledge.meta or {}).get('external', {})
    source = external.get('source') or {}
    collection_name = source.get('name')
    if not collection_name:
        raise RuntimeError('External source collection is not configured')
    source_config = _source_config(knowledge)
    vector_field = source_config.get('vector_field') or None

    vector = await embedding_function(query, prefix=RAG_EMBEDDING_QUERY_PREFIX)

    def _search():
        client = QdrantClient(
            url=connection.get('endpoint'),
            api_key=(auth_config or {}).get('api_key'),
            timeout=config.get('timeout') or 30,
        )
        response = client.query_points(
            collection_name=collection_name,
            query=vector,
            using=vector_field,
            limit=count,
        )
        return response, _qdrant_metric(client, collection_name, vector_field)

    response, metric = await asyncio.to_thread(_search)
    mapping = {
        'content_field': source_config.get('content_field') or 'payload.text',
        'metadata_field': source_config.get('metadata_field') or 'payload.metadata',
        'document_id_field': source_config.get('document_id_field') or 'id',
        'score_field': 'score',
    }

    normalized = []
    for point in response.points:
        result = point.model_dump()
        result['score'] = _as_similarity(result.get('score'), metric)
        normalized.append(_normalize_result(result, mapping, knowledge, distance=result['score']))
    return normalized


async def _retrieve_milvus(connection, auth_config, knowledge, query, count, embedding_function) -> list[dict]:
    try:
        from pymilvus import MilvusClient
    except ImportError as exc:
        raise RuntimeError('pymilvus is not installed') from exc

    if not embedding_function:
        raise RuntimeError('Embedding function is not configured')

    config = connection.get('config') or {}
    external = (knowledge.meta or {}).get('external', {})
    source = external.get('source') or {}
    collection_name = source.get('name')
    if not collection_name:
        raise RuntimeError('Milvus collection is not configured')
    source_config = _source_config(knowledge)
    vector_field = source_config.get('vector_field') or 'vector'
    content_field = source_config.get('content_field') or 'data.text'
    metadata_field = source_config.get('metadata_field') or 'metadata'

    vector = await embedding_function(query, prefix=RAG_EMBEDDING_QUERY_PREFIX)

    def _search():
        client_kwargs = {
            'uri': connection.get('endpoint'),
        }
        token = (auth_config or {}).get('api_key') or (auth_config or {}).get('token')
        if token:
            client_kwargs['token'] = token
        if config.get('db_name'):
            client_kwargs['db_name'] = config.get('db_name')

        client = MilvusClient(**client_kwargs)
        output_fields = {
            field
            for field in (
                _root_field(content_field),
                _root_field(metadata_field),
                _root_field(source_config.get('document_id_field')),
            )
            if field and field != vector_field
        }
        kwargs = {
            'collection_name': collection_name,
            'data': [vector],
            'anns_field': vector_field,
            'limit': count,
            'output_fields': list(output_fields),
        }
        # Each call bounded, as the connection is: none of them is otherwise (#503).
        timeout = config.get('timeout') or 30
        return client.search(**kwargs, timeout=timeout), _milvus_metric(client, collection_name, vector_field, timeout)

    response, metric = await asyncio.to_thread(_search)
    mapping = {
        'content_field': content_field,
        'metadata_field': metadata_field,
        'document_id_field': source_config.get('document_id_field') or 'id',
        'score_field': 'distance',
    }

    normalized = []
    for hit in response[0] if response else []:
        item = dict(hit)
        entity = item.get('entity') or {}
        result = {
            **entity,
            'id': item.get('id') or entity.get('id'),
            'distance': _as_similarity(item.get('distance'), metric),
        }
        normalized.append(_normalize_result(result, mapping, knowledge, distance=result['distance']))
    return normalized


async def _retrieve_pgvector(connection, auth_config, knowledge, query, count, embedding_function) -> list[dict]:
    try:
        import psycopg
        from pgvector import Vector
        from pgvector.psycopg import register_vector
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError('psycopg and pgvector are required for pgvector retrieval') from exc

    if not embedding_function:
        raise RuntimeError('Embedding function is not configured')

    config = connection.get('config') or {}
    external = (knowledge.meta or {}).get('external', {})
    source = external.get('source') or {}
    collection_name = source.get('name')
    if not collection_name:
        raise RuntimeError('pgvector collection is not configured')
    source_config = _source_config(knowledge)
    table_name = source_config.get('table_name') or 'document_chunk'
    collection_field = source_config.get('collection_field') or 'collection_name'
    content_field = source_config.get('content_field') or 'text'
    vector_field = source_config.get('vector_field') or 'vector'
    metadata_field = source_config.get('metadata_field') or 'vmetadata'
    document_id_field = source_config.get('document_id_field') or 'id'

    vector = await embedding_function(query, prefix=RAG_EMBEDDING_QUERY_PREFIX)
    timeout = float(config.get('timeout') or 30)
    endpoint = connection.get('endpoint')

    def _search():
        from psycopg import sql
        from psycopg.conninfo import conninfo_to_dict

        table_identifier = sql.SQL('.').join(
            sql.Identifier(_safe_identifier(part, 'table name')) for part in table_name.split('.')
        )
        collection_identifier = sql.Identifier(_safe_identifier(collection_field, 'collection field'))
        content_identifier = sql.Identifier(_safe_identifier(content_field, 'content field'))
        vector_identifier = sql.Identifier(_safe_identifier(vector_field, 'vector field'))
        document_id_identifier = sql.Identifier(_safe_identifier(document_id_field, 'document id field'))
        metadata_sql = (
            sql.Identifier(_safe_identifier(metadata_field, 'metadata field'))
            if metadata_field
            else sql.SQL("'{}'::jsonb")
        )

        # The search bounded by the server too, not only the connect (#514). Added
        # to the endpoint's own libpq options, which the argument would replace.
        own_options = conninfo_to_dict(endpoint or '').get('options')
        options = f'-c statement_timeout={int(timeout * 1000)}'
        if own_options:
            options = f'{own_options} {options}'
        with psycopg.connect(
            endpoint,
            row_factory=dict_row,
            connect_timeout=config.get('timeout') or 30,
            options=options,
        ) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                cur.execute(
                    sql.SQL(
                        """
                    SELECT {document_id} AS id,
                           {content} AS content,
                           {metadata} AS metadata,
                           {vector_column} <=> %s AS distance
                    FROM {table_name}
                    WHERE {collection} = %s
                    ORDER BY distance ASC
                    LIMIT %s
                    """
                    ).format(
                        document_id=document_id_identifier,
                        content=content_identifier,
                        metadata=metadata_sql,
                        vector_column=vector_identifier,
                        table_name=table_identifier,
                        collection=collection_identifier,
                    ),
                    # As a Vector: register_vector adapts it as the vector type,
                    # where a list would go as double precision[] (#350).
                    (Vector(vector), collection_name, count),
                )
                return cur.fetchall()

    # A server that stops answering mid-query never ends the statement, so the
    # turn waits no longer than the connect and the search could each take (#514).
    try:
        rows = await asyncio.wait_for(asyncio.to_thread(_search), timeout=2 * timeout + 1)
    except TimeoutError as exc:
        raise RuntimeError(f'The pgvector server did not answer within {2 * timeout + 1:g} s') from exc
    mapping = {
        'content_field': 'content',
        'metadata_field': 'metadata',
        'document_id_field': 'id',
        'score_field': 'distance',
    }
    # Reported as cosine similarity (1 - distance), higher is better like the
    # other providers' scores and the relevance the chat shows (#350). The SQL
    # still orders by the raw distance so an index on the column can serve it.
    normalized = []
    for row in rows:
        result = dict(row)
        if result.get('distance') is not None:
            result['distance'] = 1 - result['distance']
        normalized.append(_normalize_result(result, mapping, knowledge, distance=result.get('distance')))
    return normalized


async def retrieve_external_knowledge(
    request,
    knowledge: KnowledgeModel,
    queries: list[str],
    count: int,
    user=None,
) -> dict:
    external = (knowledge.meta or {}).get('external', {})
    connection_id = external.get('connection_id')
    if not connection_id:
        raise RuntimeError('External knowledge connection is not configured')

    connection = await _get_external_connection(connection_id)
    if not connection:
        raise RuntimeError('External knowledge connection not found')

    return await retrieve_external_knowledge_for_connection(request, knowledge, connection, queries, count, user=user)


async def retrieve_external_knowledge_for_connection(
    request,
    knowledge: KnowledgeModel,
    connection: dict,
    queries: list[str],
    count: int,
    user=None,
) -> dict:
    auth_config = connection.get('auth_config') or {}
    if not connection.get('enabled', True):
        raise RuntimeError('External knowledge connection is disabled')

    started_at = time.monotonic()
    hits_by_query = []
    provider = (connection.get('provider') or '').lower()

    for query in queries:
        if provider == 'qdrant':
            hits_by_query.append(
                await _retrieve_qdrant(
                    connection,
                    auth_config,
                    knowledge,
                    query,
                    count,
                    getattr(request.app.state, 'EMBEDDING_FUNCTION', None),
                )
            )
        elif provider == 'milvus':
            hits_by_query.append(
                await _retrieve_milvus(
                    connection,
                    auth_config,
                    knowledge,
                    query,
                    count,
                    getattr(request.app.state, 'EMBEDDING_FUNCTION', None),
                )
            )
        elif provider == 'pgvector':
            hits_by_query.append(
                await _retrieve_pgvector(
                    connection,
                    auth_config,
                    knowledge,
                    query,
                    count,
                    getattr(request.app.state, 'EMBEDDING_FUNCTION', None),
                )
            )
        else:
            raise RuntimeError(f'Unsupported external knowledge provider: {connection.get("provider")}')

    # The queries take turns, each one's best hit first, so the first query
    # cannot fill the budget alone (#349). Merged by rank, not score: a score
    # is a similarity when the collection's metric could be read (#503), but
    # stays as the provider gave it when it could not. A chunk returned more than once, by several queries or
    # twice by one, is kept once, at its best rank; the key includes the
    # content because document_id_field may map a parent document shared by
    # several chunks. It is built as text because either field may be mapped
    # to a JSON object or array, which is not hashable.
    chunks = []
    seen = set()
    for rank in range(max((len(hits) for hits in hits_by_query), default=0)):
        for hits in hits_by_query:
            if rank >= len(hits):
                continue
            chunk = hits[rank]
            key = json.dumps([chunk['metadata'].get('document_id'), chunk['content']], sort_keys=True, default=str)
            if key not in seen:
                seen.add(key)
                chunks.append(chunk)
    chunks = chunks[:count]
    log.info(
        'external_knowledge_retrieval knowledge_id=%s connection_id=%s provider=%s user_id=%s latency_ms=%s '
        'result_count=%s',
        knowledge.id,
        connection.get('id'),
        connection.get('provider'),
        getattr(user, 'id', None),
        round((time.monotonic() - started_at) * 1000),
        len(chunks),
    )

    return {
        'documents': [[chunk['content'] for chunk in chunks]],
        'metadatas': [[chunk['metadata'] for chunk in chunks]],
        'distances': [[chunk['distance'] for chunk in chunks]],
    }
