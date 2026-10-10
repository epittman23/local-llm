import threading

from local_llm.config import (
    ENABLE_MILVUS_MULTITENANCY_MODE,
    ENABLE_QDRANT_MULTITENANCY_MODE,
    VECTOR_DB,
)
from local_llm.retrieval.vector.main import VectorDBBase
from local_llm.retrieval.vector.type import VectorType


class Vector:
    @staticmethod
    def get_vector(vector_type: str) -> VectorDBBase:
        """
        get vector db instance by vector type
        """
        match vector_type:
            case VectorType.MILVUS:
                if ENABLE_MILVUS_MULTITENANCY_MODE:
                    from local_llm.retrieval.vector.dbs.milvus_multitenancy import (
                        MilvusClient,
                    )

                    return MilvusClient()
                else:
                    from local_llm.retrieval.vector.dbs.milvus import MilvusClient

                    return MilvusClient()
            case VectorType.QDRANT:
                if ENABLE_QDRANT_MULTITENANCY_MODE:
                    from local_llm.retrieval.vector.dbs.qdrant_multitenancy import (
                        QdrantClient,
                    )

                    return QdrantClient()
                else:
                    from local_llm.retrieval.vector.dbs.qdrant import QdrantClient

                    return QdrantClient()
            case VectorType.PINECONE:
                from local_llm.retrieval.vector.dbs.pinecone import PineconeClient

                return PineconeClient()
            case VectorType.S3VECTOR:
                from local_llm.retrieval.vector.dbs.s3vector import S3VectorClient

                return S3VectorClient()
            case VectorType.OPENSEARCH:
                from local_llm.retrieval.vector.dbs.opensearch import OpenSearchClient

                return OpenSearchClient()
            case VectorType.PGVECTOR:
                from local_llm.retrieval.vector.dbs.pgvector import PgvectorClient

                return PgvectorClient()
            case VectorType.OPENGAUSS:
                from local_llm.retrieval.vector.dbs.opengauss import OpenGaussClient

                return OpenGaussClient()
            case VectorType.MARIADB_VECTOR:
                from local_llm.retrieval.vector.dbs.mariadb_vector import (
                    MariaDBVectorClient,
                )

                return MariaDBVectorClient()
            case VectorType.ELASTICSEARCH:
                from local_llm.retrieval.vector.dbs.elasticsearch import (
                    ElasticsearchClient,
                )

                return ElasticsearchClient()
            case VectorType.CHROMA:
                from local_llm.retrieval.vector.dbs.chroma import ChromaClient

                return ChromaClient()
            case VectorType.ORACLE23AI:
                from local_llm.retrieval.vector.dbs.oracle23ai import Oracle23aiClient

                return Oracle23aiClient()
            case VectorType.WEAVIATE:
                from local_llm.retrieval.vector.dbs.weaviate import WeaviateClient

                return WeaviateClient()
            case VectorType.VALKEY:
                from local_llm.retrieval.vector.dbs.valkey import ValkeyClient

                return ValkeyClient()
            case _:
                raise ValueError(f'Unsupported vector type: {vector_type}')


class LazyVectorDBClient:
    """The configured vector store's client, created on first use.

    Creating it at import time meant importing any router that touches
    retrieval connected to the vector store, so a unit test, or a script
    that only needed a helper, needed a live database. Attribute access is
    forwarded to the real client, so callers use this exactly like a
    VectorDBBase. main.py's lifespan resolves it at startup, so a
    misconfigured store still fails the boot, not the first upload.
    """

    def __init__(self, vector_type: str) -> None:
        self._vector_type = vector_type
        self._client: VectorDBBase | None = None
        self._lock = threading.Lock()

    def resolve(self) -> VectorDBBase:
        """The real client, created (once, thread-safely) on the first call."""
        if self._client is None:
            with self._lock:
                if self._client is None:
                    self._client = Vector.get_vector(self._vector_type)
        return self._client

    def __getattr__(self, name: str):
        return getattr(self.resolve(), name)


VECTOR_DB_CLIENT = LazyVectorDBClient(VECTOR_DB)
