"""Original files live in PostgreSQL on hosted deployments, on disk locally."""
from pathlib import Path
from . import db
from .config import settings

def read(document):
    if document["path"].startswith("postgres:"):
        records = db.rows("SELECT content FROM document_files WHERE document_id=:id", id=document["id"])
        if not records:
            raise FileNotFoundError("Original document is missing")
        return bytes(records[0]["content"])
    return Path(document["path"]).read_bytes()

def remove(document):
    if not document["path"].startswith("postgres:"):
        Path(document["path"]).unlink(missing_ok=True)

def response(data, media_type, filename):
    from fastapi import HTTPException
    from fastapi.responses import Response
    from urllib.parse import quote
    if settings().job_backend == "postgres" and len(data) > 4_000_000:
        raise HTTPException(413, "This download exceeds the hosted response limit. Download originals separately or use a smaller case.")
    return Response(data, media_type=media_type,
                    headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename), "Cache-Control": "no-store"})
