"""The sandbox's own records: one row per persistent workspace volume (docs/guides/sandbox.md).

The sandbox manager (sandbox/manager.py) writes and reads them through
sandbox/workspaces.py's DatabaseWorkspaces; nothing else should.
"""

from sqlalchemy import BigInteger, CheckConstraint, Column, Text

from local_llm.internal.db import Base

#: Why a workspace waits for its user's answer before it may be deleted (owner decision Q15).
PENDING_REASONS = ('cap', 'expired')


class SandboxWorkspace(Base):
    """A saved chat's persistent workspace volume, and whether its deletion waits for the user's answer.

    The row is written when the manager creates the volume (or finds one
    without a row), so it survives restarts; it goes with the volume.

    Columns:
        key: The backend key the volume is named after (for a saved chat, its id).
        user_id: Whose workspace it is: the chat's owner, whoever ran the code.
        chat_id: The chat it belongs to.
        created_at, last_used_at: Epoch seconds; the manager moves `last_used_at` at the end of every session.
        pending_reason: None, or why it waits to be deleted: `cap` (the user is at the workspace limit and
            another chat needs one) or `expired` (unused for the retention days).
        pending_since: When it started waiting, epoch seconds.
        pending_for_chat_id: For `cap`, the chat whose new workspace waits for room.
    """

    __tablename__ = 'sandbox_workspace'
    __table_args__ = (
        CheckConstraint(
            "pending_reason IS NULL OR pending_reason IN ('cap', 'expired')", name='ck_sandbox_workspace_pending'
        ),
    )

    key = Column(Text, primary_key=True)
    user_id = Column(Text, nullable=False, index=True)
    chat_id = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    last_used_at = Column(BigInteger, nullable=False)
    pending_reason = Column(Text, nullable=True)
    pending_since = Column(BigInteger, nullable=True)
    pending_for_chat_id = Column(Text, nullable=True)
