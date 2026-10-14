"""Page text from uploads.

A text layer is copied exactly. Pages and pictures without one are read by the
model, with Tesseract as the local fallback, and are marked so the reader can compare them
with the original.
"""
import contextvars
import posixpath
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree
from .config import settings
from .errors import ModelPaused
from .observability import traced

READERS = 4
RENDER_DPI = 150
MAX_SIDE = 2400
MIN_PICTURE_AREA = 10_000
# Word files without layout marks are cut into page-sized parts so one page never fills the context budget.
LONG_PAGE_CHARS = 6000
PAGE_CHARS = 3000
BLANK = "BLANK"
SKIPPED = {"Fallback", "del", "moveFrom", "pPr", "rPr", "tblPr", "tblPrEx", "tblGrid", "trPr", "tcPr", "sectPr"}

def luna_reader():
    """The selected model's page reader, or None when inference is unavailable."""
    from .model import LunaModel
    model = LunaModel()
    return model.transcribe if model.available() else None

def _ocr(image: bytes) -> str:
    import pytesseract
    from PIL import Image
    try:
        return pytesseract.image_to_string(Image.open(BytesIO(image)), timeout=20).strip()
    except (RuntimeError, OSError, pytesseract.TesseractNotFoundError):
        return ""

def _read_images(images: list[bytes], reader) -> list[tuple[str, str, bool]]:
    """Text, reading method and blankness of each image, in order."""
    if not images:
        return []
    read = reader() if reader else None
    deadline = time.monotonic() + settings().job_timeout_seconds

    def one(image):
        if read and time.monotonic() < deadline:
            try:
                text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", read(image).strip()).strip()
                if text == BLANK:
                    return "", "luna", True
                if text:
                    return text, "luna", False
            except (ModelPaused, ValueError):
                pass
        return _ocr(image), "ocr", False

    with ThreadPoolExecutor(max_workers=READERS) as pool:
        # Each read keeps the caller's trace context, so its model call is recorded under this extraction.
        pending = [pool.submit(contextvars.copy_context().run, one, image) for image in images]
        return [item.result() for item in pending]

def _page(number: int, text: str, method: str, blank=False) -> dict:
    page = {"page": number, "text": text, "method": method, "readable": blank or bool(text.strip())}
    return {**page, "blank": True} if blank else page

def _text(data: bytes) -> list[dict]:
    return [_page(index + 1, part, "native") for index, part in enumerate(data.decode("utf-8").split("\f"))]

def _pdf(data: bytes, reader) -> list[dict]:
    import pymupdf
    pages, scans = [], []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        if document.needs_pass:
            raise ValueError("Supply an unlocked PDF")
        if len(document) > settings().max_pages:
            raise ValueError("Document exceeds page budget")
        for index, page in enumerate(document):
            content = page.get_text()
            if len(content.strip()) >= 30:
                pages.append(_page(index + 1, content, "native"))
            elif not page.get_images() and not page.get_drawings():
                # Nothing was drawn besides the short text layer: a near-empty page, not a scan.
                pages.append(_page(index + 1, content, "native", blank=not content.strip()))
            else:
                zoom = min(RENDER_DPI / 72, MAX_SIDE / max(page.rect.width, page.rect.height))
                scans.append(page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).tobytes("jpeg", jpg_quality=85))
                pages.append(None)
    results = iter(_read_images(scans, reader))
    return [page or _page(index + 1, *next(results)) for index, page in enumerate(pages)]

def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]

def _xml(archive: zipfile.ZipFile, name: str):
    if archive.getinfo(name).file_size > settings().max_upload_bytes:
        raise ValueError("Upload exceeds size limit")
    data = archive.read(name)
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("This Word file contains markup that is not accepted")
    return ElementTree.fromstring(data)

def _relationships(archive: zipfile.ZipFile, part: str) -> list[tuple[str, str, str]]:
    """Relationship ID, type and package path for each internal target of a part."""
    folder, name = posixpath.split(part)
    path = posixpath.join(folder, "_rels", name + ".rels")
    if path not in archive.namelist():
        return []
    return [(item.get("Id", ""), item.get("Type", "").rsplit("/", 1)[-1],
             posixpath.normpath(posixpath.join(folder, item.get("Target", ""))).lstrip("/"))
            for item in _xml(archive, path) if item.get("TargetMode") != "External"]

