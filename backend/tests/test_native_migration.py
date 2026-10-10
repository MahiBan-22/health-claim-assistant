import hashlib
import sqlite3
import pytest
from app.migrate_native import migrate

def test_migration_checks_hash_and_normalizes_path(tmp_path):
    original = tmp_path / "cases" / "case-1" / "doc-1.txt"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"SYNTHETIC RECORD")
    with sqlite3.connect(tmp_path / "app.sqlite") as connection:
        connection.execute("CREATE TABLE documents (id TEXT,path TEXT,sha256 TEXT)")
        connection.execute("INSERT INTO documents VALUES (?,?,?)", ("doc-1", "/data/cases/case-1/doc-1.txt", hashlib.sha256(original.read_bytes()).hexdigest()))
        connection.execute("CREATE TABLE cases (id TEXT)")
        connection.execute("CREATE TABLE analyses (id TEXT,status TEXT,error TEXT)")
        connection.execute("INSERT INTO analyses VALUES ('run-1','running',NULL)")
        connection.execute("CREATE TABLE reports (id TEXT)")
    assert migrate(tmp_path)["documents"] == 1
    with sqlite3.connect(tmp_path / "app.sqlite") as connection:
        assert connection.execute("SELECT path FROM documents").fetchone()[0] == str(original.resolve())
        assert connection.execute("SELECT status FROM analyses").fetchone()[0] == "paused"
