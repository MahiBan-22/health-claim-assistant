"""Deterministic intake helpers: category suggestion, dated timeline and sample scenarios.

These are conveniences for the customer workspace. They never decide a finding.
"""
import json
import re
from datetime import date
from pathlib import Path

KINDS = ("insurer_communication", "clinical", "bill", "receipt", "policy", "schedule", "endorsement", "other")

_TEXT_HINTS = {
    "insurer_communication": [("please supply", 3), ("please provide", 3), ("please submit", 3), ("we request", 2), ("communication date", 3),
                              ("claim is rejected", 4), ("repudiat", 4), ("settlement advice", 4), ("deduction", 2), ("we regret", 3),
                              ("claims department", 2), ("dear policyholder", 3), ("dear customer", 3), ("reason for", 1)],
    "receipt": [("acknowledg", 3), ("received at", 3), ("receipt status", 4), ("submission event", 4), ("acknowledgement number", 4)],
    "bill": [("invoice number", 4), ("itemized charges", 4), ("itemised charges", 4), ("total billed", 4), ("room charges", 2), ("invoice date", 3)],
    "clinical": [("discharge summary", 4), ("recorded diagnosis", 3), ("laboratory", 2), ("admission date", 3), ("report number", 2),
                 ("consultation", 2), ("prescription", 2), ("recorded result", 3), ("clinical note", 3)],
    "policy": [("policy wording", 5), ("exclusions", 2), ("waiting period", 2), ("definitions", 2), ("clause", 1), ("terms and conditions", 3)],
    "schedule": [("policy schedule", 6), ("sum insured", 3), ("policy period", 3), ("premium", 1)],
    "endorsement": [("endorsement number", 6), ("endorsement", 3), ("this endorsement", 4)],
}
_NAME_HINTS = {
    "insurer_communication": ("query", "letter", "rejection", "settlement", "insurer", "communication", "repudiation"),
    "receipt": ("ack", "receipt"),
    "bill": ("bill", "invoice"),
    "clinical": ("summary", "discharge", "lab", "prescription", "clinical", "consult"),
    "policy": ("wording", "policy"),
    "schedule": ("schedule",),
    "endorsement": ("endorsement",),
}

def classify(filename: str, pages: list[dict]) -> str:
    """Suggest a category from wording. The customer can correct it in the evidence grid."""
    text = " ".join(page["text"] for page in pages)[:6000].lower()
    heading = text[:500]
    name = filename.lower()
    scores = {}
    for kind, hints in _TEXT_HINTS.items():
        scores[kind] = sum(weight * (2 if hint in heading else 1) for hint, weight in hints if hint in text)
    for kind, hints in _NAME_HINTS.items():
        scores[kind] += 5 * sum(hint in name for hint in hints)
    best = max(scores, key=scores.get)
    return best if scores[best] >= 3 else "other"

_MONTHS = {name: index + 1 for index, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
_MONTH = "(" + "|".join(list(_MONTHS) + [name[:3] for name in _MONTHS if len(name) > 3]) + r")[a-z]*\.?"
_DATES = [
    (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+" + _MONTH + r",?\s+(\d{4})\b", re.I), lambda m: (m[3], m[2], m[1])),
    (re.compile(r"\b" + _MONTH + r"\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", re.I), lambda m: (m[3], m[1], m[2])),
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), lambda m: (m[1], m[2], m[3])),
    # Numeric dates are read day-first; the source line stays visible so the customer can check.
    (re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b"), lambda m: (m[3], m[2], m[1])),
]

def _parse(year, month, day):
    try:
        number = _MONTHS.get(month.lower()) or next((v for k, v in _MONTHS.items() if k.startswith(month.lower()[:3])), None) if not month.isdigit() else int(month)
        return date(int(year), number, int(day)).isoformat()
    except (TypeError, ValueError):
        return None

def timeline(documents: list[dict], limit=200) -> list[dict]:
    """Dated lines found in the newest version of each document, oldest first."""
    latest = {}
    for document in documents:
        if document["logical_id"] not in latest or latest[document["logical_id"]]["version"] < document["version"]:
            latest[document["logical_id"]] = document
    events, seen = [], set()
    for document in latest.values():
        for page in document["pages"]:
            for line in page["text"].splitlines():
                label = line.strip()
                if not label or label.upper().startswith("SYNTHETIC"):
                    continue
                for pattern, parts in _DATES:
                    for match in pattern.finditer(label):
                        when = _parse(*parts(match))
                        key = (when, document["id"], label)
                        if when and key not in seen:
                            seen.add(key)
                            events.append({"date": when, "label": label[:220], "document_id": document["id"],
                                           "filename": document["filename"], "kind": document["kind"],
                                           "version": document["version"], "page": page["page"]})
    return sorted(events, key=lambda item: (item["date"], item["filename"]))[:limit]

def scenarios(fixtures: Path) -> list[dict]:
    """Synthetic walkthrough cases shipped with the repository; absent in images without fixtures."""
    result = []
    root = fixtures / "scenarios"
    if not root.is_dir():
        return result
    for manifest in sorted(root.glob("*/scenario.json")):
        try:
            item = json.loads(manifest.read_text(encoding="utf-8"))
            item["key"] = manifest.parent.name
            item["directory"] = manifest.parent
            if all((manifest.parent / d["file"]).is_file() for d in item["documents"] + item.get("follow_up", {}).get("documents", [])):
                result.append(item)
        except (ValueError, KeyError, OSError):
            continue
    return sorted(result, key=lambda item: item.get("order", 99))

def public_scenario(item: dict) -> dict:
    return {key: item[key] for key in ("key", "title", "claim_reference", "scenario", "summary", "what_to_expect", "accent") if key in item} | {
        "document_count": len(item["documents"]), "has_follow_up": bool(item.get("follow_up")),
        "follow_up": item.get("follow_up", {}).get("description")}
