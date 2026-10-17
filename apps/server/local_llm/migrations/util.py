"""Alembic migration utilities."""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect  # metadata inspection


# --- database helper functions ---
def get_existing_tables() -> set[str]:
    """Return table names already present in the database."""
    conn = op.get_bind()
    return set(inspect(conn).get_table_names())


def get_revision_id() -> str:
    """Generate a short random revision identifier."""
    import uuid

    return uuid.uuid4().hex[:12]
