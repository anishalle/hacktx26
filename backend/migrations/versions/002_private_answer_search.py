"""Reuse human explanations within their original private audience."""

from alembic import op

revision = "002_private_answer_search"
down_revision = "001_chat"

UPGRADE_STATEMENTS = (
    """ALTER TABLE member_asks ADD COLUMN IF NOT EXISTS search tsvector
        GENERATED ALWAYS AS
        (to_tsvector('english', question || ' ' || coalesce(answer, ''))) STORED""",
    "CREATE INDEX IF NOT EXISTS member_asks_search ON member_asks USING gin(search)",
    "CREATE INDEX IF NOT EXISTS member_asks_requester ON member_asks(requester_id)",
    "CREATE INDEX IF NOT EXISTS member_asks_recipient ON member_asks(recipient_id)",
)


def upgrade():
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade():
    op.execute("""
        DROP INDEX member_asks_search, member_asks_requester, member_asks_recipient;
        ALTER TABLE member_asks DROP COLUMN search;
    """)
