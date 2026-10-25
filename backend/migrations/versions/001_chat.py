"""Chat history, vectors, and private clarification requests."""

from alembic import op

revision = "001_chat"
down_revision = None

UPGRADE_STATEMENTS = (
    "CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, name text NOT NULL)",
    "CREATE TABLE IF NOT EXISTS groups (id text PRIMARY KEY, name text NOT NULL)",
    """CREATE TABLE IF NOT EXISTS memberships (
        group_id text REFERENCES groups(id), user_id text REFERENCES users(id),
        joined_at timestamptz NOT NULL, PRIMARY KEY (group_id, user_id))""",
    """CREATE TABLE IF NOT EXISTS messages (
        id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id),
        sender_id text NOT NULL REFERENCES users(id), ts timestamptz NOT NULL,
        text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
        embedding vector(1024), embedding_model text,
        search tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
        FOREIGN KEY (group_id, sender_id) REFERENCES memberships(group_id, user_id))""",
    "CREATE INDEX IF NOT EXISTS messages_order ON messages(group_id, ts, id)",
    "CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin(search)",
    """CREATE INDEX IF NOT EXISTS messages_vector ON messages USING hnsw
        (embedding vector_cosine_ops)""",
    """CREATE TABLE IF NOT EXISTS member_asks (
        id text PRIMARY KEY, message_id text NOT NULL REFERENCES messages(id),
        requester_id text NOT NULL REFERENCES users(id),
        recipient_id text NOT NULL REFERENCES users(id), question text NOT NULL,
        answer text, status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'answered', 'declined')),
        created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz,
        UNIQUE(message_id, requester_id, question))""",
    """CREATE TABLE IF NOT EXISTS explanations (
        id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id),
        user_id text NOT NULL REFERENCES users(id),
        message_id text NOT NULL REFERENCES messages(id), context jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())""",
)


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade():
    op.execute(
        "DROP TABLE explanations, member_asks, messages, memberships, groups, users"
    )
