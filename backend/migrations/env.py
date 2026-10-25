from alembic import context
from psycopg.rows import tuple_row
from sqlalchemy import create_engine

from app.core.db import connect

engine = create_engine(
    "postgresql+psycopg://", creator=lambda: connect(row_factory=tuple_row)
)
with engine.connect() as connection:
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()
