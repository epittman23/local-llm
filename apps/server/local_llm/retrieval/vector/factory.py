import threading

from local_llm.config import VECTOR_DB
from local_llm.retrieval.vector.main import VectorDBBase
from local_llm.retrieval.vector.type import VectorType


class Vector:
    @staticmethod
    def get_vector(vector_type: str) -> VectorDBBase:
        """The client for the configured vector store; pgvector is the only one."""
        if vector_type != VectorType.PGVECTOR:
            raise ValueError(f'Unsupported vector type: {vector_type} (pgvector is the only vector store)')
        from local_llm.retrieval.vector.dbs.pgvector import PgvectorClient

        return PgvectorClient()


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