class _WordText:
    """Body text in reading order, with a page started wherever Word last laid one out or a break is explicit."""
    def __init__(self, pictures=None):
        self.pages = [[]]
        self.pictures = pictures

    def new_page(self):
        if any(part if isinstance(part, tuple) else part.strip() for part in self.pages[-1]):
            self.pages.append([])

    def walk(self, node, paragraph_end="\n"):
        for child in node:
            name = _local(child.tag)
            if name in SKIPPED:
                continue
            if name == "t":
                self.pages[-1].append(child.text or "")
            elif name in {"tab", "ptab"}:
                self.pages[-1].append("\t")
            elif name in {"br", "cr"}:
                if any(_local(key) == "type" and value == "page" for key, value in child.attrib.items()):
                    self.new_page()
                else:
                    self.pages[-1].append("\n")
            elif name == "lastRenderedPageBreak":
                self.new_page()
            elif name == "noBreakHyphen":
                self.pages[-1].append("-")
            elif name in {"blip", "imagedata"}:
                target = self.pictures and next((self.pictures.get(value) for key, value in child.attrib.items()
                                                 if _local(key) in {"embed", "id"} and "relationships" in key), None)
                if target:
                    self.pages[-1].append((target,))
            elif name == "tc":
                # One table row per line, so a quoted row reads the way it does on the page.
                self.walk(child, " ")
                self.pages[-1].append("\t")
            elif name == "tr":
                self.walk(child, paragraph_end)
                self.pages[-1].append("\n")
            elif name == "p":
                self.walk(child, paragraph_end)
                self.pages[-1].append(paragraph_end)
            else:
                self.walk(child, paragraph_end)

def _tidy(text: str) -> str:
    text = re.sub(r" *\t *", "\t", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()

def _picture(data: bytes) -> bytes | None:
    """A picture as a bounded JPEG for the reader; icons and undecodable formats are left out."""
    from PIL import Image
    try:
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height < MIN_PICTURE_AREA:
                return None
            image = image.convert("RGB")
            image.thumbnail((MAX_SIDE, MAX_SIDE))
            buffer = BytesIO()
            image.save(buffer, "JPEG", quality=85)
            return buffer.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError):
        return None

def _split(text: str) -> list[str]:
    if len(text) <= LONG_PAGE_CHARS:
        return [text]
    parts, current = [], ""
    for line in text.split("\n"):
        if current and len(current) + len(line) > PAGE_CHARS:
            parts.append(current.strip())
            current = ""
        current += line + "\n"
    return [part for part in parts + [current.strip()] if part]

def _docx(data: bytes, reader) -> list[dict]:
    with zipfile.ZipFile(BytesIO(data)) as archive:
        main = next((target for _, kind, target in _relationships(archive, "") if kind == "officeDocument"), "word/document.xml")
        related = _relationships(archive, main)
        names = set(archive.namelist())
        body = _WordText({key: target for key, kind, target in related if kind == "image" and target in names})
        body.walk(_xml(archive, main))
        # Letterhead and footer text repeat on every page; they are kept once, on the first.
        edges = {"header": [], "footer": []}
        for _, kind, target in related:
            if kind in edges and target in names:
                part = _WordText()
                part.walk(_xml(archive, target))
                text = _tidy("".join(item for page in part.pages for item in page))
                if text and text not in edges[kind]:
                    edges[kind].append(text)
        targets = dict.fromkeys(item[0] for page in body.pages for item in page if isinstance(item, tuple))
        pictures = {target: _picture(archive.read(target)) for target in targets
                    if archive.getinfo(target).file_size <= settings().max_upload_bytes}
    wanted = [target for target, picture in pictures.items() if picture]
    if len(wanted) > settings().max_pages:
        raise ValueError("This Word file has too many pictures to read; split it into smaller documents")
    read = dict(zip(wanted, _read_images([pictures[target] for target in wanted], reader)))
    pages = []
    for index, parts in enumerate(body.pages):
        methods, unread, text = set(), 0, ""
        for part in parts:
            if not isinstance(part, tuple):
                text += part
            elif part[0] in read:
                words, method, blank = read[part[0]]
                if words:
                    methods.add(method)
                    text += "\n" + words + "\n"
                elif not blank:
                    unread += 1
        if index == 0:
            text = "\n".join(edges["header"] + [text] + edges["footer"])
        method = "luna" if "luna" in methods else "ocr" if methods else "native"
        for chunk in _split(_tidy(text)):
            pages.append(_page(len(pages) + 1, chunk, method))
            if unread:
                # A picture nobody could read may hold the point of the page; the count travels with it.
                pages[-1]["unread_images"], unread = unread, 0
    if len(pages) > settings().max_pages:
        raise ValueError("Document exceeds page budget")
    return pages

@traced("claim.extraction")
def extract(data: bytes, filename: str, reader=luna_reader) -> tuple[list[dict], str]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".txt":
        pages = _text(data)
        if len(pages) > settings().max_pages:
            raise ValueError("Document exceeds page budget")
    elif suffix == ".pdf":
        pages = _pdf(data, reader)
    elif suffix == ".docx":
        try:
            pages = _docx(data, reader)
        except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as error:
            raise ValueError("This Word file could not be opened; save it again as .docx or PDF") from error
    elif suffix == ".doc":
        raise ValueError("Older .doc files are not supported; save the document as .docx or PDF")
    else:
        raise ValueError("Only PDF, Word (.docx) and UTF-8 text documents are supported")
    return pages, "extracted" if pages and all(p["readable"] for p in pages) else "unreadable"
