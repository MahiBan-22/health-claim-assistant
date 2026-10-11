"""Validate a stopped Docker data copy and normalize file paths for native use."""
import hashlib
import sqlite3
from pathlib import Path, PurePosixPath

def migrate(directory: Path):
    directory = directory.resolve()
    database = directory / "app.sqlite"
    if not database.is_file():
        raise RuntimeError("No copied application database was found")
    with sqlite3.connect(database) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Copied database failed its integrity check")
        updates = []
        for document_id, path, digest in connection.execute("SELECT id,path,sha256 FROM documents"):
            old = PurePosixPath(path)
            if not str(old).startswith("/data/"):
                raise RuntimeError("Unexpected source document location; migration stopped")
            target = (directory / old.relative_to("/data")).resolve()
            if not target.is_relative_to(directory) or not target.is_file():
                raise RuntimeError("A copied original document is missing or outside the data directory")
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise RuntimeError("A copied original document failed its hash check")
            updates.append((str(target), document_id))
        connection.executemany("UPDATE documents SET path=? WHERE id=?", updates)
        connection.execute("UPDATE analyses SET status='paused',error='Paused during native migration; resume to continue' WHERE status IN ('queued','running')")
        counts = {table: connection.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] for table in ("cases", "documents", "analyses", "reports")}
    return counts

if __name__ == "__main__":
    import sys
    print(migrate(Path(sys.argv[1])))
