from io import BytesIO
from pathlib import Path
from .config import settings

def extract(data: bytes, filename: str) -> tuple[list[dict], str]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".txt":
        text = data.decode("utf-8")
        pages = [{"page": i + 1, "text": part, "method": "native", "readable": bool(part.strip())}
                 for i, part in enumerate(text.split("\f"))]
        if len(pages) > settings().max_pages:
            raise ValueError("Document exceeds page budget")
        return pages, "extracted" if all(p["readable"] for p in pages) else "unreadable"
    if suffix != ".pdf":
        raise ValueError("Only PDF and UTF-8 text documents are supported")
    import pymupdf
    import pytesseract
    from PIL import Image
    pages = []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        if document.needs_pass:
            raise ValueError("Supply an unlocked PDF")
        if len(document) > settings().max_pages:
            raise ValueError("Document exceeds page budget")
        for index, page in enumerate(document):
            content = page.get_text()
            method = "native"
            if len(content.strip()) < 30:
                method = "ocr"
                try:
                    pixels = page.get_pixmap(dpi=150)
                    content = pytesseract.image_to_string(Image.open(BytesIO(pixels.tobytes("png"))), timeout=20)
                except (RuntimeError, pytesseract.TesseractNotFoundError):
                    content = ""
            pages.append({"page": index + 1, "text": content, "method": method, "readable": bool(content.strip())})
    status = "extracted" if pages and all(p["readable"] for p in pages) else "unreadable"
    return pages, status
