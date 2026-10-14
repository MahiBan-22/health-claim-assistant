"""Shared checkpoint access for processing, trace views and deletion."""
import sqlite3
from contextlib import contextmanager, closing
from .config import settings

@contextmanager
def saver(config=None):
    config = config or settings()
    if config.postgres:
        import psycopg
        from psycopg.rows import dict_row
        from langgraph.checkpoint.postgres import PostgresSaver
        url = config.checkpoint_database_url.get_secret_value() or config.database_url.get_secret_value()
        url = url.replace("postgresql+psycopg://", "postgresql://", 1)
        with psycopg.connect(url, autocommit=True, prepare_threshold=None, row_factory=dict_row, connect_timeout=10) as connection:
            yield PostgresSaver(connection)
    else:
        from langgraph.checkpoint.sqlite import SqliteSaver
        config.data_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(str(config.data_dir / "checkpoints.sqlite"), check_same_thread=False)) as connection:
            yield SqliteSaver(connection)
            connection.commit()

def initialize():
    from . import db
    db.engine()
    if settings().postgres:
        with saver() as store:
            store.setup()

if __name__ == "__main__":
    initialize()
    print("Application and checkpoint tables are ready.")
